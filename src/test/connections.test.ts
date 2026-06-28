/**
 * Connections — leading/following role logic.
 *
 * Runs the REAL connection service against the REAL Postgres database (the same
 * one every other test uses, booted via `createDatabaseClient`), with only the
 * remote server mocked at the `fetch` boundary. No in-process database and no
 * second server process.
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
} from "bun:test";
import { eq, and, inArray, or } from "drizzle-orm";
import {
  createDatabaseClient,
  getDb,
  waitForDbConnection,
} from "../lib/db/db-connection";
import { tenants, users, tenantMembers, connections } from "../lib/db/db-schema";
import { connectionsService, isSelfConnectionUrl } from "../lib/connections";
import { initServerKeysIfNeeded } from "../lib/connections/init-server-keys";
import { _GLOBAL_SERVER_CONFIG } from "../store";

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

// Everything this suite may create — used to clean up before each test without
// touching rows owned by other test files.
const TEST_TENANT_IDS = [
  CLIENT_TENANT,
  LEADER_TENANT,
  SERVER_TENANT,
  EXTRA_TENANT,
  CLIENT_REMOTE_ID,
];
const TEST_TENANT_NAMES = [
  "Client Local",
  "Server Main",
  LEADER_NAME,
  "Acme",
  "Extra",
];

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
// Reset + seed (only the rows the connection flow touches)
// ---------------------------------------------------------------------------
async function resetAndSeed() {
  const db = getDb();

  // Clear connections first: a connection's remote_tenant_id has no FK, so
  // deleting tenants would not cascade those rows away.
  await db.delete(connections);
  // Deleting the tenants cascades their tenant_members.
  await db
    .delete(tenants)
    .where(
      or(
        inArray(tenants.id, TEST_TENANT_IDS),
        inArray(tenants.name, TEST_TENANT_NAMES)
      )
    );
  await db.delete(users).where(eq(users.id, ADMIN_USER));

  await db.insert(tenants).values([
    { id: CLIENT_TENANT, name: "Client Local", origin: "local" },
    { id: SERVER_TENANT, name: "Server Main", origin: "local" },
  ]);
  await db
    .insert(users)
    .values({
      id: ADMIN_USER,
      email: "admin@example.com",
      firstname: "Ada",
      surname: "Admin",
    });
  await db
    .insert(tenantMembers)
    .values({ userId: ADMIN_USER, tenantId: CLIENT_TENANT, role: "admin" });

  await initServerKeysIfNeeded();
  exchangeShouldFail = false;
  capturedExchangeBody = null;
}

const tenantById = async (id: string) =>
  (await getDb().select().from(tenants).where(eq(tenants.id, id)))[0];
const connectionsRows = async () => getDb().select().from(connections);
const memberRole = async (userId: string, tenantId: string) =>
  (
    await getDb()
      .select({ role: tenantMembers.role })
      .from(tenantMembers)
      .where(
        and(
          eq(tenantMembers.userId, userId),
          eq(tenantMembers.tenantId, tenantId)
        )
      )
  )[0]?.role;
const userLastTenant = async (userId: string) =>
  (
    await getDb()
      .select({ lastTenantId: users.lastTenantId })
      .from(users)
      .where(eq(users.id, userId))
  )[0]?.lastTenantId;

beforeAll(async () => {
  _GLOBAL_SERVER_CONFIG.baseUrl = SELF_URL;
  await createDatabaseClient();
  await waitForDbConnection();
});
beforeEach(resetAndSeed);
afterAll(async () => {
  globalThis.fetch = originalFetch;
  // Leave the database clean for the next test file.
  await getDb().delete(connections);
  await getDb()
    .delete(tenants)
    .where(
      or(
        inArray(tenants.id, TEST_TENANT_IDS),
        inArray(tenants.name, TEST_TENANT_NAMES)
      )
    );
  await getDb().delete(users).where(eq(users.id, ADMIN_USER));
});

// ---------------------------------------------------------------------------
// acceptConnection (the receiving side)
// ---------------------------------------------------------------------------
describe("acceptConnection", () => {
  it("leading: does NOT create a shadow of the connecting client", async () => {
    await connectionsService.acceptConnection(
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
    expect(rows[0]!.tenantId).toBe(SERVER_TENANT);
    expect(rows[0]!.role).toBe("leading");
    expect(rows[0]!.status).toBe("active");
    expect(rows[0]!.initiatedBy).toBe("remote");
    expect(rows[0]!.remoteTenantId).toBe(CLIENT_REMOTE_ID);
    expect(rows[0]!.remotePublicKey).toBe("CLIENT_PUBKEY");
  });

  it("following: DOES mirror the remote leader tenant (origin=remote)", async () => {
    await connectionsService.acceptConnection(
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
    expect(shadow!.origin).toBe("remote");

    const rows = await connectionsRows();
    expect(rows[0]!.tenantId).toBe(LEADER_TENANT);
    expect(rows[0]!.role).toBe("following");
  });
});

// ---------------------------------------------------------------------------
// Tenant name collisions
// ---------------------------------------------------------------------------
describe("tenant name uniqueness", () => {
  it("allows several remote shadows to share a name but rejects a duplicate local name", async () => {
    const db = getDb();
    await db.insert(tenants).values({ name: "Acme", origin: "local" });
    // Two different remote leaders both called "Acme" must both be mirrorable.
    await db.insert(tenants).values({ name: "Acme", origin: "remote" });
    await db.insert(tenants).values({ name: "Acme", origin: "remote" });

    let rejected = false;
    try {
      await db.insert(tenants).values({ name: "Acme", origin: "local" });
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
    const result = await connectionsService.initializeConnection(
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
    expect(shadow!.origin).toBe("remote");

    const rows = await connectionsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(LEADER_TENANT);
    expect(rows[0]!.role).toBe("following");
    expect(rows[0]!.status).toBe("active");
    expect(rows[0]!.initiatedBy).toBe("local");
    expect(rows[0]!.remoteTenantId).toBe(LEADER_TENANT);
    expect(rows[0]!.remotePublicKey).toBe("REMOTE_PUBLIC_KEY");

    // The peer is told to take the opposite (leading) role.
    expect(capturedExchangeBody.role).toBe("leading");

    // The initiating admin keeps a working login on the adopted tenant.
    expect(await memberRole(ADMIN_USER, LEADER_TENANT)).toBe("owner");
    expect(await userLastTenant(ADMIN_USER)).toBe(LEADER_TENANT);
  });

  it("leading: keeps own tenant, no shadow, tells peer to follow", async () => {
    await connectionsService.initializeConnection(
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
    expect(rows[0]!.tenantId).toBe(CLIENT_TENANT);
    expect(rows[0]!.role).toBe("leading");
    expect(rows[0]!.remoteTenantId).toBe(LEADER_TENANT);
    expect(capturedExchangeBody.role).toBe("following");
  });

  it("rolls back staged connection AND freshly-created shadow when key exchange fails", async () => {
    exchangeShouldFail = true;
    await expect(
      connectionsService.initializeConnection(
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
    await getDb()
      .insert(tenants)
      .values({ id: EXTRA_TENANT, name: "Extra", origin: "local" });

    await connectionsService.initializeConnection(
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
    expect(rows[0]!.tenantId).toBe(LEADER_TENANT);

    // Admin still has access.
    expect(await memberRole(ADMIN_USER, LEADER_TENANT)).toBe("owner");
    expect(await userLastTenant(ADMIN_USER)).toBe(LEADER_TENANT);
  });

  it("refuses to connect a server to itself", async () => {
    await expect(
      connectionsService.initializeConnection(
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
    expect(isSelfConnectionUrl(SELF_URL + "/")).toBe(true);
    expect(isSelfConnectionUrl(SELF_URL.toUpperCase())).toBe(true);
    expect(isSelfConnectionUrl(REMOTE_URL)).toBe(false);
  });
});
