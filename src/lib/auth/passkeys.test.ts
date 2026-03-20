import { describe, it, expect, afterAll } from "bun:test";
import { getPasskeyConfig, isPasskeysEnabledForLocalAuth } from "./passkeys";
import { _GLOBAL_SERVER_CONFIG } from "../../store";

describe("passkeys config", () => {
  const savedAuth = _GLOBAL_SERVER_CONFIG.authType;
  const savedStoreBaseUrl = _GLOBAL_SERVER_CONFIG.baseUrl;

  afterAll(() => {
    _GLOBAL_SERVER_CONFIG.authType = savedAuth;
    _GLOBAL_SERVER_CONFIG.baseUrl = savedStoreBaseUrl;
  });

  it("derives rpID from baseUrl (hostname)", () => {
    _GLOBAL_SERVER_CONFIG.baseUrl = "http://localhost:3100";
    const cfg = getPasskeyConfig();
    expect(cfg?.rpID).toBe("localhost");
    expect(cfg?.rpName).toBe(_GLOBAL_SERVER_CONFIG.appName);
  });

  it("returns null when baseUrl cannot be parsed", () => {
    _GLOBAL_SERVER_CONFIG.baseUrl = "not-a-valid-url";
    expect(getPasskeyConfig()).toBeNull();
  });

  it("isPasskeysEnabledForLocalAuth respects auth type", () => {
    _GLOBAL_SERVER_CONFIG.baseUrl = "http://localhost:3100";
    _GLOBAL_SERVER_CONFIG.authType = "local";
    expect(isPasskeysEnabledForLocalAuth()).toBe(true);
    _GLOBAL_SERVER_CONFIG.authType = "hanko";
    expect(isPasskeysEnabledForLocalAuth()).toBe(false);
    _GLOBAL_SERVER_CONFIG.authType = "local";
  });
});
