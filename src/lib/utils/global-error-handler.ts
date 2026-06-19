import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import log from "../log";

/**
 * Central error boundary for all Hono apps started via defineServer().
 * - HTTPException → passed through with its intended status + message
 *   (preserves deliberate 400/401/403/404 thrown by handlers).
 * - Everything else → logged with request context + stack, returned as a
 *   clean 500. The raw message is only exposed in the body when
 *   API_DETAIL_ERROR_MESSAGES=true.
 *
 * This makes the per-handler try/catch wrappers in the app backends obsolete.
 */
export const globalErrorHandler = (err: Error, c: Context) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  const method = c.req.method;
  const path = c.req.path;
  // c.get(...) is safe even before the auth middleware ran (returns undefined)
  const usersId = c.get("usersId");
  const tenantId = c.req.param("tenantId") ?? c.get("tokenTenantId");
  const sessionId = c.get("sessionId");

  log.error(
    `Unhandled error ${method} ${path} ` +
      `[user=${usersId ?? "-"} tenant=${tenantId ?? "-"} session=${sessionId ?? "-"}]: ` +
      (err?.message ?? "unknown error"),
    err?.stack ?? ""
  );

  const exposeDetail = process.env.API_DETAIL_ERROR_MESSAGES === "true";
  return c.json(
    {
      message: "Internal Server Error",
      ...(exposeDetail ? { detail: err?.message ?? "unknown error" } : {}),
    },
    500
  );
};
