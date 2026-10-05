import { afterAll, describe, expect, it } from "bun:test";
import { defineServer } from "./index";

/**
 * Boots the real server and hits it from the first moment on — the way load
 * balancers and reconnecting browsers do right after a deploy. Requests in
 * the init window used to build Hono's router before the deferred routes were
 * registered, which then threw "Can not add a route since the matcher is
 * already built." and killed the process.
 */
describe("defineServer startup", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  afterAll(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  it("serves requests during initialization and every route afterwards", async () => {
    const server = defineServer({
      port: 0,
      appName: "Startup Test",
      basePath: "/api/v1",
      baseUrl: "http://localhost",
      authType: "local",
      jwtExpiresAfter: 60 * 60,
      disableJobQueue: true,
      customHonoApps: [
        {
          baseRoute: "/startup-probe",
          app: (app) => {
            app.get("/hello", (c) => c.json({ hello: "world" }));
          },
        },
      ],
    });
    const request = (path: string) =>
      server.fetch(new Request(`http://localhost${path}`));

    // In the init window: liveness answers, everything else is "starting"
    const health = await request("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const early = await request("/api/v1/startup-probe/hello");
    expect(early.status).toBe(503);
    expect(await early.json()).toEqual({ success: false, error: "starting" });

    // Keep hitting it until initialization is through
    const deadline = Date.now() + 15_000;
    let probe = early;
    while (probe.status === 503 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await request("/health");
      probe = await request("/api/v1/startup-probe/hello");
    }

    // Afterwards the deferred routes are registered and reachable
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({ hello: "world" });
    expect((await request("/api/v1/ping")).status).not.toBe(503);
    // OpenAPI docs: a deferred framework route behind login
    expect((await request("/api/v1/docs/openapi")).status).toBe(401);
    expect((await request("/api/v1/does-not-exist-route-xyz")).status).toBe(
      404
    );

    expect(unhandled).toEqual([]);
  }, 30_000);
});
