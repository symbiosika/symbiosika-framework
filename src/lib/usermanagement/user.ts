import { getDb } from "../db/db-connection";
import { eq, and } from "drizzle-orm";
import {
  users,
  tenantMembers,
  tenants,
  teamMembers,
  teams,
  type UsersInsert,
} from "../db/schema/users";

/**
 * Get a user by its external id
 */
export const getUser = async (userId: string) => {
  const user = await getDb()
    .select({
      id: users.id,
    })
    .from(users)
    .where(eq(users.extUserId, userId));
  return user[0] ?? undefined;
};

/**
 * Get a user by its id
 */
export const getUserById = async (userId: string) => {
  const user = await getDb()
    .select({
      id: users.id,
      extUserId: users.extUserId,
      email: users.email,
      emailVerified: users.emailVerified,
      profileImageName: users.profileImageName,
      firstname: users.firstname,
      surname: users.surname,
      meta: users.meta,
      lastTenantId: users.lastTenantId,
      phoneNumber: users.phoneNumber,
      phoneNumberAsNumber: users.phoneNumberAsNumber,
      phoneNumberVerified: users.phoneNumberVerified,
      phonePinNumber: users.phonePinNumber,
    })
    .from(users)
    .where(eq(users.id, userId));
  return user[0] ?? undefined;
};

/**
 * Get a user by its email
 */
export const getUserByEmail = async (email: string, tenantId?: string) => {
  const q = getDb()
    .select({
      id: users.id,
      email: users.email,
      firstname: users.firstname,
      surname: users.surname,
    })
    .from(users)
    .where(eq(users.email, email))
    .$dynamic();

  if (tenantId) {
    q.innerJoin(
      tenantMembers,
      and(
        eq(tenantMembers.userId, users.id),
        eq(tenantMembers.tenantId, tenantId)
      )
    );
  }

  const user = await q;

  if (!user[0]) throw new Error("User not found");
  return user[0];
};

/**
 * Update a user
 * will also convert the phone number to a number
 */
export const updateUser = async (
  userId: string,
  data: Partial<UsersInsert>
) => {
  let phoneNumberAsNumber: number | undefined;

  // phoneNumber is a string like "+49 158 997779997"

  if (data.phoneNumber) {
    phoneNumberAsNumber = parseInt(
      data.phoneNumber.replace(/\s+/g, "").replace("+", "")
    );
  }

  // get actual user
  const user = await getUserById(userId);
  if (!user) {
    throw new Error("User not found");
  }

  // check if phone number has changed
  let phoneNumberChanged = false;
  if (user.phoneNumberAsNumber !== phoneNumberAsNumber) {
    phoneNumberChanged = true;
  }

  await getDb()
    .update(users)
    .set({
      ...data,
      phoneNumberAsNumber,
      phoneNumberVerified: phoneNumberChanged
        ? false
        : user.phoneNumberVerified,
    })
    .where(eq(users.id, userId));
};

/**
 * Get the tenants of a user
 */
export const getUserTenants = async (userId: string) => {
  return await getDb()
    .select({
      tenantId: tenants.id,
      name: tenants.name,
      role: tenantMembers.role,
      joinedAt: tenantMembers.joinedAt,
    })
    .from(tenantMembers)
    .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
    .where(eq(tenantMembers.userId, userId));
};

/**
 * Add a user to an tenant
 */
export const addUserToTenant = async (
  userId: string,
  tenantId: string,
  role: "admin" | "member" | "owner" = "member"
) => {
  await getDb().insert(tenantMembers).values({
    userId,
    tenantId,
    role,
  });
};

/**
 * Remove a user from an tenant
 */
export const removeUserFromTenant = async (
  userId: string,
  tenantId: string
) => {
  await getDb()
    .delete(tenantMembers)
    .where(
      and(
        eq(tenantMembers.userId, userId),
        eq(tenantMembers.tenantId, tenantId)
      )
    );
};

/**
 * Get the teams of a user
 */
export const getUserTeams = async (userId: string) => {
  return await getDb()
    .select({
      teamId: teams.id,
      teamName: teams.name,
      tenantId: teams.tenantId,
      role: teamMembers.role,
      joinedAt: teamMembers.joinedAt,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.userId, userId));
};

/**
 * Add a user to a team role of the user in the team
 */
export const addUserToTeam = async (
  userId: string,
  teamId: string,
  role: "admin" | "member" = "member"
) => {
  await getDb().insert(teamMembers).values({
    userId,
    teamId,
    role,
  });
};

/**
 * Remove a user from a team
 */
export const removeUserFromTeam = async (userId: string, teamId: string) => {
  await getDb()
    .delete(teamMembers)
    .where(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)));
};

/**
 * Set the last selected tenant of a user
 */
export const setUsersLastTenant = async (userId: string, tenantId?: string) => {
  const usersTenants = await getUserTenants(userId);

  if (tenantId && usersTenants.some((tenant) => tenant.tenantId === tenantId)) {
    await getDb()
      .update(users)
      .set({ lastTenantId: tenantId })
      .where(eq(users.id, userId));
  } else {
    if (usersTenants[0]) {
      await getDb()
        .update(users)
        .set({ lastTenantId: usersTenants[0].tenantId })
        .where(eq(users.id, userId));
    } else {
      await getDb()
        .update(users)
        .set({ lastTenantId: null })
        .where(eq(users.id, userId));
    }
  }
};

/**
 * Set another tenant as the last selected tenant
 */
export const setAnotherTenantAsLast = async (
  userId: string,
  tenantIdThatCannotBeLast: string
) => {
  const usersLastTenant = await getDb()
    .select({
      lastTenantId: users.lastTenantId,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (usersLastTenant[0]?.lastTenantId === tenantIdThatCannotBeLast) {
    await setUsersLastTenant(userId);
  }
};

/**
 * Get the last selected tenant of a user
 * Will set the last selected tenant to the first tenant
 * if the user has no last selected tenant
 */
export const getUsersLastSelectedTenant = async (
  userId: string
): Promise<string> => {
  const user = await getUserById(userId);
  if (!user) {
    throw new Error("User not found");
  }

  if (!user.lastTenantId) {
    const tenants = await getUserTenants(userId);
    const firstTenant = tenants[0];
    if (firstTenant) {
      await setUsersLastTenant(userId);
      return firstTenant.tenantId;
    } else {
      throw new Error("User has no tenants");
    }
  }

  return user.lastTenantId;
};
