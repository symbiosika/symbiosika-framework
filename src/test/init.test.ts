import { generateJwt, saltAndHashPassword } from "../lib/auth";
import { createDatabaseClient, getDb } from "../lib/db/db-connection";
import { waitForDbConnection } from "../lib/db/db-connection";
import {
  users,
  organisations,
  type UsersSelect,
  teamMembers,
  organisationMembers,
  invitationCodes,
  aiProviderModels,
  teams,
  type AiProviderModelsInsert,
  organisationSpecificData,
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
//   organisationId: TEST_ORGANISATION_1.id,
// };

// export const TEST_TEAM_2 = {
//   id: "00000000-3333-3333-3333-000000000002",
//   name: "Test Team 2",
//   organisationId: TEST_ORGANISATION_1.id,
// };

// export const TEST_TEAM_3 = {
//   id: "00000000-3333-3333-3333-000000000003",
//   name: "Test Team 3",
//   organisationId: TEST_ORGANISATION_1.id,
// };

export const TEST_MODEL_1: AiProviderModelsInsert = {
  id: "00000000-0000-0000-0000-000000000001",
  organisationId: TEST_ORGANISATION_1.id,
  name: "openai:gpt-4o-mini",
  provider: "openai",
  model: "gpt-4o-mini",
  inputType: ["text"],
  outputType: ["text"],
  label: "GPT-4o-mini (Test Model)",
  description: "Test model for OpenAI GPT-4o-mini",
  maxTokens: 16000,
  maxOutputTokens: 4000,
  endpoint: "https://api.openai.com/v1",
  endpointCompatibility: "openai",
  hostingOrigin: "openai",
  usesInternet: true,
  active: true,
  system: false,
};

export const TEST_MODEL_2: AiProviderModelsInsert = {
  id: "00000000-0000-0000-0000-000000000002",
  organisationId: TEST_ORGANISATION_1.id,
  name: "ionos:llama-3.1-8b-instruct",
  provider: "ionos",
  model: "llama-3.1-8b-instruct",
  inputType: ["text"],
  outputType: ["text"],
  label: "Llama-3.1-8b-instruct (Test Model)",
  description: "Test model for Ionos Llama-3.1-8b-instruct",
  maxTokens: 16000,
  maxOutputTokens: 4000,
  endpoint: "https://api.ionos.com/v1",
  endpointCompatibility: "openai",
  hostingOrigin: "ionos",
  usesInternet: true,
  active: true,
  system: false,
};

export const TEST_EMBEDDING_MODEL: AiProviderModelsInsert = {
  id: "00000000-0000-0000-0000-000000000003",
  organisationId: TEST_ORGANISATION_1.id,
  name: "openai:text-embedding-3-small",
  provider: "openai",
  model: "text-embedding-3-small",
  inputType: ["text"],
  outputType: ["embedding"],
  label: "Text-embedding-3-small (Test Model)",
  description: "Test model for OpenAI Text-embedding-3-small",
  maxTokens: 16000,
  maxOutputTokens: 4000,
  endpoint: "https://api.openai.com/v1",
  endpointCompatibility: "openai",
  hostingOrigin: "openai",
  usesInternet: true,
  active: true,
  system: false,
};

export const deleteTestOrganisations = async () => {
  await getDb()
    .delete(organisations)
    .where(
      inArray(organisations.id, [
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
  // delete all old organisations and ALL their data
  await deleteTestOrganisations();

  for (const org of TEST_ORGANISATIONS) {
    await getDb().insert(organisations).values({
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
    .delete(organisationMembers)
    .where(
      inArray(organisationMembers.userId, [
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
 * Drop all Test AI Provider Models
 */
export const dropAllTestAiProviderModels = async () => {
  await getDb()
    .delete(aiProviderModels)
    .where(
      or(
        eq(aiProviderModels.organisationId, TEST_ORGANISATION_1.id),
        eq(aiProviderModels.organisationId, TEST_ORGANISATION_2.id),
        eq(aiProviderModels.organisationId, TEST_ORGANISATION_3.id)
      )
    );
};

/**
 * Drop user-, organisation-, and app-specific data
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
    .delete(organisationSpecificData)
    .where(
      inArray(organisationSpecificData.organisationId, [
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
    .delete(organisationMembers)
    .where(
      inArray(organisationMembers.userId, [
        TEST_ORG1_USER_1.id,
        TEST_ORG1_USER_2.id,
        TEST_ORG1_USER_3.id,
        TEST_ORG2_USER_1.id,
        TEST_ORG3_USER_1.id,
      ])
    );

  // all the users to their own organisations
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

  // add admin to all organisations
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
 * Init all Test AI Models
 */
export const initTestAiModels = async () => {
  // Drop existing test models first
  await dropAllTestAiProviderModels();

  // Insert OpenAI PGT-40-mini for testing
  await getDb()
    .insert(aiProviderModels)
    .values([TEST_MODEL_1, TEST_MODEL_2, TEST_EMBEDDING_MODEL])
    .onConflictDoNothing();
};

/**
 * GLOBAL Init global test data
 */
export const initTests = async () => {
  await createDatabaseClient();
  await waitForDbConnection();

  await initTestOrganisations().catch((err) => {
    console.info("Error initialising test organisations", err);
  });
  await initTestUsers().catch((err) => {
    console.info("Error initialising test users", err);
  });
  await initTestOrganisationMembers().catch((err) => {
    console.info("Error initialising test organisation members", err);
  });
  await dropAllInvitationsCodes().catch((err) => {
    console.info("Error dropping invitation codes", err);
  });
  await initTestAiModels().catch((err) => {
    console.info("Error initialising test AI models", err);
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
