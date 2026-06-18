/**
 * @framework/tenants — tenant & membership management (user-management domain).
 *
 * CRUD and membership helpers for the multi-tenant model, plus the small slice
 * of user state (`setUsersLastTenant`) that tenant flows touch.
 *
 * Part of the curated framework public API. See ./README.md.
 */
export {
  createTenant,
  getTenant,
  deleteTenant,
  addTenantMember,
  getTenantMembers,
  getTenantMemberRole,
} from "../lib/usermanagement/tenants";
export { setUsersLastTenant } from "../lib/usermanagement/user";
