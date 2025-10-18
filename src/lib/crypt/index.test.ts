import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  initTests,
  TEST_ADMIN_USER,
  TEST_ORGANISATION_1,
} from "../../test/init.test";
import {
  isValidSecretName,
  setSecret,
  getSecret,
  deleteSecret,
  getSecrets,
} from "./index";

beforeAll(async () => {
  await initTests();
});

describe("Crypt Module Tests", () => {
  describe("isValidSecretName", () => {
    test("should accept valid secret names", () => {
      expect(isValidSecretName("API_KEY")).toBe(true);
      expect(isValidSecretName("DB_PASSWORD_123")).toBe(true);
      expect(isValidSecretName("JWT_SECRET_2024")).toBe(true);
    });

    test("should reject invalid secret names", () => {
      expect(isValidSecretName("api-key")).toBe(false);
      expect(isValidSecretName("DB Password")).toBe(false);
      expect(isValidSecretName("secret@123")).toBe(false);
      expect(isValidSecretName("")).toBe(false);
    });
  });

  describe("setSecret", () => {
    test("should set a new secret", async () => {
      const result = await setSecret({
        name: "TEST_SECRET",
        value: "test-value",
        organisationId: TEST_ORGANISATION_1.id,
      });

      expect(result.name).toBe("TEST_SECRET");
      expect(result.value).toBe(""); // Value should be empty in response
      expect(result.organisationId).toBeTruthy(); // Just check if it exists
    });

    test("should update existing secret", async () => {
      // First set a secret
      await setSecret({
        name: "UPDATE_SECRET",
        value: "initial-value",
        organisationId: TEST_ORGANISATION_1.id,
      });

      // Then update it
      const result = await setSecret({
        name: "UPDATE_SECRET",
        value: "updated-value",
        organisationId: TEST_ORGANISATION_1.id,
      });

      expect(result.name).toBe("UPDATE_SECRET");
      expect(result.value).toBe(""); // Value should be empty in response
    });

    test("should throw error for invalid secret name", async () => {
      try {
        await setSecret({
          name: "invalid-name",
          value: "test-value",
          organisationId: TEST_ORGANISATION_1.id,
        });
        throw new Error("Should have thrown an error");
      } catch (e: any) {
        expect(e).toBeInstanceOf(Error);
        expect(e.message).toContain("Invalid secret name");
      }
    });
  });

  describe("getSecret", () => {
    test("should retrieve a secret", async () => {
      // First set a secret
      await setSecret({
        name: "GET_SECRET",
        value: "secret-value",
        organisationId: TEST_ORGANISATION_1.id,
      });

      // Then retrieve it
      const value = await getSecret("GET_SECRET", TEST_ORGANISATION_1.id);
      expect(value).toBe("secret-value");
    });

    test("should return null for non-existent secret", async () => {
      const value = await getSecret(
        "NON_EXISTENT_SECRET",
        TEST_ORGANISATION_1.id
      );
      expect(value).toBeNull();
    });
  });

  describe("deleteSecret", () => {
    test("should delete a secret", async () => {
      // First set a secret
      await setSecret({
        name: "DELETE_SECRET",
        value: "secret-value",
        organisationId: TEST_ORGANISATION_1.id,
      });

      // Then delete it
      const result = await deleteSecret(
        "DELETE_SECRET",
        TEST_ORGANISATION_1.id
      );
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].name).toBe("DELETE_SECRET");

      // Verify it's deleted
      const value = await getSecret("DELETE_SECRET", TEST_ORGANISATION_1.id);
      expect(value).toBeNull();
    });
  });

  describe("getSecrets", () => {
    test("should list all secrets for an organisation", async () => {
      // First set some secrets
      await setSecret({
        name: "LIST_SECRET_1",
        value: "value1",
        organisationId: TEST_ORGANISATION_1.id,
      });

      await setSecret({
        name: "LIST_SECRET_2",
        value: "value2",
        organisationId: TEST_ORGANISATION_1.id,
      });

      // Get all secrets
      const secrets = await getSecrets(TEST_ORGANISATION_1.id);
      expect(secrets.length).toBeGreaterThanOrEqual(2);
      expect(secrets.some((s) => s.name === "LIST_SECRET_1")).toBe(true);
      expect(secrets.some((s) => s.name === "LIST_SECRET_2")).toBe(true);
    });
  });
});
