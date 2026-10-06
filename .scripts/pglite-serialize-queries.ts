/**
 * Keeps each connection's extended-query batches together on a PGlite socket
 * server. Test/dev only — never used against a real Postgres.
 *
 * Why: `@electric-sql/pglite-socket` multiplexes all client connections onto
 * PGlite's single session and queues individual protocol *messages*, not whole
 * queries. It only keeps one connection's messages together while PGlite is
 * inside a transaction. postgres-js sends every query as
 * Parse/Bind/Describe/Execute/Sync, so with a pool > 1 two connections querying
 * in parallel (e.g. `Promise.all` of two selects) interleave: the second Parse
 * replaces the first's unnamed statement and a query receives the other
 * query's rows. A pool of 1 is no fix either — code that queries outside an
 * open transaction then deadlocks.
 *
 * The fix: once a connection sends an extended-query message, only that
 * connection's messages are processed until its Sync (or any other
 * non-extended-query message), exactly like the queue already does for open
 * transactions.
 *
 * This replaces internals of pglite-socket's QueryQueueManager (verified
 * against @electric-sql/pglite-socket 0.2.2). `assertQueueInternals` fails
 * loudly if a library upgrade removes them, so the fix can't silently vanish.
 *
 * Usage: call right after `new PGLiteSocketServer(...)`, before `start()`.
 */
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";

// Parse, Bind, Describe, Execute, Close, Flush — everything up to the Sync
// ("S") that ends an extended-query batch.
const EXTENDED_QUERY_MESSAGES = new Set(["P", "B", "D", "E", "C", "H"]);

type QueueItem = {
  handlerId: number;
  message: Uint8Array;
  onData: (data: Uint8Array) => void;
  resolve: (bytes: number) => void;
  reject: (error: unknown) => void;
};

const assertQueueInternals = (queue: any) => {
  const missing: string[] = [];
  if (!queue) missing.push("server.queryQueue");
  else {
    if (!Array.isArray(queue.queue)) missing.push("queryQueue.queue");
    if (typeof queue.processing !== "boolean")
      missing.push("queryQueue.processing");
    if (!("lastHandlerId" in queue)) missing.push("queryQueue.lastHandlerId");
    if (typeof queue.processQueue !== "function")
      missing.push("queryQueue.processQueue()");
    if (typeof queue.clearQueueForHandler !== "function")
      missing.push("queryQueue.clearQueueForHandler()");
    for (const fn of ["isInTransaction", "runExclusive", "execProtocolRawStream"]) {
      if (typeof queue.db?.[fn] !== "function") missing.push(`db.${fn}()`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[pglite-serialize-queries] @electric-sql/pglite-socket internals changed ` +
        `(missing: ${missing.join(", ")}). The extended-query serialization in ` +
        `.scripts/pglite-serialize-queries.ts must be updated for this version — ` +
        `without it, parallel queries over a pool > 1 receive each other's rows.`
    );
  }
};

export const serializeExtendedQueries = (socketServer: PGLiteSocketServer) => {
  const queue = (socketServer as any).queryQueue;
  assertQueueInternals(queue);

  let batchHandlerId: number | null = null;

  queue.processQueue = async function () {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const ownerId: number | null =
          batchHandlerId ??
          (this.db.isInTransaction() ? this.lastHandlerId : null);
        let item: QueueItem;
        if (ownerId !== null) {
          const index = this.queue.findIndex(
            (q: QueueItem) => q.handlerId === ownerId
          );
          // The owner's next message is not queued yet; its enqueue()
          // restarts processing.
          if (index === -1) break;
          item = this.queue.splice(index, 1)[0];
        } else {
          item = this.queue.shift();
        }

        const type = String.fromCharCode(item.message[0] ?? 0);
        batchHandlerId = EXTENDED_QUERY_MESSAGES.has(type)
          ? item.handlerId
          : null;

        let bytes = 0;
        try {
          await this.db.runExclusive(() =>
            this.db.execProtocolRawStream(item.message, {
              onRawData: (data: Uint8Array) => {
                bytes += data.length;
                item.onData(data);
              },
            })
          );
        } catch (error) {
          batchHandlerId = null;
          item.reject(error);
          return;
        }
        this.lastHandlerId = item.handlerId;
        item.resolve(bytes);
      }
    } finally {
      this.processing = false;
    }
  };

  // A connection that goes away mid-batch must not block the others.
  const clearQueueForHandler = queue.clearQueueForHandler.bind(queue);
  queue.clearQueueForHandler = (handlerId: number) => {
    clearQueueForHandler(handlerId);
    if (batchHandlerId === handlerId) {
      batchHandlerId = null;
      void queue.processQueue();
    }
  };
};
