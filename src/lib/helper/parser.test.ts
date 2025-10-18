import { describe, test, expect } from "bun:test";
import {
  parseIntFromUnknown,
  parseBooleanFromUnknown,
  parseStringFromUnknown,
} from "./parsers";

describe("Parser Functions", () => {
  describe("parseIntFromUnknown", () => {
    test("should parse number correctly", () => {
      expect(parseIntFromUnknown(42)).toBe(42);
      expect(parseIntFromUnknown(0)).toBe(0);
      expect(parseIntFromUnknown(-42)).toBe(-42);
    });

    test("should parse string numbers correctly", () => {
      expect(parseIntFromUnknown("42")).toBe(42);
      expect(parseIntFromUnknown("0")).toBe(0);
      expect(parseIntFromUnknown("-42")).toBe(-42);
    });

    test("should return undefined for invalid inputs", () => {
      expect(parseIntFromUnknown("not a number")).toBeUndefined();
      expect(parseIntFromUnknown(true)).toBeUndefined();
      expect(parseIntFromUnknown(null)).toBeUndefined();
      expect(parseIntFromUnknown(undefined)).toBeUndefined();
    });

    test("should return default value for invalid inputs when provided", () => {
      expect(parseIntFromUnknown("not a number", 0)).toBe(0);
      expect(parseIntFromUnknown(true, 42)).toBe(42);
      expect(parseIntFromUnknown(null, -1)).toBe(-1);
      expect(parseIntFromUnknown(undefined, 100)).toBe(100);
    });
  });

  describe("parseBooleanFromUnknown", () => {
    test("should parse boolean correctly", () => {
      expect(parseBooleanFromUnknown(true)).toBe(true);
      expect(parseBooleanFromUnknown(false)).toBe(false);
    });

    test("should return undefined for non-boolean inputs", () => {
      expect(parseBooleanFromUnknown(42)).toBeUndefined();
      expect(parseBooleanFromUnknown("true")).toBeUndefined();
      expect(parseBooleanFromUnknown(null)).toBeUndefined();
      expect(parseBooleanFromUnknown(undefined)).toBeUndefined();
    });

    test("should return default value for non-boolean inputs when provided", () => {
      expect(parseBooleanFromUnknown(42, true)).toBe(true);
      expect(parseBooleanFromUnknown("true", false)).toBe(false);
      expect(parseBooleanFromUnknown(null, true)).toBe(true);
      expect(parseBooleanFromUnknown(undefined, false)).toBe(false);
    });
  });

  describe("parseStringFromUnknown", () => {
    test("should parse string correctly", () => {
      expect(parseStringFromUnknown("hello")).toBe("hello");
      expect(parseStringFromUnknown("")).toBeUndefined();
      expect(parseStringFromUnknown("0")).toBe("0");
    });

    test("should return undefined for non-string inputs", () => {
      expect(parseStringFromUnknown(42)).toBeUndefined();
      expect(parseStringFromUnknown(true)).toBeUndefined();
      expect(parseStringFromUnknown(null)).toBeUndefined();
      expect(parseStringFromUnknown(undefined)).toBeUndefined();
    });

    test("should return default value for non-string inputs when provided", () => {
      expect(parseStringFromUnknown(42, "default")).toBe("default");
      expect(parseStringFromUnknown(true, "fallback")).toBe("fallback");
      expect(parseStringFromUnknown(null, "empty")).toBe("empty");
      expect(parseStringFromUnknown(undefined, "missing")).toBe("missing");
    });

    test("should return default value for empty string when provided", () => {
      expect(parseStringFromUnknown("", "default")).toBe("default");
    });
  });
});
