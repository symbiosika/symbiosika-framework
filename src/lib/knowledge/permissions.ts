import { getDb } from "../db/db-connection";
import { and, eq, inArray, or, isNull, sql } from "drizzle-orm";
import {
  knowledgeEntry,
  knowledgeGroup,
  knowledgeGroupTeamAssignments,
} from "../db/schema/knowledge";
import { teamMembers } from "../db/schema/users";
import { tenantSpecificData } from "../db/schema/additional-data";
import { checkTenantMemberRole } from "../usermanagement/tenants";
import { checkTeamMemberRole } from "../usermanagement/teams";

/**
 * Helper function to get all team IDs a user is a member of
 */
export const getUserTeamIds = async (
  userId: string,
  tenantId: string
): Promise<string[]> => {
  const userTeams = await getDb().query.teamMembers.findMany({
    where: eq(teamMembers.userId, userId),
    columns: {
      teamId: true,
    },
    with: {
      team: true,
    },
  });
  // Filter the teams by tenantId after fetching
  return userTeams
    .filter((t) => t.team.tenantId === tenantId)
    .map((t) => t.teamId);
};

/**
 * Helper function  to get all knowledge-groups a user has access to
 */
export const getUserKnowledgeGroupIds = async (
  userId: string,
  tenantId: string,
  userTeams?: string[]
): Promise<string[]> => {
  const db = getDb();

  // Get all teams the user is a member of
  if (!userTeams) {
    userTeams = await getUserTeamIds(userId, tenantId);
  }

  // Get knowledge groups where:
  // 1. The user is the direct owner, OR
  // 2. The group has tenant-wide access, OR
  // 3. The group is assigned to one of the user's teams

  // Get directly owned and org-wide groups
  const directGroups = await db.query.knowledgeGroup.findMany({
    where: or(
      eq(knowledgeGroup.userId, userId),
      eq(knowledgeGroup.tenantWideAccess, true)
    ),
    columns: {
      id: true,
    },
  });

  // Get team-assigned groups if user has any teams
  let teamGroups: { id: string }[] = [];
  if (userTeams.length > 0) {
    const teamAssignments =
      await db.query.knowledgeGroupTeamAssignments.findMany({
        where: inArray(knowledgeGroupTeamAssignments.teamId, userTeams),
        columns: {
          knowledgeGroupId: true,
        },
      });

    if (teamAssignments.length > 0) {
      const teamGroupIds = teamAssignments.map((t) => t.knowledgeGroupId);
      teamGroups = await db.query.knowledgeGroup.findMany({
        where: inArray(knowledgeGroup.id, teamGroupIds),
        columns: {
          id: true,
        },
      });
    }
  }

  // Combine and deduplicate the results
  const allGroups = [...directGroups, ...teamGroups];
  const uniqueGroupIds = [...new Set(allGroups.map((g) => g.id))];

  return uniqueGroupIds;
};

/**
 * Helper to validate if a user can access a knowledge entry
 * will take the knowledge id and the userid
 */
export const validateKnowledgeAccess = async (
  knowledgeId: string,
  userId: string,
  tenantId: string
) => {
  const userTeams = await getUserTeamIds(userId, tenantId);

  // First check: user has direct access to the knowledge entry.
  // The entry MUST belong to the requested tenant — without this filter any
  // entry with a NULL teamId would be accessible across tenant boundaries.
  const directAccess = await getDb().query.knowledgeEntry.findFirst({
    where: and(
      eq(knowledgeEntry.id, knowledgeId),
      eq(knowledgeEntry.tenantId, tenantId),
      or(
        eq(knowledgeEntry.userId, userId),
        // Include NULL teamId and entries with user's teams
        or(
          isNull(knowledgeEntry.teamId),
          inArray(knowledgeEntry.teamId, userTeams)
        )
      )
    ),
  });

  if (directAccess) {
    return true;
  }

  // Second check: access through knowledge group assignments
  // First get the entry with its knowledge group (scoped to the tenant)
  const entryWithGroup = await getDb().query.knowledgeEntry.findFirst({
    where: and(
      eq(knowledgeEntry.id, knowledgeId),
      eq(knowledgeEntry.tenantId, tenantId)
    ),
    columns: {
      id: true,
      knowledgeGroupId: true,
    },
  });

  if (!entryWithGroup?.knowledgeGroupId) {
    return false; // No knowledge group assigned
  }

  // Check if the knowledge group is tenant-wide accessible
  const groupWithOrgWideAccess = await getDb().query.knowledgeGroup.findFirst({
    where: and(
      eq(knowledgeGroup.id, entryWithGroup.knowledgeGroupId),
      eq(knowledgeGroup.tenantWideAccess, true)
    ),
  });

  if (groupWithOrgWideAccess) {
    return true; // Organisation-wide access granted
  }

  // Check if any of user's teams are assigned to the knowledge group
  const teamAssignment =
    await getDb().query.knowledgeGroupTeamAssignments.findFirst({
      where: and(
        eq(
          knowledgeGroupTeamAssignments.knowledgeGroupId,
          entryWithGroup.knowledgeGroupId
        ),
        inArray(knowledgeGroupTeamAssignments.teamId, userTeams)
      ),
    });

  return !!teamAssignment; // Access granted if team assignment exists
};

