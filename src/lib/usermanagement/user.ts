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
import { sendValidationPin } from "../auth/phone";

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
      lastOrganisationId: users.lastOrganisationId,
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
export const getUserByEmail = async (
  email: string,
  tenantId?: string
) => {
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
export const getUserOrganisations = async (userId: string) => {
  return await getDb()
    .select({
      tenantId: tenants.id,
      name: tenants.name,
      role: tenantMembers.role,
      joinedAt: tenantMembers.joinedAt,
    })
    .from(tenantMembers)
    .innerJoin(
      tenants,
      eq(tenants.id, tenantMembers.tenantId)
    )
    .where(eq(tenantMembers.userId, userId));
};

/**
 * Add a user to an tenant
 */
export const addUserToOrganisation = async (
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
export const removeUserFromOrganisation = async (
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
export const setUsersLastOrganisation = async (
  userId: string,
  tenantId?: string
) => {
  const usersOrganisations = await getUserOrganisations(userId);

  if (
    tenantId &&
    usersOrganisations.some((org) => org.tenantId === tenantId)
  ) {
    await getDb()
      .update(users)
      .set({ lastOrganisationId: tenantId })
      .where(eq(users.id, userId));
  } else {
    if (usersOrganisations.length > 0) {
      await getDb()
        .update(users)
        .set({ lastOrganisationId: usersOrganisations[0].tenantId })
        .where(eq(users.id, userId));
    } else {
      await getDb()
        .update(users)
        .set({ lastOrganisationId: null })
        .where(eq(users.id, userId));
    }
  }
};

/**
 * Set another tenant as the last selected tenant
 */
export const setAnotherOrganisationAsLast = async (
  userId: string,
  tenantIdThatCannotBeLast: string
) => {
  const usersLastOrganisation = await getDb()
    .select({
      lastOrganisationId: users.lastOrganisationId,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (
    usersLastOrganisation[0]?.lastOrganisationId ===
    tenantIdThatCannotBeLast
  ) {
    await setUsersLastOrganisation(userId);
  }
};

/**
 * Get the last selected tenant of a user
 * Will set the last selected tenant to the first tenant
 * if the user has no last selected tenant
 */
export const getUsersLastSelectedOrganisation = async (
  userId: string
): Promise<string> => {
  const user = await getUserById(userId);

  if (!user.lastOrganisationId) {
    const tenants = await getUserOrganisations(userId);
    if (tenants.length > 0) {
      await setUsersLastOrganisation(userId);
      return tenants[0].tenantId;
    } else {
      throw new Error("User has no tenants");
    }
  }

  return user.lastOrganisationId;
};
