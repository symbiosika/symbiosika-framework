/**
 * Hold requests back from the Hono app until its routes are all registered.
 *
 * `defineServer()` returns the server's `fetch` right away and Bun starts
 * accepting connections, but most routes are registered later, once the
 * database is reachable and the license is checked. Hono's default
 * SmartRouter builds its matcher on the first request it routes and refuses
 * every route added afterwards:
 *
 *   Error: Can not add a route since the matcher is already built.
 *
 * A single request in that window (a load balancer probe, a browser tab that
 * reconnects after a deploy) therefore made the deferred registration throw
 * and killed the process.
 *
 * The gate keeps such requests away from the app until initialization has
 * settled. Meanwhile:
 *
 * - `GET /health` (the public liveness probe) answers `{ status: "ok" }`
 *   from here, so container health checks pass during startup without
 *   touching the app's router.
 * - Every other request is answered `503` with a `Retry-After` header and
 *   `{ success: false, error: "starting" }`.
 *
 * The gate opens when the initialization promise settles — fulfilled or
 * rejected. A failed initialization is reported by its owner; the gate then
 * serves whatever routes were registered, the same as a server whose license
 * check failed.
 */

export const STARTUP_RETRY_AFTER_SECONDS = 5;

const LIVENESS_PATH = "/health";

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
};

const startingResponse = (request: Request): Response => {
  if (request.method === "GET" && pathOf(request.url) === LIVENESS_PATH) {
    return Response.json({ status: "ok" });
  }
  return Response.json(
    { success: false, error: "starting" },
    {
      status: 503,
      headers: { "Retry-After": String(STARTUP_RETRY_AFTER_SECONDS) },
    }
  );
};

export type StartupGatedHandler<Rest extends unknown[]> = ((
  request: Request,
  ...rest: Rest
) => Response | Promise<Response>) & {
  /** True once initialization has settled and requests reach the app. */
  isOpen: () => boolean;
};

/**
 * Put the gate in front of a server's request handler.
 *
 * `initialization` is the promise that registers the remaining routes; the
 * handler is not called before it settles.
 */
export const withStartupGate = <Rest extends unknown[]>(
  handler: (request: Request, ...rest: Rest) => Response | Promise<Response>,
  initialization: Promise<unknown>
): StartupGatedHandler<Rest> => {
  let open = false;
  const markOpen = () => {
    open = true;
  };
  initialization.then(markOpen, markOpen);

  const gated = (request: Request, ...rest: Rest) =>
    open ? handler(request, ...rest) : startingResponse(request);

  return Object.assign(gated, { isOpen: () => open });
};
