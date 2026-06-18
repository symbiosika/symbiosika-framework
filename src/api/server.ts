/**
 * @framework/server — server bootstrap & core runtime surface.
 *
 * `defineServer()` boots the entire framework. The Hono app type and the
 * request-context variable type live here too, because custom routes are typed
 * against them.
 *
 * Part of the curated framework public API. See ./README.md.
 */
export { defineServer, GLOBAL_SERVER_CONFIG } from "../index";
export { default as log } from "../lib/log";
export { smtpService } from "../lib/email";
export type {
  SymbiosikaFrameworkHonoApp,
  SFContextVariables,
  ServerSpecificConfig,
} from "../types";
