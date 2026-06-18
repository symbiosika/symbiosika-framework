/**
 * @framework/schema — framework database tables (the `base_*` tables) and their
 * drizzle-valibot insert/select schemas.
 *
 * Re-exports the framework schema barrel, so app code can pull `users`,
 * `tenants`, `tenantMembers`, `connections`, `files`, `knowledgeGroup`,
 * `knowledgeEntry`, etc. from a single stable path instead of reaching into
 * `lib/db/schema/*`.
 *
 * Part of the curated framework public API. See ./README.md.
 */
export * from "../lib/db/db-schema";
