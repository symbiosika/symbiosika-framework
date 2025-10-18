import { getDb } from "../db/db-connection";
import { eq, and } from "drizzle-orm";
import {
  userSpecificData,
  appSpecificData,
  organisationSpecificData,
  teamSpecificData,
  type UserSpecificDataInsert,
  type AppSpecificDataInsert,
  type OrganisationSpecificDataInsert,
  type TeamSpecificDataInsert,
  type UserSpecificDataSelect,
  type AppSpecificDataSelect,
  type OrganisationSpecificDataSelect,
  type TeamSpecificDataSelect,
} from "../db/schema/additional-data";

// User Specific Data CRUD
export const createUserSpecificData = async (data: UserSpecificDataInsert) => {
  const result = await getDb()
    .insert(userSpecificData)
    .values(data)
    .returning();
  return result[0];
};

export const getUserSpecificData = async (userId: string, key: string) => {
  const data = await getDb()
    .select()
    .from(userSpecificData)
    .where(
      and(eq(userSpecificData.userId, userId), eq(userSpecificData.key, key))
    );
  if (data.length === 0) {
    throw new Error("User specific data not found");
  }
  return data[0];
};

export const updateUserSpecificData = async (
  id: string,
  userId: string,
  key: string,
  data: Partial<UserSpecificDataSelect>
) => {
  const result = await getDb()
    .update(userSpecificData)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(userSpecificData.id, id),
        eq(userSpecificData.userId, userId),
        eq(userSpecificData.key, key)
      )
    )
    .returning();
  return result[0];
};

export const deleteUserSpecificData = async (id: string, userId: string) => {
  await getDb()
    .delete(userSpecificData)
    .where(
      and(eq(userSpecificData.id, id), eq(userSpecificData.userId, userId))
    );
};

// App Specific Data CRUD
export const createAppSpecificData = async (data: AppSpecificDataInsert) => {
  const result = await getDb().insert(appSpecificData).values(data).returning();
  return result[0];
};

export const getAppSpecificData = async (key: string) => {
  const data = await getDb()
    .select()
    .from(appSpecificData)
    .where(eq(appSpecificData.key, key));
  if (data.length === 0) {
    throw new Error("App specific data not found");
  }
  return data[0];
};

export const updateAppSpecificData = async (
  key: string,
  data: Partial<AppSpecificDataSelect>
) => {
  const result = await getDb()
    .update(appSpecificData)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(and(eq(appSpecificData.key, key)))
    .returning();
  return result[0];
};

export const deleteAppSpecificData = async (key: string) => {
  await getDb().delete(appSpecificData).where(eq(appSpecificData.key, key));
};

// Organisation Specific Data CRUD
export const createOrganisationSpecificData = async (
  data: OrganisationSpecificDataInsert
) => {
  const result = await getDb()
    .insert(organisationSpecificData)
    .values(data)
    .returning();
  return result[0];
};

export const getOrganisationSpecificData = async (
  organisationId: string,
  key: string
) => {
  const data = await getDb()
    .select()
    .from(organisationSpecificData)
    .where(
      and(
        eq(organisationSpecificData.organisationId, organisationId),
        eq(organisationSpecificData.key, key)
      )
    );
  if (data.length === 0) {
    throw new Error("Organisation specific data not found");
  }
  return data[0];
};

export const updateOrganisationSpecificData = async (
  organisationId: string,
  key: string,
  data: Partial<OrganisationSpecificDataSelect>
) => {
  const result = await getDb()
    .update(organisationSpecificData)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(organisationSpecificData.organisationId, organisationId),
        eq(organisationSpecificData.key, key)
      )
    )
    .returning();
  return result[0];
};

export const deleteOrganisationSpecificData = async (
  organisationId: string,
  key: string
) => {
  await getDb()
    .delete(organisationSpecificData)
    .where(
      and(
        eq(organisationSpecificData.organisationId, organisationId),
        eq(organisationSpecificData.key, key)
      )
    );
};

// Team Specific Data CRUD
export const createTeamSpecificData = async (data: TeamSpecificDataInsert) => {
  const result = await getDb()
    .insert(teamSpecificData)
    .values(data)
    .returning();
  return result[0];
};

export const getTeamSpecificData = async (teamId: string, key: string) => {
  const data = await getDb()
    .select()
    .from(teamSpecificData)
    .where(
      and(eq(teamSpecificData.teamId, teamId), eq(teamSpecificData.key, key))
    );
  if (data.length === 0) {
    throw new Error("Team specific data not found");
  }
  return data[0];
};

export const updateTeamSpecificData = async (
  teamId: string,
  key: string,
  data: Partial<TeamSpecificDataSelect>
) => {
  const result = await getDb()
    .update(teamSpecificData)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(
      and(eq(teamSpecificData.teamId, teamId), eq(teamSpecificData.key, key))
    )
    .returning();
  return result[0];
};

export const deleteTeamSpecificData = async (teamId: string, key: string) => {
  await getDb()
    .delete(teamSpecificData)
    .where(
      and(eq(teamSpecificData.teamId, teamId), eq(teamSpecificData.key, key))
    );
};
