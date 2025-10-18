import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  initTests,
  TEST_ADMIN_USER,
  TEST_ORGANISATION_1,
  TEST_ORG1_USER_1,
} from "../../test/init.test";
import {
  generateApiToken,
  hashToken,
  createApiToken,
  searchForToken,
  verifyApiTokenAndGetJwt,
  revokeApiToken,
  listApiTokensForUser,
} from "./token-auth";

beforeAll(async () => {
  await initTests();
});

describe("Token Authentication", () => {
  describe("generateApiToken", () => {
    test("should generate a token of correct length", () => {
      const token = generateApiToken();
      expect(token.length).toBe(32);
      expect(typeof token).toBe("string");
    });
  });

  describe("hashToken", () => {
    test("should generate consistent hash for same input", () => {
      const token = "test-token";
      const hash1 = hashToken(token);
      const hash2 = hashToken(token);
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64); // SHA-256 produces 64 hex characters
    });
  });

  describe("createApiToken", () => {
    test("should create a new API token", async () => {
      const result = await createApiToken({
        name: "Test Token",
        userId: TEST_ORG1_USER_1.id,
        organisationId: TEST_ORGANISATION_1.id,
        scopes: ["user:read", "user:write"],
      });

      expect(result.token).toBeDefined();
      expect(result.token.length).toBe(32);
    });

    test("should create a token with expiration", async () => {
      const result = await createApiToken({
        name: "Expiring Token",
        userId: TEST_ORG1_USER_1.id,
        organisationId: TEST_ORGANISATION_1.id,
        scopes: ["user:read"],
        expiresIn: 5, // 5 minutes
      });

      expect(result.token).toBeDefined();
    });
  });

  describe("searchForToken", () => {
    test("should find a valid token", async () => {
      const { token } = await createApiToken({
        name: "Search Test Token",
        userId: TEST_ORG1_USER_1.id,
        organisationId: TEST_ORGANISATION_1.id,
        scopes: ["user:read"],
      });

      const result = await searchForToken(token);
      expect(result).toBeDefined();
      expect(result.name).toBe("Search Test Token");
    });

    test("should throw error for invalid token", async () => {
      try {
        await searchForToken("invalid-token");
        expect(true).toBe(false); // Should not reach here
      } catch (e: any) {
        expect(e.message).toBe("Invalid or expired API token");
      }
    });
  });

  describe("verifyApiTokenAndGetJwt", () => {
    test("should verify token and return JWT", async () => {
      const { token } = await createApiToken({
        name: "JWT Test Token",
        userId: TEST_ORG1_USER_1.id,
        organisationId: TEST_ORGANISATION_1.id,
        scopes: ["user:read", "user:write"],
      });

      const result = await verifyApiTokenAndGetJwt(token);
      expect(result.token).toBeDefined();
      expect(result.expiresAt).toBeDefined();
    });

    test("should verify token with specific scopes", async () => {
      const { token } = await createApiToken({
        name: "Scope Test Token",
        userId: TEST_ORG1_USER_1.id,
        organisationId: TEST_ORGANISATION_1.id,
        scopes: ["user:read", "user:write"],
      });

      const result = await verifyApiTokenAndGetJwt(token, ["user:read"]);
      expect(result.token).toBeDefined();
    });

    test("should throw error for insufficient scopes", async () => {
      const { token } = await createApiToken({
        name: "Scope Test Token",
        userId: TEST_ORG1_USER_1.id,
        organisationId: TEST_ORGANISATION_1.id,
        scopes: ["user:read"],
      });

      try {
        await verifyApiTokenAndGetJwt(token, ["user:write"]);
        expect(true).toBe(false); // Should not reach here
      } catch (e: any) {
        expect(e.message).toBe("Insufficient permissions");
      }
    });
  });

  describe("revokeApiToken", () => {
    test("should revoke an API token", async () => {
      const { token } = await createApiToken({
        name: "Revoke Test Token",
        userId: TEST_ORG1_USER_1.id,
        organisationId: TEST_ORGANISATION_1.id,
        scopes: ["user:read"],
      });

      const tokenRecord = await searchForToken(token);
      await revokeApiToken(tokenRecord.id, TEST_ORG1_USER_1.id);

      try {
        await searchForToken(token);
        expect(true).toBe(false); // Should not reach here
      } catch (e: any) {
        expect(e.message).toBe("Invalid or expired API token");
      }
    });
  });

  describe("listApiTokensForUser", () => {
    test("should list all tokens for a user", async () => {
      // Create multiple tokens for the user
      await createApiToken({
        name: "List Test Token 1",
        userId: TEST_ORG1_USER_1.id,
        organisationId: TEST_ORGANISATION_1.id,
        scopes: ["user:read"],
      });

      await createApiToken({
        name: "List Test Token 2",
        userId: TEST_ORG1_USER_1.id,
        organisationId: TEST_ORGANISATION_1.id,
        scopes: ["user:write"],
      });

      const tokens = await listApiTokensForUser(TEST_ORG1_USER_1.id);
      expect(tokens.length).toBeGreaterThanOrEqual(2);
      expect(tokens[0].name).toBeDefined();
      expect(tokens[0].scopes).toBeDefined();
    });
  });
});
