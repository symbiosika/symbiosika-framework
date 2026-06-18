/**
 * @framework/testing — test harness for app-level tests.
 *
 * `initTests()` boots the DB + seeds the standard test tenants/users;
 * `testFetcher` issues authenticated requests against a Hono app. The `TEST_*`
 * fixtures (organisations, users, passwords) are exposed too.
 *
 * Test-only surface — do not import from production code.
 *
 * Part of the curated framework public API. See ./README.md.
 */
export * from "../test/init.test";
export * from "../test/fetcher.test";
