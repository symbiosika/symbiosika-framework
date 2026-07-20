import { describe, test, expect, beforeAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORG3_USER_1,
} from "../../test/init.test";
import { getDb } from "../db/db-connection";
import { tenantInvitations, tenantMembers } from "../db/schema/users";
import {
  createInvitationToken,
  verifyInvitationToken,
  createTenantInvitation,
  acceptInvitationByToken,
} from "./invitations";

/**
 * Tests for the "one click = accepted" invitation link flow
 * (accept-invitation via a signed token in the invitation email).
 */
describe("Accept invitation via emailed link", () => {
  beforeAll(async () => {
    await initTests();

    // TEST_ORG3_USER_1 is not a member of ORGANISATION_1 – make sure any prior
    // membership / invitation from earlier runs is cleared.
    await getDb()
      .delete(tenantMembers)
      .where(
        and(
          eq(tenantMembers.tenantId, TEST_ORGANISATION_1.id),
          eq(tenantMembers.userId, TEST_ORG3_USER_1.id)
        )
      );
    await getDb()
      .delete(tenantInvitations)
      .where(eq(tenantInvitations.tenantId, TEST_ORGANISATION_1.id));
  });

  test("token round-trips (sign -> verify)", () => {
    const token = createInvitationToken("some-invitation-id");
    expect(verifyInvitationToken(token).invitationId).toBe("some-invitation-id");
  });

  test("verify rejects a garbage token", () => {
    expect(() => verifyInvitationToken("not-a-real-token")).toThrow();
  });

  test("existing user: link accepts the membership immediately", async () => {
    const invitation = await createTenantInvitation(
      {
        tenantId: TEST_ORGANISATION_1.id,
        email: TEST_ORG3_USER_1.email,
        role: "admin",
        status: "pending",
      },
      false
    );

    const token = createInvitationToken(invitation.id);
    const result = await acceptInvitationByToken(token);

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.userId).toBe(TEST_ORG3_USER_1.id);
    expect(result.tenantId).toBe(TEST_ORGANISATION_1.id);

    // Membership must now exist with the invited role.
    const members = await getDb()
      .select()
      .from(tenantMembers)
      .where(
        and(
          eq(tenantMembers.tenantId, TEST_ORGANISATION_1.id),
          eq(tenantMembers.userId, TEST_ORG3_USER_1.id)
        )
      );
    expect(members.length).toBe(1);
    expect(members[0].role).toBe("admin");

    // Invitation must be marked accepted.
    const [inv] = await getDb()
      .select()
      .from(tenantInvitations)
      .where(eq(tenantInvitations.id, invitation.id));
    expect(inv.status).toBe("accepted");
  });

  test("clicking the link twice is idempotent (no error)", async () => {
    const invitation = await createTenantInvitation(
      {
        tenantId: TEST_ORGANISATION_1.id,
        email: TEST_ORG3_USER_1.email,
        role: "member",
        status: "pending",
      },
      false
    );

    const token = createInvitationToken(invitation.id);
    // First click accepts, second click must not throw.
    const first = await acceptInvitationByToken(token);
    const second = await acceptInvitationByToken(token);

    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");

    // Still exactly one membership row.
    const members = await getDb()
      .select()
      .from(tenantMembers)
      .where(
        and(
          eq(tenantMembers.tenantId, TEST_ORGANISATION_1.id),
          eq(tenantMembers.userId, TEST_ORG3_USER_1.id)
        )
      );
    expect(members.length).toBe(1);
  });

  test("unknown email: link routes the invitee to registration", async () => {
    const invitation = await createTenantInvitation(
      {
        tenantId: TEST_ORGANISATION_1.id,
        email: "brand-new-invitee@symbiosika.com",
        role: "member",
        status: "pending",
      },
      false
    );

    const token = createInvitationToken(invitation.id);
    const result = await acceptInvitationByToken(token);

    expect(result.status).toBe("needs_registration");
    if (result.status !== "needs_registration") return;
    expect(result.email).toBe("brand-new-invitee@symbiosika.com");
    expect(result.tenantId).toBe(TEST_ORGANISATION_1.id);

    // No membership should have been created for a non-existent user.
    // (The registration flow will accept it once the account exists.)
    const [inv] = await getDb()
      .select()
      .from(tenantInvitations)
      .where(eq(tenantInvitations.id, invitation.id));
    expect(inv.status).toBe("pending");
  });

  test("token for a deleted invitation throws", async () => {
    const token = createInvitationToken(
      "00000000-0000-0000-0000-000000000999"
    );
    await expect(acceptInvitationByToken(token)).rejects.toThrow();
  });
});
