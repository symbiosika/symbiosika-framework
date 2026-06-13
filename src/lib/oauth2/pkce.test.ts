import { describe, it, expect } from "bun:test";
import * as crypto from "crypto";
import { computeS256Challenge, verifyPkce } from "./pkce";

const makeVerifier = () => crypto.randomBytes(32).toString("base64url");

describe("pkce", () => {
  it("verifies a correct S256 verifier/challenge pair", () => {
    const verifier = makeVerifier();
    const challenge = computeS256Challenge(verifier);
    expect(verifyPkce(verifier, challenge, "S256")).toBe(true);
  });

  it("rejects a wrong verifier", () => {
    const challenge = computeS256Challenge(makeVerifier());
    expect(verifyPkce(makeVerifier(), challenge, "S256")).toBe(false);
  });

  it("rejects the plain method", () => {
    const verifier = makeVerifier();
    // For plain, challenge == verifier — must still be rejected.
    expect(verifyPkce(verifier, verifier, "plain")).toBe(false);
  });

  it("rejects empty inputs", () => {
    expect(verifyPkce("", "", "S256")).toBe(false);
  });
});
