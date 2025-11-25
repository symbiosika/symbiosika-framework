import { getDb } from "../db/db-connection";
import {
  knowledgeGroup,
  knowledgeGroupTeamAssignments,
  type KnowledgeGroupInsert,
  type KnowledgeGroupSelect,
} from "../db/schema/knowledge";
import { and, eq, inArray, or, SQL } from "drizzle-orm";
import { isUserPartOfTeam } from "../usermanagement/teams";
import { teams } from "../db/schema/users";

/**
 * Create a new knowledge group
 */
export const createKnowledgeGroup = async (
  data: KnowledgeGroupInsert
): Promise<KnowledgeGroupSelect> => {
  const db = getDb();

  const [newGroup] = await db.insert(knowledgeGroup).values(data).returning();

  return newGroup;
};

/**
 * Get knowledge groups by tenant ID with optional filtering
 */
export const getKnowledgeGroups = async (params: {
  tenantId: string;
  userId?: string;
  teamId?: string;
  includeTeamAssignments?: boolean;
}): Promise<KnowledgeGroupSelect[]> => {
  const db = getDb();

  const conditions = [eq(knowledgeGroup.tenantId, params.tenantId)];

  // Filter by user if provided
  if (params.userId) {
    conditions.push(
      or(
        eq(knowledgeGroup.userId, params.userId),
        eq(knowledgeGroup.tenantWideAccess, true)
      ) as SQL<unknown>
    );
  }

  // If team ID is provided, filter by team assignments
  if (params.teamId) {
    const teamGroupIds = db
      .select({ id: knowledgeGroupTeamAssignments.knowledgeGroupId })
      .from(knowledgeGroupTeamAssignments)
      .where(eq(knowledgeGroupTeamAssignments.teamId, params.teamId));

    conditions.push(
      or(
        eq(knowledgeGroup.tenantWideAccess, true),
        inArray(knowledgeGroup.id, teamGroupIds)
      ) as SQL<unknown>
    );
  }

  // Basic query without team assignments
  if (!params.includeTeamAssignments) {
    return db
      .select()
      .from(knowledgeGroup)
      .where(and(...conditions))
      .orderBy(knowledgeGroup.name);
  }

  // Advanced query with team assignments
  const groups = await db.query.knowledgeGroup.findMany({
    where: and(...conditions),
    with: {
      teamAssignments: {
        columns: {
          id: true,
          teamId: true,
        },
      },
    },
    orderBy: [knowledgeGroup.name],
  });

  return groups;
};

/**
 * Get a single knowledge group by ID
 */
export const getKnowledgeGroupById = async (
  id: string,
  params: {
    tenantId: string;
    userId?: string;
    includeTeamAssignments?: boolean;
  }
): Promise<KnowledgeGroupSelect | null> => {
  const db = getDb();

  const conditions = [
    eq(knowledgeGroup.id, id),
    eq(knowledgeGroup.tenantId, params.tenantId),
  ];

  // Add user check if specified
  if (params.userId) {
    conditions.push(
      or(
        eq(knowledgeGroup.userId, params.userId),
        eq(knowledgeGroup.tenantWideAccess, true)
      ) as SQL<unknown>
    );
  }

  if (!params.includeTeamAssignments) {
    const group = await db
      .select()
      .from(knowledgeGroup)
      .where(and(...conditions))
      .limit(1);

    return group[0] || null;
  }

  const group = await db.query.knowledgeGroup.findFirst({
    where: and(...conditions),
    with: {
      teamAssignments: {
        columns: {
          id: true,
          teamId: true,
        },
      },
    },
  });

  return group || null;
};

/**
 * Update a knowledge group
 */
export const updateKnowledgeGroup = async (
  id: string,
  data: Partial<KnowledgeGroupInsert>,
  params: {
    tenantId: string;
    userId: string;
  }
): Promise<KnowledgeGroupSelect> => {
  const db = getDb();

  // Check if user has permission to update this group
  const group = await getKnowledgeGroupById(id, {
    tenantId: params.tenantId,
    userId: params.userId,
  });

  if (!group) {
    throw new Error(
      "Knowledge group not found or user does not have permission to update it"
    );
  }

  // Update the group
  const [updatedGroup] = await db
    .update(knowledgeGroup)
    .set({
      ...data,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(knowledgeGroup.id, id),
        eq(knowledgeGroup.tenantId, params.tenantId)
      )
    )
    .returning();

  return updatedGroup;
};

