/**
 * @framework/middlewares — Hono middlewares & route guards.
 *
 * Everything you attach to a route to authenticate the caller, restrict by
 * scope, or assert tenant membership. `HTTPException` is re-exported here too
 * since route handlers throw it right alongside these guards.
 *
 * Part of the curated framework public API. See ./README.md.
 */
export {
  authAndSetUsersInfo,
  authOrRedirectToLogin,
  authAndSetUsersInfoOrRedirectToLogin,
  checkUserPermission,
  checkToken,
  addScopesToContext,
} from "../lib/utils/hono-middlewares";
export { validateScope } from "../lib/utils/validate-scope";
export {
  isTenantMember,
  isTenantAdmin,
  checkTenantIdInBody,
} from "../routes/tenant";
export { HTTPException } from "hono/http-exception";
