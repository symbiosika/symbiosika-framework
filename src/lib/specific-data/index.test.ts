import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  initTests,
  TEST_ADMIN_USER,
  TEST_ORGANISATION_1,
  TEST_ORG1_USER_1,
  dropAllUserAndOrganisationSpecificData,
} from "../../test/init.test";
import {
  createUserSpecificData,
  getUserSpecificData,
  updateUserSpecificData,
  deleteUserSpecificData,
  createAppSpecificData,
  getAppSpecificData,
  updateAppSpecificData,
  deleteAppSpecificData,
  createOrganisationSpecificData,
  getOrganisationSpecificData,
  updateOrganisationSpecificData,
  deleteOrganisationSpecificData,
  createTeamSpecificData,
  getTeamSpecificData,
  updateTeamSpecificData,
  deleteTeamSpecificData,
} from "./index";
import { testing_createTeamAndAddUsers } from "../../test/permissions.test";

let TEST_TEAM_ID: string;

beforeAll(async () => {
  await initTests();
  await dropAllUserAndOrganisationSpecificData();

  const { teamId } = await testing_createTeamAndAddUsers(
    TEST_ORGANISATION_1.id,
    [TEST_ORG1_USER_1.id]
  );
  TEST_TEAM_ID = teamId;
});

describe("User Specific Data", () => {
  const testData = {
    userId: TEST_ORG1_USER_1.id,
    key: "test-key",
    data: { value: "test-value" },
  };

  test("should create and retrieve user specific data", async () => {
    const created = await createUserSpecificData(testData);
    expect(created).toBeDefined();
    expect(created.userId).toBe(TEST_ORG1_USER_1.id);
    expect(created.key).toBe(testData.key);
    expect(created.data).toEqual(testData.data);

    const retrieved = await getUserSpecificData(TEST_ORG1_USER_1.id, testData.key);
    expect(retrieved).toEqual(created);
  });

  test("should update user specific data", async () => {
    const created = await createUserSpecificData({
      ...testData,
      key: "update-key",
    });
    const updated = await updateUserSpecificData(
      created.id,
      TEST_ORG1_USER_1.id,
      "update-key",
      {
        data: { value: "updated-value" },
      }
    );
    expect(updated.data).toEqual({ value: "updated-value" });
  });

  test("should delete user specific data", async () => {
    const created = await createUserSpecificData({
      ...testData,
      key: "delete-key",
    });
    await deleteUserSpecificData(created.id, TEST_ORG1_USER_1.id);

    try {
      await getUserSpecificData(TEST_ORG1_USER_1.id, "delete-key");
      expect(true).toBe(false); // Should not reach here
    } catch (e: any) {
      expect(e.message).toBe("User specific data not found");
    }
  });
});

describe("App Specific Data", () => {
  const testData = {
    key: "test-key",
    data: { value: "test-value" },
  };

  test("should create and retrieve app specific data", async () => {
    const created = await createAppSpecificData(testData);
    expect(created).toBeDefined();
    expect(created.key).toBe(testData.key);
    expect(created.data).toEqual(testData.data);

    const retrieved = await getAppSpecificData(testData.key);
    expect(retrieved).toEqual(created);
  });

  test("should update app specific data", async () => {
    const created = await createAppSpecificData({
      ...testData,
      key: "update-key",
    });
    const updated = await updateAppSpecificData("update-key", {
      data: { value: "updated-value" },
    });
    expect(updated.data).toEqual({ value: "updated-value" });
  });

  test("should delete app specific data", async () => {
    const created = await createAppSpecificData({
      ...testData,
      key: "delete-key",
    });
    await deleteAppSpecificData("delete-key");

    try {
      await getAppSpecificData("delete-key");
      expect(true).toBe(false); // Should not reach here
    } catch (e: any) {
      expect(e.message).toBe("App specific data not found");
    }
  });
});

describe("Organisation Specific Data", () => {
  const testData = {
    organisationId: TEST_ORGANISATION_1.id,
    key: "test-key",
    data: { value: "test-value" },
  };

  test("should create and retrieve organisation specific data", async () => {
    const created = await createOrganisationSpecificData(testData);
    expect(created).toBeDefined();
    expect(created.organisationId).toBe(TEST_ORGANISATION_1.id);
    expect(created.key).toBe(testData.key);
    expect(created.data).toEqual(testData.data);

    const retrieved = await getOrganisationSpecificData(
      TEST_ORGANISATION_1.id,
      testData.key
    );
    expect(retrieved).toEqual(created);
  });

  test("should update organisation specific data", async () => {
    const created = await createOrganisationSpecificData({
      ...testData,
      key: "update-key",
    });
    const updated = await updateOrganisationSpecificData(
      TEST_ORGANISATION_1.id,
      "update-key",
      {
        data: { value: "updated-value" },
      }
    );
    expect(updated.data).toEqual({ value: "updated-value" });
  });

  test("should delete organisation specific data", async () => {
    const created = await createOrganisationSpecificData({
      ...testData,
      key: "delete-key",
    });
    await deleteOrganisationSpecificData(TEST_ORGANISATION_1.id, "delete-key");

    try {
      await getOrganisationSpecificData(TEST_ORGANISATION_1.id, "delete-key");
      expect(true).toBe(false); // Should not reach here
    } catch (e: any) {
      expect(e.message).toBe("Organisation specific data not found");
    }
  });
});

describe("Team Specific Data", () => {
  const testData = {
    teamId: TEST_TEAM_ID,
    key: "test-key",
    data: { value: "test-value" },
  };

  test("should create and retrieve team specific data", async () => {
    const created = await createTeamSpecificData(testData);
    expect(created).toBeDefined();
    expect(created.teamId).toBe(TEST_TEAM_ID);
    expect(created.key).toBe(testData.key);
    expect(created.data).toEqual(testData.data);

    const retrieved = await getTeamSpecificData(TEST_TEAM_ID, testData.key);
    expect(retrieved).toEqual(created);
  });

  test("should update team specific data", async () => {
    const created = await createTeamSpecificData({
      ...testData,
      key: "update-key",
    });
    const updated = await updateTeamSpecificData(TEST_TEAM_ID, "update-key", {
      data: { value: "updated-value" },
    });
    expect(updated.data).toEqual({ value: "updated-value" });
  });

  test("should delete team specific data", async () => {
    const created = await createTeamSpecificData({
      ...testData,
      key: "delete-key",
    });
    await deleteTeamSpecificData(TEST_TEAM_ID, "delete-key");

    try {
      await getTeamSpecificData(TEST_TEAM_ID, "delete-key");
      expect(true).toBe(false); // Should not reach here
    } catch (e: any) {
      expect(e.message).toBe("Team specific data not found");
    }
  });
});
