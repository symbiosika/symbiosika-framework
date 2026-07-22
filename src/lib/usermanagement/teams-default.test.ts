import { describe, test, expect, beforeAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORG3_USER_1,
} from "../../test/init.test";
import { getDb } from "../db/db-connection";
import { teams, teamMembers, tenantMembers } from "../db/schema/users";
import {
  createTeam,
  addUserToDefaultTeams,
  getDefaultTeamsForTenant,
  isUserPartOfTeam,
} from "./teams";
import { addTenantMember } from "./tenants";
import { createTenantInvitation, acceptTenantInvitation } from "./invitations";

/**
 * Tests for the "add new tenant users to this team by default" flag.
 *
 * A team can be flagged with `addNewUsersByDefault`. Every user that newly
 * joins the tenant (directly via `addTenantMember` or by accepting an
 * invitation) must be auto-added to all flagged teams as a "member".
 */
describe("Teams: add new users by default", () => {
  let defaultTeamId: string;
  let normalTeamId: string;

  beforeAll(async () => {
    await initTests();

    // Start from a clean slate for TEST_ORG3_USER_1 inside ORGANISATION_1.
    await getDb()
      .delete(tenantMembers)
      .where(
        and(
          eq(tenantMembers.tenantId, TEST_ORGANISATION_1.id),
          eq(tenantMembers.userId, TEST_ORG3_USER_1.id)
        )
      );

    // Remove any teams left over from earlier runs (team names are globally
    // unique, so reuse would collide).
    await getDb()
      .delete(teams)
      .where(eq(teams.tenantId, TEST_ORGANISATION_1.id));

    const defaultTeam = await createTeam({
      name: "Default Team (auto-join)",
      tenantId: TEST_ORGANISATION_1.id,
      addNewUsersByDefault: true,
    });
    defaultTeamId = defaultTeam.id;

    const normalTeam = await createTeam({
      name: "Normal Team (opt-in)",
      tenantId: TEST_ORGANISATION_1.id,
      addNewUsersByDefault: false,
    });
    normalTeamId = normalTeam.id;
  });

  test("getDefaultTeamsForTenant returns only flagged teams", async () => {
    const defaults = await getDefaultTeamsForTenant(TEST_ORGANISATION_1.id);
    const ids = defaults.map((t) => t.id);
    expect(ids).toContain(defaultTeamId);
    expect(ids).not.toContain(normalTeamId);
  });

  test("addTenantMember auto-joins the user into default teams only", async () => {
    await addTenantMember(
      TEST_ORGANISATION_1.id,
      TEST_ORG3_USER_1.id,
      "member"
    );

    expect(await isUserPartOfTeam(TEST_ORG3_USER_1.id, defaultTeamId)).toBe(
      true
    );
    expect(await isUserPartOfTeam(TEST_ORG3_USER_1.id, normalTeamId)).toBe(
      false
    );

    // The auto-created membership must have the "member" role.
    const membership = await getDb()
      .select()
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, defaultTeamId),
          eq(teamMembers.userId, TEST_ORG3_USER_1.id)
        )
      );
    expect(membership[0]?.role).toBe("member");
  });

  test("addUserToDefaultTeams is idempotent", async () => {
    // Running it again must neither throw nor create duplicate rows.
    await addUserToDefaultTeams(TEST_ORG3_USER_1.id, TEST_ORGANISATION_1.id);

    const memberships = await getDb()
      .select()
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, defaultTeamId),
          eq(teamMembers.userId, TEST_ORG3_USER_1.id)
        )
      );
    expect(memberships.length).toBe(1);
  });

  test("accepting an invitation also auto-joins default teams", async () => {
    // Clean up membership so the user rejoins fresh through the invite flow.
    await getDb()
      .delete(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, defaultTeamId),
          eq(teamMembers.userId, TEST_ORG3_USER_1.id)
        )
      );
    await getDb()
      .delete(tenantMembers)
      .where(
        and(
          eq(tenantMembers.tenantId, TEST_ORGANISATION_1.id),
          eq(tenantMembers.userId, TEST_ORG3_USER_1.id)
        )
      );

    const invitation = await createTenantInvitation({
      tenantId: TEST_ORGANISATION_1.id,
      email: TEST_ORG3_USER_1.email,
      role: "member",
      status: "pending",
    });

    await acceptTenantInvitation(
      invitation.id,
      TEST_ORG3_USER_1.id,
      TEST_ORGANISATION_1.id
    );

    expect(await isUserPartOfTeam(TEST_ORG3_USER_1.id, defaultTeamId)).toBe(
      true
    );
    expect(await isUserPartOfTeam(TEST_ORG3_USER_1.id, normalTeamId)).toBe(
      false
    );
  });
});
