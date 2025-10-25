import { describe, test, expect } from "bun:test";
import { validateOrganisationId } from "./doublecheck-tenant";

describe("validateOrganisationId", () => {
  test("should pass when tenantId matches", () => {
    const data = { tenantId: "123" };
    const tenantId = "123";

    // Should not throw an error
    expect(() => validateOrganisationId(data, tenantId)).not.toThrow();
  });

  test("should throw error when tenantId is missing in data", () => {
    const data = {};
    const tenantId = "123";

    try {
      validateOrganisationId(data, tenantId);
      expect(true).toBe(false); // This line should not be reached
    } catch (e: any) {
      expect(e).toBeInstanceOf(Error);
      expect(e.message).toBe(
        'Parameter "tenantId" in body does not match URL parameter'
      );
    }
  });

  test("should throw error when tenantId does not match", () => {
    const data = { tenantId: "123" };
    const tenantId = "456";

    try {
      validateOrganisationId(data, tenantId);
      expect(true).toBe(false); // This line should not be reached
    } catch (e: any) {
      expect(e).toBeInstanceOf(Error);
      expect(e.message).toBe(
        'Parameter "tenantId" in body does not match URL parameter'
      );
    }
  });
});
