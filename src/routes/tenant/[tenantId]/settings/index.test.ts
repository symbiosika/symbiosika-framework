import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import defineTenantSettingsRoutes from "./index";
import type { SymbiosikaFrameworkHonoApp } from "../../../../types";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORGANISATION_2,
  TEST_ORG1_USER_2,
} from "../../../../test/init.test";
import { generateUserSessionJwt } from "../../../../lib/auth";
import { getDb } from "../../../../lib/db/db-connection";
import { tenantSettings } from "../../../../lib/db/db-schema";
import { eq } from "drizzle-orm";

const ORG1 = TEST_ORGANISATION_1.id;
const ORG2 = TEST_ORGANISATION_2.id;

const TEST_KEY = "branding.primaryColor";
const OTHER_KEY = "branding.secondaryColor";

describe("Tenant Settings Routes", () => {
  const app: SymbiosikaFrameworkHonoApp = new Hono();
  // owner of ORG1 (and ORG2) → may read and write
  let adminJwt: string;
  // owner of ORG2 only → not a member of ORG1
  let outsiderJwt: string;
  // plain "member" of ORG1 → may read but not write
  let memberJwt: string;

  const cleanup = async () => {
    const db = await getDb();
    await db.delete(tenantSettings).where(eq(tenantSettings.key, TEST_KEY));
    await db.delete(tenantSettings).where(eq(tenantSettings.key, OTHER_KEY));
  };

  beforeAll(async () => {
    const { adminToken, user2Token } = await initTests();
    adminJwt = adminToken;
    outsiderJwt = user2Token;

    // Mint a token for a plain ORG1 member (initTests only returns owner-level
    // tokens for ORG1, so we build a member token explicitly here).
    memberJwt = (
      await generateUserSessionJwt(
        {
          email: TEST_ORG1_USER_2.email,
          id: TEST_ORG1_USER_2.id,
          firstname: "",
          surname: "",
        },
        86400
      )
    ).token;

    await cleanup();
    defineTenantSettingsRoutes(app, "/api");
  });

  afterAll(async () => {
    try {
      await cleanup();
    } catch (err) {
      console.warn("[routes/tenant/settings.test] cleanup failed:", err);
    }
  });

  const post = (tenantId: string, key: string, body: unknown, jwt: string) =>
    app.request(`/api/tenant/${tenantId}/settings/${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `jwt=${jwt}` },
      body: JSON.stringify(body),
    });

  const get = (tenantId: string, key: string, jwt: string) =>
    app.request(`/api/tenant/${tenantId}/settings/${key}`, {
      method: "GET",
      headers: { Cookie: `jwt=${jwt}` },
    });

  // ----- write access (admins/owners) --------------------------------------

  it("allows a tenant admin to create a setting", async () => {
    const res = await post(ORG1, TEST_KEY, { value: "#204393" }, adminJwt);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.key).toBe(TEST_KEY);
    expect(data.value).toBe("#204393");
  });

  it("allows a tenant admin to update an existing setting", async () => {
    const res = await post(ORG1, TEST_KEY, { value: "#112233" }, adminJwt);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).value).toBe("#112233");

    const check = await get(ORG1, TEST_KEY, adminJwt);
    expect(((await check.json()) as any).value).toBe("#112233");
  });

  it("stores and retrieves JSON values", async () => {
    const palette = { primary: "#204393", surface: "#18181b" };
    const res = await post(ORG1, OTHER_KEY, { valueJson: palette }, adminJwt);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).valueJson).toEqual(palette);

    const check = await get(ORG1, OTHER_KEY, adminJwt);
    const data: any = await check.json();
    expect(data.valueJson).toEqual(palette);
    expect(data.value).toBeUndefined();
  });

  // ----- read access (any member) ------------------------------------------

  it("allows a plain tenant member to read a setting", async () => {
    const res = await get(ORG1, TEST_KEY, memberJwt);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).value).toBe("#112233");
  });

  it("lists all settings for the tenant", async () => {
    const res = await app.request(`/api/tenant/${ORG1}/settings`, {
      method: "GET",
      headers: { Cookie: `jwt=${memberJwt}` },
    });
    expect(res.status).toBe(200);
    const rows: any[] = await res.json();
    const keys = rows.map((r) => r.key);
    expect(keys).toContain(TEST_KEY);
    expect(keys).toContain(OTHER_KEY);
  });

  it("returns 404 for a non-existent setting", async () => {
    const res = await get(ORG1, "does-not-exist", adminJwt);
    expect(res.status).toBe(404);
  });

  // ----- authorization ------------------------------------------------------

  it("forbids a plain member from writing a setting", async () => {
    const res = await post(ORG1, TEST_KEY, { value: "hacked" }, memberJwt);
    expect(res.status).toBe(403);
    // value must be unchanged
    const check = await get(ORG1, TEST_KEY, adminJwt);
    expect(((await check.json()) as any).value).toBe("#112233");
  });

  it("forbids a plain member from deleting a setting", async () => {
    const res = await app.request(`/api/tenant/${ORG1}/settings/${TEST_KEY}`, {
      method: "DELETE",
      headers: { Cookie: `jwt=${memberJwt}` },
    });
    expect(res.status).toBe(403);
  });

  it("forbids a non-member from reading tenant settings", async () => {
    const res = await get(ORG1, TEST_KEY, outsiderJwt);
    expect(res.status).toBe(403);
  });

  it("forbids a non-member from writing tenant settings", async () => {
    const res = await post(ORG1, TEST_KEY, { value: "nope" }, outsiderJwt);
    expect(res.status).toBe(403);
  });

  it("returns 401 without authentication", async () => {
    const res = await app.request(`/api/tenant/${ORG1}/settings/${TEST_KEY}`, {
      method: "GET",
    });
    expect(res.status).toBe(401);
  });

  it("rejects a request body without value or valueJson", async () => {
    const res = await post(ORG1, TEST_KEY, { description: "no value" }, adminJwt);
    expect(res.status).toBe(400);
  });

  // ----- per-tenant isolation ----------------------------------------------

  it("isolates settings per tenant", async () => {
    // admin is owner of both ORG1 and ORG2 → same key, different values
    await post(ORG1, TEST_KEY, { value: "org1-value" }, adminJwt);
    await post(ORG2, TEST_KEY, { value: "org2-value" }, adminJwt);

    const a = await get(ORG1, TEST_KEY, adminJwt);
    const b = await get(ORG2, TEST_KEY, adminJwt);
    expect(((await a.json()) as any).value).toBe("org1-value");
    expect(((await b.json()) as any).value).toBe("org2-value");
  });

  // ----- delete (admins/owners) --------------------------------------------

  it("allows a tenant admin to delete a setting", async () => {
    const del = await app.request(`/api/tenant/${ORG1}/settings/${OTHER_KEY}`, {
      method: "DELETE",
      headers: { Cookie: `jwt=${adminJwt}` },
    });
    expect(del.status).toBe(200);

    const check = await get(ORG1, OTHER_KEY, adminJwt);
    expect(check.status).toBe(404);
  });
});
