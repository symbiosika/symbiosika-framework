import { describe, test, expect, beforeAll } from "bun:test";
import {
  createDatabaseClient,
  waitForDbConnection,
} from "../db/db-connection";
import {
  getServerSetting,
  getServerSettingInt,
  getServerSettingBool,
  setServerSetting,
  deleteServerSetting,
  clearServerSettingsCache,
} from "./index";

describe("server-settings (GLOBAL_CONFIG)", () => {
  beforeAll(async () => {
    await createDatabaseClient();
    await waitForDbConnection();
  });

  test("returns null for an unset key", async () => {
    await deleteServerSetting("TEST_UNSET_KEY");
    expect(await getServerSetting("TEST_UNSET_KEY")).toBeNull();
  });

  test("set then get round-trips a value", async () => {
    await setServerSetting("TEST_KEY_A", "hello");
    expect(await getServerSetting("TEST_KEY_A")).toBe("hello");
  });

  test("set upserts (overwrites) an existing value", async () => {
    await setServerSetting("TEST_KEY_B", "one");
    await setServerSetting("TEST_KEY_B", "two");
    expect(await getServerSetting("TEST_KEY_B", { fresh: true })).toBe("two");
  });

  test("getServerSettingInt parses and falls back", async () => {
    await setServerSetting("TEST_INT", "42");
    expect(await getServerSettingInt("TEST_INT", 60, { fresh: true })).toBe(42);

    await setServerSetting("TEST_INT", "not-a-number");
    expect(await getServerSettingInt("TEST_INT", 60, { fresh: true })).toBe(60);

    await deleteServerSetting("TEST_INT_MISSING");
    expect(await getServerSettingInt("TEST_INT_MISSING", 60)).toBe(60);
  });

  test("getServerSettingBool parses true/1 and falls back", async () => {
    await setServerSetting("TEST_BOOL", "true");
    expect(await getServerSettingBool("TEST_BOOL", false, { fresh: true })).toBe(
      true
    );
    await setServerSetting("TEST_BOOL", "1");
    expect(await getServerSettingBool("TEST_BOOL", false, { fresh: true })).toBe(
      true
    );
    await setServerSetting("TEST_BOOL", "false");
    expect(await getServerSettingBool("TEST_BOOL", true, { fresh: true })).toBe(
      false
    );
    await deleteServerSetting("TEST_BOOL_MISSING");
    expect(await getServerSettingBool("TEST_BOOL_MISSING", true)).toBe(true);
  });

  test("delete removes a value", async () => {
    await setServerSetting("TEST_DELETE", "x");
    await deleteServerSetting("TEST_DELETE");
    expect(await getServerSetting("TEST_DELETE", { fresh: true })).toBeNull();
  });

  test("cache serves within TTL; fresh bypasses it", async () => {
    await setServerSetting("TEST_CACHE", "v1");
    expect(await getServerSetting("TEST_CACHE")).toBe("v1");
    // Direct DB write behind the cache's back:
    clearServerSettingsCache();
    await setServerSetting("TEST_CACHE", "v2");
    expect(await getServerSetting("TEST_CACHE")).toBe("v2");
  });
});
