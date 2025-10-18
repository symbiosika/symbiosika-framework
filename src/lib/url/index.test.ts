import { describe, it, expect } from "bun:test";
import {
  parseNumberFromUrlParam,
  parseCommaSeparatedListFromUrlParam,
} from ".";

describe("parseNumberFromUrlParam", () => {
  it("should parse valid number string", () => {
    expect(parseNumberFromUrlParam("123")).toBe(123);
  });

  it("should return undefined for undefined input without default", () => {
    expect(parseNumberFromUrlParam(undefined)).toBeUndefined();
  });

  it("should return default value for undefined input with default", () => {
    expect(parseNumberFromUrlParam(undefined, 42)).toBe(42);
  });

  it("should parse string number even with default value", () => {
    expect(parseNumberFromUrlParam("123", 42)).toBe(123);
  });
});

describe("parseCommaSeparatedListFromUrlParam", () => {
  it("should parse comma separated string into array", () => {
    expect(parseCommaSeparatedListFromUrlParam("a,b,c")).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("should return undefined for undefined input without default", () => {
    expect(parseCommaSeparatedListFromUrlParam(undefined)).toBeUndefined();
  });

  it("should return default value for undefined input with default", () => {
    const defaultValue = ["x", "y"];
    expect(
      parseCommaSeparatedListFromUrlParam(undefined, defaultValue)
    ).toEqual(defaultValue);
  });

  it("should handle single item without comma", () => {
    expect(parseCommaSeparatedListFromUrlParam("single")).toEqual(["single"]);
  });

  it("should handle empty strings between commas", () => {
    expect(parseCommaSeparatedListFromUrlParam("a,,c")).toEqual(["a", "", "c"]);
  });
});
