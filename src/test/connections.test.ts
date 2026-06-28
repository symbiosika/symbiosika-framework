/**
 * Connections — leading/following role logic.
 *
 * Self-contained: runs the REAL connection service against an in-process PGlite
 * database (injected via `mock.module`) with the remote server mocked at the
 * `fetch` boundary. No external Postgres and no second server process required.
 *
 * Why no "real" end-to-end self-connection test: a connection models two
 * *separate* databases. Pointed at one database, both the initiating and the
 * accepting rows would live under the same tenant id (ambiguous lookups) and the
 * shadow upsert would overwrite a real tenant's origin. A true two-sided E2E
 * therefore needs two processes with two databases; here we instead verify each
 * side's behaviour in isolation and assert the wire payload exchanged between
 * them, plus an explicit guard that rejects a server connecting to itself.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  mock,
} from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

const client = new PGlite();
const db = drizzle(client);

// Capture the real module so we can restore it after this file's tests.
// `bun test` runs every test file in a single process and `mock.module`
// registrations are global, so without restoring this the PGlite stub would
// leak into every other test file that runs afterwards — they'd then query a
// database that only has the few connection-related tables created below
// (e.g. "relation \"base_invitation_codes\" does not exist").
const realDbConnection = { ...(await import("../lib/db/db-connection")) };

// Inject the in-process DB everywhere the framework reads getDb().
mock.module("../lib/db/db-connection", () => ({
  getDb: () => db,
  createDatabaseClient: () => db,
  waitForDbConnection: async () => {},
}));

const conn = await import("../lib/connections");
const { initServerKeysIfNeeded } = await import(
  "../lib/connections/init-server-keys"
);
const { _GLOBAL_SERVER_CONFIG } = await import("../store");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const SELF_URL = "https://main.example.com";
const REMOTE_URL = "https://remote.example.com";

const CLIENT_TENANT = "11111111-1111-1111-1111-111111111111";
const LEADER_TENANT = "22222222-2222-2222-2222-222222222222";
const LEADER_NAME = "Leader Co";
const SERVER_TENANT = "33333333-3333-3333-3333-333333333333";
const ADMIN_USER = "44444444-4444-4444-4444-444444444444";
const EXTRA_TENANT = "55555555-5555-5555-5555-555555555555";
const CLIENT_REMOTE_ID = "66666666-6666-6666-6666-666666666666";

// ---------------------------------------------------------------------------
// Mocked remote server (fetch boundary)
// ---------------------------------------------------------------------------
let exchangeShouldFail = false;
let capturedExchangeBody: any = null;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.endsWith("/api/v1/user/login")) {
    return jsonResponse({ token: "remote-token" });
  }
  if (url.endsWith("/api/v1/user/tenants")) {
    return jsonResponse([
      { tenantId: LEADER_TENANT, name: LEADER_NAME, role: "owner" },
    ]);
  }
  if (url.includes("/connections/exchange-keys")) {
    capturedExchangeBody = JSON.parse(init.body);
    if (exchangeShouldFail) return jsonResponse({ error: "boom" }, 400);
    return jsonResponse({
      connectionId: "remote-conn",
      localPublicKey: "REMOTE_PUBLIC_KEY",
    });
  }
  throw new Error("Unexpected fetch in test: " + url);
}) as any;

// ---------------------------------------------------------------------------
// Schema + seed (only the tables the connection flow touches)
// ---------------------------------------------------------------------------
async function createSchema() {
  await client.exec(`
    CREATE TYPE "tenant_origin" AS ENUM ('local','remote');
    CREATE TYPE "initiated_by" AS ENUM ('local','remote');
    CREATE TYPE "connection_role" AS ENUM ('leading','following');
    CREATE TYPE "connection_status" AS ENUM ('pending','active','disconnected','revoked');
    CREATE TYPE "tenant_member_role" AS ENUM ('owner','admin','member');

    CREATE TABLE "base_tenants" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "name" varchar(255) NOT NULL,
      "description" text,
      "origin" "tenant_origin" NOT NULL DEFAULT 'local',
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX "tenants_name_local_unique_idx"
      ON "base_tenants" ("name") WHERE "origin" = 'local';

    CREATE TABLE "base_users" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "provider" text NOT NULL DEFAULT 'local',
      "email" text NOT NULL,
      "email_verified" boolean NOT NULL DEFAULT false,
      "firstname" varchar(255) NOT NULL,
      "surname" varchar(255) NOT NULL,
      "ext_user_id" text NOT NULL DEFAULT '',
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now(),
      "last_tenant_id" uuid REFERENCES "base_tenants"("id") ON DELETE SET NULL
    );

    CREATE TABLE "base_tenant_members" (
      "user_id" uuid NOT NULL REFERENCES "base_users"("id") ON DELETE CASCADE,
      "tenant_id" uuid NOT NULL REFERENCES "base_tenants"("id") ON DELETE CASCADE,
      "role" "tenant_member_role" NOT NULL DEFAULT 'member',
      "joined_at" timestamp NOT NULL DEFAULT now(),
      PRIMARY KEY ("user_id","tenant_id")
    );

    CREATE TABLE "base_server_keys" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "private_key" text NOT NULL,
      "public_key" text NOT NULL,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    );

    CREATE TABLE "base_connections" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "tenant_id" uuid NOT NULL REFERENCES "base_tenants"("id") ON DELETE CASCADE,
      "name" varchar(255) NOT NULL,
      "remote_url" text,
      "remote_connection_id" text,
      "remote_public_key" text,
      "remote_tenant_id" uuid,
      "initiated_by" "initiated_by" NOT NULL DEFAULT 'local',
      "role" "connection_role" NOT NULL DEFAULT 'leading',
      "status" "connection_status" NOT NULL DEFAULT 'active',
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now(),
      "last_connected_at" timestamp,
      "meta" jsonb NOT NULL DEFAULT '{}'
    );
    CREATE UNIQUE INDEX "connections_tenant_name_initiated_by_unique_idx"
      ON "base_connections" ("tenant_id","name","initiated_by");
    CREATE UNIQUE INDEX "connections_tenant_rcid_initiated_by_unique_idx"
      ON "base_connections" ("tenant_id","remote_connection_id","initiated_by");
  `);
}

async function resetAndSeed() {
  await client.exec(`
    TRUNCATE "base_connections","base_tenant_members","base_server_keys","base_users","base_tenants" CASCADE;
  `);
  await client.query(
    `INSERT INTO "base_tenants" ("id","name","origin") VALUES
      ($1,'Client Local','local'),
      ($2,'Server Main','local')`,
    [CLIENT_TENANT, SERVER_TENANT]
  );
  await client.query(
    `INSERT INTO "base_users" ("id","email","firstname","surname") VALUES ($1,$2,'Ada','Admin')`,
    [ADMIN_USER, "admin@example.com"]
  );
  await client.query(
    `INSERT INTO "base_tenant_members" ("user_id","tenant_id","role") VALUES ($1,$2,'admin')`,
    [ADMIN_USER, CLIENT_TENANT]
  );
  await initServerKeysIfNeeded();
  exchangeShouldFail = false;
  capturedExchangeBody = null;
}

const tenantById = async (id: string) =>
  (await client.query(`SELECT * FROM "base_tenants" WHERE id = $1`, [id]))
    .rows[0] as any;
const connectionsRows = async () =>
  (await client.query(`SELECT * FROM "base_connections"`)).rows as any[];
const memberRole = async (userId: string, tenantId: string) =>
  ((
    await client.query(
      `SELECT role FROM "base_tenant_members" WHERE user_id=$1 AND tenant_id=$2`,
      [userId, tenantId]
    )
  ).rows[0] as any)?.role;
const userLastTenant = async (userId: string) =>
  ((await client.query(`SELECT last_tenant_id FROM "base_users" WHERE id=$1`, [userId]))
    .rows[0] as any)?.last_tenant_id;

beforeAll(async () => {
  _GLOBAL_SERVER_CONFIG.baseUrl = SELF_URL;
  await createSchema();
});
beforeEach(resetAndSeed);
afterAll(() => {
  globalThis.fetch = originalFetch;
  // Restore the real DB module so the mock does not leak into other test files.
  mock.module("../lib/db/db-connection", () => realDbConnection);
});

// ---------------------------------------------------------------------------
// acceptConnection (the receiving side)
// ---------------------------------------------------------------------------
describe("acceptConnection", () => {
  it("leading: does NOT create a shadow of the connecting client", async () => {
    await conn.connectionsService.acceptConnection(
      SERVER_TENANT,
      REMOTE_URL,
      CLIENT_REMOTE_ID,
      "rconn-leading",
      "CLIENT_PUBKEY",
      "client→server",
      "Client Remote Name",
      "leading"
    );

    // No local tenant was created for the remote client — this is the fix.
    expect(await tenantById(CLIENT_REMOTE_ID)).toBeUndefined();

    const rows = await connectionsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(SERVER_TENANT);
    expect(rows[0].role).toBe("leading");
    expect(rows[0].status).toBe("active");
    expect(rows[0].initiated_by).toBe("remote");
    expect(rows[0].remote_tenant_id).toBe(CLIENT_REMOTE_ID);
    expect(rows[0].remote_public_key).toBe("CLIENT_PUBKEY");
  });

  it("following: DOES mirror the remote leader tenant (origin=remote)", async () => {
    await conn.connectionsService.acceptConnection(
      SERVER_TENANT,
      REMOTE_URL,
      LEADER_TENANT,
      "rconn-following",
      "LEADER_PUBKEY",
      "server follows leader",
      LEADER_NAME,
      "following"
    );

    const shadow = await tenantById(LEADER_TENANT);
    expect(shadow).toBeDefined();
    expect(shadow.origin).toBe("remote");

    const rows = await connectionsRows();
    expect(rows[0].tenant_id).toBe(LEADER_TENANT);
    expect(rows[0].role).toBe("following");
  });
});

// ---------------------------------------------------------------------------
// Tenant name collisions
// ---------------------------------------------------------------------------
describe("tenant name uniqueness", () => {
  it("allows several remote shadows to share a name but rejects a duplicate local name", async () => {
    await client.query(`INSERT INTO "base_tenants" ("name","origin") VALUES ('Acme','local')`);
    // Two different remote leaders both called "Acme" must both be mirrorable.
    await client.query(
      `INSERT INTO "base_tenants" ("id","name","origin") VALUES (gen_random_uuid(),'Acme','remote')`
    );
    await client.query(
      `INSERT INTO "base_tenants" ("id","name","origin") VALUES (gen_random_uuid(),'Acme','remote')`
    );

    let rejected = false;
    try {
      await client.query(`INSERT INTO "base_tenants" ("name","origin") VALUES ('Acme','local')`);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// initializeConnection (the initiating side)
// ---------------------------------------------------------------------------
describe("initializeConnection", () => {
  it("following (default): adopts leader tenant, runs under it, tells peer to lead", async () => {
    const result = await conn.connectionsService.initializeConnection(
      CLIENT_TENANT,
      REMOTE_URL,
      "admin@example.com",
      "pw",
      LEADER_TENANT,
      "edge→main",
      { actingUserId: ADMIN_USER }
    );
    expect(result.status).toBe("active");

    const shadow = await tenantById(LEADER_TENANT);
    expect(shadow.origin).toBe("remote");

    const rows = await connectionsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(LEADER_TENANT);
    expect(rows[0].role).toBe("following");
    expect(rows[0].status).toBe("active");
    expect(rows[0].initiated_by).toBe("local");
    expect(rows[0].remote_tenant_id).toBe(LEADER_TENANT);
    expect(rows[0].remote_public_key).toBe("REMOTE_PUBLIC_KEY");

    // The peer is told to take the opposite (leading) role.
    expect(capturedExchangeBody.role).toBe("leading");

    // The initiating admin keeps a working login on the adopted tenant.
    expect(await memberRole(ADMIN_USER, LEADER_TENANT)).toBe("owner");
    expect(await userLastTenant(ADMIN_USER)).toBe(LEADER_TENANT);
  });

  it("leading: keeps own tenant, no shadow, tells peer to follow", async () => {
    await conn.connectionsService.initializeConnection(
      CLIENT_TENANT,
      REMOTE_URL,
      "admin@example.com",
      "pw",
      LEADER_TENANT,
      "main→edge",
      { role: "leading", actingUserId: ADMIN_USER }
    );

    expect(await tenantById(LEADER_TENANT)).toBeUndefined();
    const rows = await connectionsRows();
    expect(rows[0].tenant_id).toBe(CLIENT_TENANT);
    expect(rows[0].role).toBe("leading");
    expect(rows[0].remote_tenant_id).toBe(LEADER_TENANT);
    expect(capturedExchangeBody.role).toBe("following");
  });

  it("rolls back staged connection AND freshly-created shadow when key exchange fails", async () => {
    exchangeShouldFail = true;
    await expect(
      conn.connectionsService.initializeConnection(
        CLIENT_TENANT,
        REMOTE_URL,
        "admin@example.com",
        "pw",
        LEADER_TENANT,
        "will-fail",
        { actingUserId: ADMIN_USER }
      )
    ).rejects.toThrow();

    expect(await connectionsRows()).toHaveLength(0);
    // Shadow created during this call must be rolled back.
    expect(await tenantById(LEADER_TENANT)).toBeUndefined();
  });

  it("edge mode: replaceLocalTenants collapses to a pure mirror of the leader", async () => {
    await client.query(
      `INSERT INTO "base_tenants" ("id","name","origin") VALUES ($1,'Extra','local')`,
      [EXTRA_TENANT]
    );

    await conn.connectionsService.initializeConnection(
      CLIENT_TENANT,
      REMOTE_URL,
      "admin@example.com",
      "pw",
      LEADER_TENANT,
      "edge-wipe",
      { actingUserId: ADMIN_USER, replaceLocalTenants: true }
    );

    // Only the adopted leader tenant survives.
    expect(await tenantById(LEADER_TENANT)).toBeDefined();
    expect(await tenantById(CLIENT_TENANT)).toBeUndefined();
    expect(await tenantById(EXTRA_TENANT)).toBeUndefined();
    expect(await tenantById(SERVER_TENANT)).toBeUndefined();

    // The connection survived the wipe (it lives under the leader tenant).
    const rows = await connectionsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(LEADER_TENANT);

    // Admin still has access.
    expect(await memberRole(ADMIN_USER, LEADER_TENANT)).toBe("owner");
    expect(await userLastTenant(ADMIN_USER)).toBe(LEADER_TENANT);
  });

  it("refuses to connect a server to itself", async () => {
    await expect(
      conn.connectionsService.initializeConnection(
        CLIENT_TENANT,
        SELF_URL, // same as _GLOBAL_SERVER_CONFIG.baseUrl
        "admin@example.com",
        "pw",
        LEADER_TENANT,
        "self",
        { actingUserId: ADMIN_USER }
      )
    ).rejects.toThrow(/itself/i);

    // Nothing was created.
    expect(await connectionsRows()).toHaveLength(0);
    expect(await tenantById(LEADER_TENANT)).toBeUndefined();
  });
});

describe("isSelfConnectionUrl", () => {
  it("normalizes trailing slashes and case", () => {
    expect(conn.isSelfConnectionUrl(SELF_URL + "/")).toBe(true);
    expect(conn.isSelfConnectionUrl(SELF_URL.toUpperCase())).toBe(true);
    expect(conn.isSelfConnectionUrl(REMOTE_URL)).toBe(false);
  });
});
