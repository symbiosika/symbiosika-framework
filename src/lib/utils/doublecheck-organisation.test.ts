import { describe, test, expect } from "bun:test";
import { validateOrganisationId } from "./doublecheck-organisation";

describe("validateOrganisationId", () => {
  test("should pass when organisationId matches", () => {
    const data = { organisationId: "123" };
    const organisationId = "123";

    // Should not throw an error
    expect(() => validateOrganisationId(data, organisationId)).not.toThrow();
  });

  test("should throw error when organisationId is missing in data", () => {
    const data = {};
    const organisationId = "123";

    try {
      validateOrganisationId(data, organisationId);
      expect(true).toBe(false); // This line should not be reached
    } catch (e: any) {
      expect(e).toBeInstanceOf(Error);
      expect(e.message).toBe(
        'Parameter "organisationId" in body does not match URL parameter'
      );
    }
  });

  test("should throw error when organisationId does not match", () => {
    const data = { organisationId: "123" };
    const organisationId = "456";

    try {
      validateOrganisationId(data, organisationId);
      expect(true).toBe(false); // This line should not be reached
    } catch (e: any) {
      expect(e).toBeInstanceOf(Error);
      expect(e.message).toBe(
        'Parameter "organisationId" in body does not match URL parameter'
      );
    }
  });
});
