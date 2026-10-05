import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { STARTUP_RETRY_AFTER_SECONDS, withStartupGate } from "./startup-gate";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/**
 * An app shaped like the one `defineServer()` builds: some routes up front,
 * the rest registered once initialization has run.
 */
const appWithDeferredRoutes = () => {
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok", from: "app" }));
  app.get("/api/v1/ping", (c) => c.text("pong"));
  const registerLateRoutes = () => {
    app.get("/api/v1/admin/stats", (c) => c.json({ admins: 1 }));
    app.post("/api/v1/user/login", (c) => c.json({ ok: true }));
  };
  return { app, registerLateRoutes };
};

describe("Hono router (the failure the gate prevents)", () => {
  it("refuses routes added after it has served a request", async () => {
    const { app, registerLateRoutes } = appWithDeferredRoutes();
    await app.fetch(new Request("http://x/health"));
    expect(registerLateRoutes).toThrow(
      "Can not add a route since the matcher is already built."
    );
  });
});

describe("withStartupGate", () => {
  it("keeps requests in the init window away from the router", async () => {
    const { app, registerLateRoutes } = appWithDeferredRoutes();
    const init = deferred();
    const initialization = init.promise.then(registerLateRoutes);
    const fetch = withStartupGate(app.fetch, initialization);

    // A burst of requests while the server is still starting
    const early = await Promise.all([
      fetch(new Request("http://x/health")),
      fetch(new Request("http://x/api/v1/ping")),
      fetch(new Request("http://x/api/v1/admin/stats")),
      fetch(new Request("http://x/api/v1/user/login", { method: "POST" })),
    ]);
    expect(fetch.isOpen()).toBe(false);

    const [health, ...others] = early;
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    for (const res of others) {
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe(
        String(STARTUP_RETRY_AFTER_SECONDS)
      );
      expect(await res.json()).toEqual({ success: false, error: "starting" });
    }

    // Deferred registration runs after the early requests without throwing
    init.resolve();
    await initialization;
    expect(fetch.isOpen()).toBe(true);

    const health2 = await fetch(new Request("http://x/health"));
    expect(await health2.json()).toEqual({ status: "ok", from: "app" });
    expect(await (await fetch(new Request("http://x/api/v1/ping"))).text()).toBe(
      "pong"
    );
    expect(
      await (await fetch(new Request("http://x/api/v1/admin/stats"))).json()
    ).toEqual({ admins: 1 });
    const login = await fetch(
      new Request("http://x/api/v1/user/login", { method: "POST" })
    );
    expect(login.status).toBe(200);
  });

  it("answers only GET /health from the gate", async () => {
    const { app } = appWithDeferredRoutes();
    const fetch = withStartupGate(app.fetch, new Promise(() => {}));

    expect(
      (await fetch(new Request("http://x/health", { method: "POST" }))).status
    ).toBe(503);
    expect((await fetch(new Request("http://x/health/detail"))).status).toBe(
      503
    );
    expect((await fetch(new Request("http://x/health?probe=1"))).status).toBe(
      200
    );
  });

  it("opens when initialization fails, serving the routes registered so far", async () => {
    const { app } = appWithDeferredRoutes();
    const initialization = Promise.reject(new Error("license lookup failed"));
    initialization.catch(() => {});
    const fetch = withStartupGate(app.fetch, initialization);

    await initialization.catch(() => {});
    expect(fetch.isOpen()).toBe(true);
    expect((await fetch(new Request("http://x/api/v1/ping"))).status).toBe(200);
    expect(
      (await fetch(new Request("http://x/api/v1/admin/stats"))).status
    ).toBe(404);
  });
});
