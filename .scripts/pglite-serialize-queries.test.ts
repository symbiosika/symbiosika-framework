import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { serializeExtendedQueries } from "./pglite-serialize-queries";

describe("serializeExtendedQueries", () => {
  test("throws a clear error when pglite-socket internals are missing", () => {
    expect(() =>
      serializeExtendedQueries({ queryQueue: { queue: [] } } as any)
    ).toThrow(/pglite-socket internals changed/);
    expect(() => serializeExtendedQueries({} as any)).toThrow(
      /server\.queryQueue/
    );
  });

  test("parallel queries over a pool each get their own rows", async () => {
    const db = await PGlite.create();
    const port = 5600 + Math.floor(Math.random() * 300);
    const server = new PGLiteSocketServer({
      db,
      port,
      host: "127.0.0.1",
      maxConnections: 10,
    });
    serializeExtendedQueries(server);
    await server.start();
    const sql = postgres({
      host: "127.0.0.1",
      port,
      user: "postgres",
      database: "postgres",
      max: 5,
      onnotice: () => {},
    });
    try {
      for (let i = 0; i < 20; i++) {
        const results = await Promise.all(
          [0, 1, 2, 3, 4].map((k) =>
            k % 2
              ? sql`SELECT ${`q${i}-${k}`}::text AS x`
              : sql`SELECT ${`q${i}-${k}`}::text AS x, ${k}::int AS k`
          )
        );
        results.forEach((rows, k) => expect(rows[0]?.x).toBe(`q${i}-${k}`));
      }
      // A transaction on one connection still works alongside other queries.
      const [inTx, outside] = await Promise.all([
        sql.begin(async (tx) => {
          await tx`CREATE TEMP TABLE tmp_t (v int)`;
          await tx`INSERT INTO tmp_t VALUES (1), (2)`;
          return tx`SELECT count(*)::int AS n FROM tmp_t`;
        }),
        sql`SELECT 42::int AS n`,
      ]);
      expect(inTx[0]?.n).toBe(2);
      expect(outside[0]?.n).toBe(42);
    } finally {
      await sql.end({ timeout: 1 });
      await server.stop();
      await db.close();
    }
  }, 30000);
});
