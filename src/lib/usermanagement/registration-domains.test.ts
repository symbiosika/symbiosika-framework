import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import type { SymbiosikaFrameworkHonoApp } from "../../types";
import { getDb } from "../db/db-connection";
import {
  invitationCodes,
  registrationDomains,
  tenantInvitations,
  tenantMembers,
  tenants,
  users,
} from "../db/db-schema";
import { initTests } from "../../test/init.test";
import { LocalAuth } from "../auth";
import { createMagicLinkToken } from "../auth/magic-link";
import {
  completePendingOAuthRegistration,
  createPendingRegistrationToken,
} from "../auth/oauth2";
import { definePublicUserRoutes } from "../../routes/user/public";
import { createTenant } from "./tenants";
import {
  checkIfInvitationCodeIsNeededToRegister,
  getEmailDomain,
  getRegistrationDomainForEmail,
} from "./invitations";

/**
 * Registration domains: an address of a cleared domain registers without a
 * general invitation code and is joined to the rule's tenant.
 */
const app: SymbiosikaFrameworkHonoApp = new Hono();

const GATE_CODE = "registration-domain-test-gate";
const DOMAIN = "regdomain-test.example";
const DOMAIN_NO_TENANT = "regdomain-notenant.example";
const DOMAIN_INACTIVE = "regdomain-inactive.example";

const LOCAL_EMAIL = `local@${DOMAIN}`;
const MAGIC_EMAIL = `Magic@${DOMAIN.toUpperCase()}`;
const OAUTH_EMAIL = `oauth@${DOMAIN}`;
const INVITED_EMAIL = `invited@${DOMAIN}`;
const NO_TENANT_EMAIL = `plain@${DOMAIN_NO_TENANT}`;
const INACTIVE_EMAIL = `user@${DOMAIN_INACTIVE}`;
const OTHER_EMAIL = "someone@not-cleared.example";
const SUBDOMAIN_EMAIL = `user@sub.${DOMAIN}`;

const ALL_EMAILS = [
  LOCAL_EMAIL,
  MAGIC_EMAIL.toLowerCase(),
  OAUTH_EMAIL,
  INVITED_EMAIL,
  NO_TENANT_EMAIL,
  INACTIVE_EMAIL,
  OTHER_EMAIL,
  SUBDOMAIN_EMAIL,
];

let tenantId = "";

const getMembership = async (email: string) => {
  const rows = await getDb()
    .select({
      role: tenantMembers.role,
      lastTenantId: users.lastTenantId,
    })
    .from(users)
    .leftJoin(
      tenantMembers,
      and(
        eq(tenantMembers.userId, users.id),
        eq(tenantMembers.tenantId, tenantId)
      )
    )
    .where(eq(users.email, email));
  return rows[0];
};

const cleanup = async () => {
  await getDb().delete(users).where(inArray(users.email, ALL_EMAILS));
  await getDb()
    .delete(registrationDomains)
    .where(
      inArray(registrationDomains.domain, [
        DOMAIN,
        DOMAIN_NO_TENANT,
        DOMAIN_INACTIVE,
      ])
    );
  await getDb()
    .delete(invitationCodes)
    .where(eq(invitationCodes.code, GATE_CODE));
  if (tenantId) {
    await getDb().delete(tenants).where(eq(tenants.id, tenantId));
  }
};

