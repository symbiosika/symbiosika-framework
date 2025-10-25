import { generateJwt, saltAndHashPassword } from "../lib/auth";
import { createDatabaseClient, getDb } from "../lib/db/db-connection";
import { waitForDbConnection } from "../lib/db/db-connection";
import {
  users,
  tenants,
  type UsersSelect,
  teamMembers,
  tenantMembers,
  invitationCodes,
  teams,
  tenantSpecificData,
  userSpecificData,
  appSpecificData,
} from "../lib/db/db-schema";
import { and, eq, inArray, or } from "drizzle-orm";
import { addOrganisationMember } from "../lib/usermanagement/oganisations";

/**
 * FIXED TESTING DATA
 */
export const TEST_PRODUCT_ID = "prod_RBdEBlCP5LtR3O";
export const TEST_PRICE_ID = "price_1QJFyIISOodfhgtvh0yJbAyt";

export const TEST_PASSWORD = "gFskj6Dn6gFskj6Dn6";

export const TEST_ORGANISATION_1 = {
  id: "00000000-1111-1111-1111-000000000001",
  name: "Test Organisation 1",
};

export const TEST_ORGANISATION_2 = {
  id: "00000000-1111-1111-1111-000000000002",
  name: "Test Organisation 2",
};

export const TEST_ORGANISATION_3 = {
  id: "00000000-1111-1111-1111-000000000003",
  name: "Test Organisation 3",
};

export const TEST_ORGANISATIONS = [
  TEST_ORGANISATION_1,
  TEST_ORGANISATION_2,
  TEST_ORGANISATION_3,
];

export const TEST_ADMIN_USER = {
  id: "00000000-0000-0000-0000-000000000000",
  email: "admin@symbiosika.com",
  firstname: "Joe",
  surname: "Doe",
  password: TEST_PASSWORD,
};

export const TEST_ORG1_USER_1 = {
  id: "00000000-2222-2222-2222-000000000001",
  email: "testuser1@symbiosika.com",
  firstname: "Test",
  surname: "User 1",
  password: TEST_PASSWORD,
};

export const TEST_ORG1_USER_2 = {
  id: "00000000-2222-2222-2222-000000000021",
  email: "testuser12@symbiosika.com",
  firstname: "Test",
  surname: "User 2",
  password: TEST_PASSWORD,
};

export const TEST_ORG1_USER_3 = {
  id: "00000000-2222-2222-2222-000000000031",
  email: "testuser13@symbiosika.com",
  firstname: "Test",
  surname: "User 3",
  password: TEST_PASSWORD,
};

export const TEST_ORG2_USER_1 = {
  id: "00000000-2222-2222-2222-000000000002",
  email: "testuser2@symbiosika.com",
  firstname: "Test",
  surname: "User 2",
  password: TEST_PASSWORD,
};

export const TEST_ORG3_USER_1 = {
  id: "00000000-2222-2222-2222-000000000003",
  email: "testuser3@symbiosika.com",
  firstname: "Test",
  surname: "User 3",
  password: TEST_PASSWORD,
};

export const TEST_USERS = [
  TEST_ORG1_USER_1,
  TEST_ORG1_USER_2,
  TEST_ORG1_USER_3,
  TEST_ORG2_USER_1,
  TEST_ORG3_USER_1,
  TEST_ADMIN_USER,
];

// export const TEST_TEAM_1 = {
//   id: "00000000-3333-3333-3333-000000000001",
//   name: "Test Team 1",
//   tenantId: TEST_ORGANISATION_1.id,
// };

// export const TEST_TEAM_2 = {
//   id: "00000000-3333-3333-3333-000000000002",
//   name: "Test Team 2",
//   tenantId: TEST_ORGANISATION_1.id,
// };

// export const TEST_TEAM_3 = {
//   id: "00000000-3333-3333-3333-000000000003",
//   name: "Test Team 3",
//   tenantId: TEST_ORGANISATION_1.id,
// };

export const deleteTestOrganisations = async () => {
  await getDb()
    .delete(tenants)
    .where(
      inArray(tenants.id, [
        TEST_ORGANISATION_1.id,
        TEST_ORGANISATION_2.id,
        TEST_ORGANISATION_3.id,
      ])
    );
};
/**
 * Init all Test Organisations
 */
export const initTestOrganisations = async () => {
  // delete all old tenants and ALL their data
  await deleteTestOrganisations();

  for (const org of TEST_ORGANISATIONS) {
    await getDb().insert(tenants).values({
      id: org.id,
      name: org.name,
    });
  }
};

/**
 * Init all Test Users
 */
export const initTestUsers = async () => {
  for (const user of TEST_USERS) {
    const hash = await saltAndHashPassword(user.password);
    await getDb()
      .insert(users)
      .values({
        ...user,
        password: hash,
        emailVerified: true,
      })
      .onConflictDoUpdate({
        target: [users.id],
        set: {
          password: hash,
          emailVerified: true,
        },
      });
  }
};

