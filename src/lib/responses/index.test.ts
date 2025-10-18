import { describe, test, expect } from "bun:test";
import { RESPONSES, RESPONSE_VALIDATORS } from "./index";
import { parse } from "valibot";

describe("Responses", () => {
  test("RESPONSES.SUCCESS should have correct structure", () => {
    expect(RESPONSES.SUCCESS).toEqual({ success: true });
  });

  test("RESPONSE_VALIDATORS.SUCCESS should validate correct data", () => {
    const validData = { success: true };
    const result = parse(RESPONSE_VALIDATORS.SUCCESS, validData);
    expect(result).toEqual(validData);
  });

  test("RESPONSE_VALIDATORS.SUCCESS should reject invalid data", () => {
    const invalidData = { success: "not-a-boolean" };

    try {
      parse(RESPONSE_VALIDATORS.SUCCESS, invalidData);
      throw new Error("Should have thrown an error");
    } catch (e: any) {
      expect(e).toBeInstanceOf(Error);
    }
  });
});