describe("Registration domains", () => {
  beforeAll(async () => {
    await initTests();
    definePublicUserRoutes(app, "/api/v1");
    await cleanup();

    const tenant = await createTenant({ name: "Registration Domain Tenant" });
    tenantId = tenant.id;

    // An owner already exists, so a domain user must not take over the tenant.
    const owner = await getDb()
      .insert(users)
      .values({
        email: `owner@${DOMAIN}`,
        firstname: "",
        surname: "",
        extUserId: "",
        salt: "",
        password: null,
        emailVerified: true,
      })
      .returning();
    ALL_EMAILS.push(owner[0]!.email);
    await getDb()
      .insert(tenantMembers)
      .values({ tenantId, userId: owner[0]!.id, role: "owner" });

    await getDb()
      .insert(registrationDomains)
      .values([
        { domain: DOMAIN, tenantId, role: "member" },
        { domain: DOMAIN_NO_TENANT },
        { domain: DOMAIN_INACTIVE, tenantId, isActive: false },
      ]);

    // Gate the instance: without a matching domain a code is required.
    await getDb()
      .insert(invitationCodes)
      .values({ code: GATE_CODE, isActive: true });
  });

  afterAll(async () => {
    try {
      // An invitation code left active in the DB would make every registration
      // demand one, so it is removed even if a test failed midway.
      await cleanup();
    } catch (err) {
      console.warn("[registration-domains.test] cleanup failed:", err);
    }
  });

  test("getEmailDomain extracts the lower-case domain", () => {
    expect(getEmailDomain("Jane@Example.COM")).toBe("example.com");
    expect(getEmailDomain("a@b@example.com")).toBe("example.com");
    expect(getEmailDomain("no-at-sign")).toBeNull();
    expect(getEmailDomain("trailing@")).toBeNull();
    expect(getEmailDomain("@example.com")).toBeNull();
  });

  test("only active rules with an exact domain match apply", async () => {
    expect((await getRegistrationDomainForEmail(LOCAL_EMAIL))?.domain).toBe(
      DOMAIN
    );
    expect(await getRegistrationDomainForEmail(INACTIVE_EMAIL)).toBeNull();
    expect(await getRegistrationDomainForEmail(OTHER_EMAIL)).toBeNull();
    expect(await getRegistrationDomainForEmail(SUBDOMAIN_EMAIL)).toBeNull();
  });

  test("a cleared domain needs no invitation code", async () => {
    expect(await checkIfInvitationCodeIsNeededToRegister()).toBe(true);
    expect(await checkIfInvitationCodeIsNeededToRegister(LOCAL_EMAIL)).toBe(
      false
    );
    expect(await checkIfInvitationCodeIsNeededToRegister(OTHER_EMAIL)).toBe(
      true
    );
    expect(await checkIfInvitationCodeIsNeededToRegister(INACTIVE_EMAIL)).toBe(
      true
    );
  });

  test("GET invitation-code-needed honours the email query", async () => {
    let response = await app.request(
      `/api/v1/user/invitation-code-needed?email=${encodeURIComponent(LOCAL_EMAIL)}`
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ invitationCodeNeeded: false });

    response = await app.request(
      `/api/v1/user/invitation-code-needed?email=${encodeURIComponent(OTHER_EMAIL)}`
    );
    expect(await response.json()).toEqual({ invitationCodeNeeded: true });

    response = await app.request("/api/v1/user/invitation-code-needed");
    expect(await response.json()).toEqual({ invitationCodeNeeded: true });
  });

  test("LocalAuth.register skips the code and joins the tenant", async () => {
    const user = await LocalAuth.register(LOCAL_EMAIL, "pw-123456", false, {});
    expect(user.email).toBe(LOCAL_EMAIL);

    const membership = await getMembership(LOCAL_EMAIL);
    expect(membership?.role).toBe("member");
    expect(membership?.lastTenantId).toBe(tenantId);
  });

  test("LocalAuth.register still demands a code outside the domain", async () => {
    expect(
      LocalAuth.register(OTHER_EMAIL, "pw-123456", false, {})
    ).rejects.toThrow("No invitation code provided but is required");
    expect(
      LocalAuth.register(INACTIVE_EMAIL, "pw-123456", false, {})
    ).rejects.toThrow("No invitation code provided but is required");
  });

  test("a rule without tenant only skips the code", async () => {
    const user = await LocalAuth.register(
      NO_TENANT_EMAIL,
      "pw-123456",
      false,
      {}
    );
    expect(user.email).toBe(NO_TENANT_EMAIL);

    const memberships = await getDb()
      .select()
      .from(tenantMembers)
      .where(eq(tenantMembers.userId, user.id));
    expect(memberships).toHaveLength(0);
  });

  test("magic-link sign-up skips the code and joins the tenant", async () => {
    const token = await createMagicLinkToken(MAGIC_EMAIL, "login", true);
    expect(token).toBeString();

    const membership = await getMembership(MAGIC_EMAIL.toLowerCase());
    expect(membership?.role).toBe("member");
    expect(membership?.lastTenantId).toBe(tenantId);
  });

  test("social sign-up skips the code and joins the tenant", async () => {
    const pendingToken = createPendingRegistrationToken({
      profile: {
        email: OAUTH_EMAIL,
        id: "regdomain-oauth-subject",
        provider: "google",
      },
      redirect: "/",
    });

    const result = await completePendingOAuthRegistration(
      pendingToken,
      undefined
    );
    expect(result.user.email).toBe(OAUTH_EMAIL);

    const membership = await getMembership(OAUTH_EMAIL);
    expect(membership?.role).toBe("member");
    expect(membership?.lastTenantId).toBe(tenantId);
  });

  test("an invitation's role is not downgraded by the domain rule", async () => {
    await getDb().insert(tenantInvitations).values({
      email: INVITED_EMAIL,
      tenantId,
      role: "admin",
      status: "pending",
    });

    await createMagicLinkToken(INVITED_EMAIL, "login", true);

    const membership = await getMembership(INVITED_EMAIL);
    expect(membership?.role).toBe("admin");
  });
});