/**
 * Drop all Test Organisation Members
 */
export const dropAllTestOrganisationMembers = async () => {
  await getDb()
    .delete(tenantMembers)
    .where(
      inArray(tenantMembers.userId, [
        TEST_ORG1_USER_1.id,
        TEST_ORG1_USER_2.id,
        TEST_ORG1_USER_3.id,
        TEST_ORG2_USER_1.id,
        TEST_ORG3_USER_1.id,
      ])
    );
};

/**
 * Drop all Test Team Members
 */
export const dropAllTestTeamMembers = async () => {
  await getDb()
    .delete(teamMembers)
    .where(
      inArray(teamMembers.userId, [
        TEST_ORG1_USER_1.id,
        TEST_ORG1_USER_2.id,
        TEST_ORG1_USER_3.id,
        TEST_ORG2_USER_1.id,
        TEST_ORG3_USER_1.id,
      ])
    );
};

/**
 * Drop user-, tenant-, and app-specific data
 */
export const dropAllUserAndOrganisationSpecificData = async () => {
  await getDb()
    .delete(userSpecificData)
    .where(
      inArray(userSpecificData.userId, [
        TEST_ORG1_USER_1.id,
        TEST_ORG2_USER_1.id,
        TEST_ORG3_USER_1.id,
      ])
    );
  await getDb()
    .delete(tenantSpecificData)
    .where(
      inArray(tenantSpecificData.tenantId, [
        TEST_ORGANISATION_1.id,
        TEST_ORGANISATION_2.id,
        TEST_ORGANISATION_3.id,
      ])
    );
  await getDb().delete(appSpecificData);
};

/**
 * Init all Test Organisation Members
 */
export const initTestOrganisationMembers = async () => {
  await dropAllTestOrganisationMembers();
  await dropAllTestTeamMembers();

  // delte all old memberships
  await getDb()
    .delete(tenantMembers)
    .where(
      inArray(tenantMembers.userId, [
        TEST_ORG1_USER_1.id,
        TEST_ORG1_USER_2.id,
        TEST_ORG1_USER_3.id,
        TEST_ORG2_USER_1.id,
        TEST_ORG3_USER_1.id,
      ])
    );

  // all the users to their own tenants
  await addOrganisationMember(
    TEST_ORGANISATION_1.id,
    TEST_ORG1_USER_1.id,
    "owner"
  );
  await addOrganisationMember(
    TEST_ORGANISATION_1.id,
    TEST_ORG1_USER_2.id,
    "member"
  );
  await addOrganisationMember(
    TEST_ORGANISATION_1.id,
    TEST_ORG1_USER_3.id,
    "member"
  );

  await addOrganisationMember(
    TEST_ORGANISATION_2.id,
    TEST_ORG2_USER_1.id,
    "owner"
  );
  await addOrganisationMember(
    TEST_ORGANISATION_3.id,
    TEST_ORG3_USER_1.id,
    "owner"
  );

  // add admin to all tenants
  await addOrganisationMember(
    TEST_ORGANISATION_1.id,
    TEST_ADMIN_USER.id,
    "owner"
  );
  await addOrganisationMember(
    TEST_ORGANISATION_2.id,
    TEST_ADMIN_USER.id,
    "owner"
  );
  await addOrganisationMember(
    TEST_ORGANISATION_3.id,
    TEST_ADMIN_USER.id,
    "owner"
  );
};

/**
 * Drop all invitations codes
 */
export const dropAllInvitationsCodes = async () => {
  await getDb().delete(invitationCodes);
};

/**
 * Get a JWT token for a test user
 */
const getJwtTokenForTesting = async (email: string) => {
  const user = TEST_USERS.find((user) => user.email === email);
  if (!user) {
    throw new Error("User not found");
  }

  const { token } = await generateJwt(
    {
      email: user.email,
      id: user.id,
    } as UsersSelect,
    86400
  );
  return token;
};

/**
 * GLOBAL Init global test data
 */
export const initTests = async () => {
  await createDatabaseClient();
  await waitForDbConnection();

  await initTestOrganisations().catch((err) => {
    console.info("Error initialising test tenants", err);
  });
  await initTestUsers().catch((err) => {
    console.info("Error initialising test users", err);
  });
  await initTestOrganisationMembers().catch((err) => {
    console.info("Error initialising test tenant members", err);
  });
  await dropAllInvitationsCodes().catch((err) => {
    console.info("Error dropping invitation codes", err);
  });

  const user1Token = await getJwtTokenForTesting(TEST_ORG1_USER_1.email);
  const user2Token = await getJwtTokenForTesting(TEST_ORG2_USER_1.email);
  const user3Token = await getJwtTokenForTesting(TEST_ORG3_USER_1.email);
  const adminToken = await getJwtTokenForTesting(TEST_ADMIN_USER.email);

  return {
    user1Token,
    user2Token,
    user3Token,
    adminToken,
    password: TEST_PASSWORD,
  };
};
