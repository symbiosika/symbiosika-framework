/**
 * @framework/auth — authentication primitives (password hashing, JWT issuance,
 * local-auth helpers).
 *
 * For route guards (auth middleware, scope/permission checks) use
 * `@framework/middlewares` instead.
 *
 * Part of the curated framework public API. See ./README.md.
 */
export {
  saltAndHashPassword,
  generateJwt,
  generateUserSessionJwt,
  createJwtSessionForUserId,
  checkGeneralInvitationCode,
  LocalAuth,
} from "../lib/auth";