/**
 * ---------------------------------------------------------------------------
 * Write permissions for wiki / knowledge content (knowledge_text + knowledge_entry)
 * ---------------------------------------------------------------------------
 *
 * Historically only tenant admins/owners could edit tenant-wide wiki content
 * and only team admins could edit team content. This behaviour is now
 * configurable per tenant so that other users – e.g. all members of a team –
 * can be permitted to edit as well, without touching the code.
 *
 * The policy is stored in `tenant_specific_data` under the key
 * `WIKI_EDIT_POLICY_KEY`. When no policy is stored the DEFAULT policy is used,
 * which reproduces the previous "admins only" behaviour, so this change is
 * fully backwards compatible.
 */

/** Who may edit tenant-wide wiki content */
export type TenantWideEditPolicy = "admins" | "members";
/** Who may edit team-scoped wiki content */
export type TeamEditPolicy = "team-admins" | "team-members";

export type WikiEditPolicy = {
  /** who may edit tenant-wide content – default "admins" (admin + owner) */
  tenantWide: TenantWideEditPolicy;
  /** who may edit team content – default "team-admins" */
  team: TeamEditPolicy;
};

/** tenant_specific_data key under which the wiki edit policy is stored */
export const WIKI_EDIT_POLICY_KEY = "wiki.editPolicy";

/** Default policy == previous hard-coded behaviour (admins/owners only) */
export const DEFAULT_WIKI_EDIT_POLICY: WikiEditPolicy = {
  tenantWide: "admins",
  team: "team-admins",
};

/**
 * Resolve the effective wiki edit policy for a tenant.
 * Falls back to the default (admins only) when nothing is configured or the
 * stored value is malformed.
 */
export const getWikiEditPolicy = async (
  tenantId: string
): Promise<WikiEditPolicy> => {
  const rows = await getDb()
    .select({ data: tenantSpecificData.data })
    .from(tenantSpecificData)
    .where(
      and(
        eq(tenantSpecificData.tenantId, tenantId),
        eq(tenantSpecificData.key, WIKI_EDIT_POLICY_KEY)
      )
    );

  const stored = rows[0]?.data as Partial<WikiEditPolicy> | undefined;
  if (!stored) {
    return DEFAULT_WIKI_EDIT_POLICY;
  }

  return {
    tenantWide:
      stored.tenantWide === "members"
        ? "members"
        : DEFAULT_WIKI_EDIT_POLICY.tenantWide,
    team:
      stored.team === "team-members"
        ? "team-members"
        : DEFAULT_WIKI_EDIT_POLICY.team,
  };
};

/**
 * Persist the wiki edit policy for a tenant (upsert on tenantId + key).
 */
export const setWikiEditPolicy = async (
  tenantId: string,
  policy: WikiEditPolicy
): Promise<WikiEditPolicy> => {
  await getDb()
    .insert(tenantSpecificData)
    .values({
      tenantId,
      key: WIKI_EDIT_POLICY_KEY,
      data: policy,
    })
    .onConflictDoUpdate({
      target: [tenantSpecificData.tenantId, tenantSpecificData.key],
      set: { data: policy, updatedAt: sql`now()` },
    });
  return policy;
};

/**
 * The access-relevant scope of a piece of wiki content, normalised so the same
 * resolver can gate both `knowledge_text` and `knowledge_entry`.
 */
export type KnowledgeWriteScope = {
  tenantId: string;
  /** organisation-wide content (not restricted to a team or a single user) */
  tenantWide: boolean;
  /** team the content belongs to, if any */
  teamId: string | null;
  /** owning user of personal content, if any */
  userId: string | null;
};

/**
 * Central write-authorization for wiki content.
 *
 * Throws when the acting user is not permitted to create/update/delete the
 * given content, otherwise resolves. Replaces the previously duplicated,
 * hard-coded `checkTenantMemberRole(..., ["admin","owner"])` /
 * `checkTeamMemberRole(..., ["admin"])` checks that were scattered across the
 * knowledge services and routes.
 *
 * Resolution order:
 *  1. no acting user (server-to-server / connection token) -> allowed
 *  2. team content   -> governed by policy.team (tenant admins keep an override)
 *  3. tenant-wide     -> governed by policy.tenantWide
 *  4. personal        -> only the owner (tenant admins keep an override)
 */
export const assertCanWriteKnowledge = async (
  scope: KnowledgeWriteScope,
  ctx: { userId?: string | null; tenantId: string },
  policy?: WikiEditPolicy
): Promise<void> => {
  // No acting user (e.g. connection token acting for the tenant): the route
  // level scope checks already applied, nothing more to gate here.
  if (!ctx.userId) {
    return;
  }

  const effectivePolicy = policy ?? (await getWikiEditPolicy(ctx.tenantId));

  // 1) Team-scoped content
  if (scope.teamId) {
    const teamRoles: ("admin" | "member")[] =
      effectivePolicy.team === "team-members" ? ["admin", "member"] : ["admin"];
    try {
      await checkTeamMemberRole(scope.teamId, ctx.userId, teamRoles);
      return;
    } catch {
      // Tenant admins / owners always keep an override on team content.
      await checkTenantMemberRole(ctx.tenantId, ctx.userId, ["admin", "owner"]);
      return;
    }
  }

  // 2) Tenant-wide content
  if (scope.tenantWide) {
    const tenantRoles: ("owner" | "admin" | "member")[] =
      effectivePolicy.tenantWide === "members"
        ? ["owner", "admin", "member"]
        : ["owner", "admin"];
    await checkTenantMemberRole(ctx.tenantId, ctx.userId, tenantRoles);
    return;
  }

  // 3) Personal content: the owner may edit, tenant admins/owners may override.
  if (scope.userId && scope.userId === ctx.userId) {
    return;
  }
  await checkTenantMemberRole(ctx.tenantId, ctx.userId, ["admin", "owner"]);
};
