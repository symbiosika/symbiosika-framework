import { describe, test, expect } from "bun:test";
import { isValidUuid } from "./uuid";

describe("UUID Validation", () => {
  test("should validate correct UUID v4", () => {
    const validUuid = "123e4567-e89b-42d3-a456-556642440000";
    expect(isValidUuid(validUuid)).toBe(true);
  });

  test("should validate correct UUID v4 with different characters", () => {
    const validUuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(isValidUuid(validUuid)).toBe(true);
  });

  test("should reject invalid UUID format", () => {
    const invalidUuids = [
      "not-a-uuid",
      "123e4567-e89b-12d3-a456-556642440000", // wrong version
      "123e4567-e89b-42d3-c456-556642440000", // wrong variant
      "123e4567e89b42d3a456556642440000", // missing hyphens
      "123e4567-e89b-42d3-a456-55664244000", // too short
      "123e4567-e89b-42d3-a456-5566424400000", // too long
    ];

    invalidUuids.forEach(uuid => {
      expect(isValidUuid(uuid)).toBe(false);
    });
  });

  test("should handle empty string", () => {
    expect(isValidUuid("")).toBe(false);
  });

  test("should handle null and undefined", () => {
    try {
      isValidUuid(null as any);
      expect(true).toBe(false); // This line should not be reached
    } catch (e: any) {
      expect(e).toBeInstanceOf(Error);
    }

    try {
      isValidUuid(undefined as any);
      expect(true).toBe(false); // This line should not be reached
    } catch (e: any) {
      expect(e).toBeInstanceOf(Error);
    }
  });
});