/**
 * Delete a knowledge group
 */
export const deleteKnowledgeGroup = async (
  id: string,
  params: {
    tenantId: string;
    userId: string;
  }
): Promise<void> => {
  const db = getDb();

  // Check if user has permission to delete this group
  const group = await getKnowledgeGroupById(id, {
    tenantId: params.tenantId,
    userId: params.userId,
  });

  if (!group) {
    throw new Error(
      "Knowledge group not found or user does not have permission to delete it"
    );
  }

  // Delete the group
  await db
    .delete(knowledgeGroup)
    .where(
      and(
        eq(knowledgeGroup.id, id),
        eq(knowledgeGroup.tenantId, params.tenantId)
      )
    );
};

/**
 * Assign a team to a knowledge group
 */
export const assignTeamToKnowledgeGroup = async (
  knowledgeGroupId: string,
  teamId: string,
  params: {
    tenantId: string;
    userId: string;
  }
): Promise<void> => {
  const db = getDb();

  // Check if user has permission to update this group
  const group = await getKnowledgeGroupById(knowledgeGroupId, {
    tenantId: params.tenantId,
    userId: params.userId,
  });

  if (!group) {
    throw new Error(
      "Knowledge group not found or user does not have permission to update it"
    );
  }

  // Check if user is part of the team
  const isPartOfTeam = await isUserPartOfTeam(params.userId, teamId);
  if (!isPartOfTeam) {
    throw new Error("User is not part of the provided team");
  }

  // Create the assignment
  await db
    .insert(knowledgeGroupTeamAssignments)
    .values({
      knowledgeGroupId,
      teamId,
    })
    .onConflictDoNothing({
      target: [
        knowledgeGroupTeamAssignments.knowledgeGroupId,
        knowledgeGroupTeamAssignments.teamId,
      ],
    });
};

/**
 * Remove a team from a knowledge group
 */
export const removeTeamFromKnowledgeGroup = async (
  knowledgeGroupId: string,
  teamId: string,
  params: {
    tenantId: string;
    userId: string;
  }
): Promise<void> => {
  const db = getDb();

  // Check if user has permission to update this group
  const group = await getKnowledgeGroupById(knowledgeGroupId, {
    tenantId: params.tenantId,
    userId: params.userId,
  });

  if (!group) {
    throw new Error(
      "Knowledge group not found or user does not have permission to update it"
    );
  }

  // Delete the assignment
  await db
    .delete(knowledgeGroupTeamAssignments)
    .where(
      and(
        eq(knowledgeGroupTeamAssignments.knowledgeGroupId, knowledgeGroupId),
        eq(knowledgeGroupTeamAssignments.teamId, teamId)
      )
    );
};

/**
 * Get all teams assigned to a knowledge group
 */
export const getTeamsForKnowledgeGroup = async (
  knowledgeGroupId: string,
  params: {
    tenantId: string;
    userId: string;
  }
): Promise<{ id: string; teamId: string; teamName: string | null }[]> => {
  const db = getDb();

  // Check if user has permission to view this group
  const group = await getKnowledgeGroupById(knowledgeGroupId, {
    tenantId: params.tenantId,
    userId: params.userId,
  });

  if (!group) {
    throw new Error(
      "Knowledge group not found or user does not have permission to view it"
    );
  }

  // Get all team assignments for this group
  const assignments = await db
    .select({
      id: knowledgeGroupTeamAssignments.id,
      teamId: knowledgeGroupTeamAssignments.teamId,
      teamName: teams.name,
    })
    .from(knowledgeGroupTeamAssignments)
    .leftJoin(teams, eq(knowledgeGroupTeamAssignments.teamId, teams.id))
    .where(
      eq(knowledgeGroupTeamAssignments.knowledgeGroupId, knowledgeGroupId)
    );

  return assignments.map((a) => ({
    id: a.id,
    teamId: a.teamId,
    teamName: a.teamName,
  }));
};
