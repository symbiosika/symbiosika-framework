import { describe, it, expect } from "bun:test";
import {
  computeSourceHash,
  isSourceUnchanged,
  SOURCE_HASH_ALGORITHM,
} from "./source-hash";

describe("computeSourceHash", () => {
  it("uses sha256 hex (64 lowercase hex chars)", () => {
    expect(SOURCE_HASH_ALGORITHM).toBe("sha256");
    const h = computeSourceHash("anything");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the known sha256 of a string (stable algorithm + encoding)", () => {
    // Pin the contract: sha256("abc") is a fixed, well-known value.
    expect(computeSourceHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("is deterministic for identical input", () => {
    expect(computeSourceHash("hello world")).toBe(
      computeSourceHash("hello world")
    );
  });

  it("differs for different input", () => {
    expect(computeSourceHash("a")).not.toBe(computeSourceHash("b"));
  });

  it("hashes raw bytes and matches the equivalent UTF-8 string", () => {
    const bytes = new TextEncoder().encode("abc");
    expect(computeSourceHash(bytes)).toBe(computeSourceHash("abc"));
  });

  it("treats ArrayBuffer and Uint8Array of the same bytes identically", () => {
    const view = new TextEncoder().encode("payload");
    const buffer = view.buffer.slice(
      view.byteOffset,
      view.byteOffset + view.byteLength
    );
    expect(computeSourceHash(buffer)).toBe(computeSourceHash(view));
  });
});

describe("isSourceUnchanged", () => {
  const H = computeSourceHash("same");
  const OTHER = computeSourceHash("other");

  it("is true only when both hashes are present and equal", () => {
    expect(isSourceUnchanged(H, H)).toBe(true);
  });

  it("is false when the hashes differ", () => {
    expect(isSourceUnchanged(H, OTHER)).toBe(false);
  });

  it("is false when either side is missing (cannot prove unchanged)", () => {
    expect(isSourceUnchanged(undefined, H)).toBe(false);
    expect(isSourceUnchanged(H, undefined)).toBe(false);
    expect(isSourceUnchanged(null, H)).toBe(false);
    expect(isSourceUnchanged(H, null)).toBe(false);
    expect(isSourceUnchanged(undefined, undefined)).toBe(false);
  });

  it("is false for an empty stored hash", () => {
    expect(isSourceUnchanged("", "")).toBe(false);
  });
});
