import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { defineUserSettingsRoutes } from "./settings";
import type { SymbiosikaFrameworkHonoApp } from "../../types";
import { initTests } from "../../test/init.test";
import { getDb } from "../../lib/db/db-connection";
import { userSettings } from "../../lib/db/db-schema";
import { eq, or, inArray } from "drizzle-orm";

const THEME_KEY = "theme";
const TEST_KEY = "test-setting";

describe("User Settings Routes", () => {
  const app: SymbiosikaFrameworkHonoApp = new Hono();
  let jwt: string;

  beforeAll(async () => {
    const { adminToken } = await initTests();
    jwt = adminToken;

    // Clean up test settings
    const db = await getDb();
    await db
      .delete(userSettings)
      .where(
        or(
          eq(userSettings.key, THEME_KEY),
          eq(userSettings.key, TEST_KEY)
        )
      );

    defineUserSettingsRoutes(app, "/api");
  });

  afterAll(async () => {
    try {
      const db = await getDb();
      await db
        .delete(userSettings)
        .where(
          or(
            eq(userSettings.key, THEME_KEY),
            eq(userSettings.key, TEST_KEY)
          )
        );
    } catch (err) {
      console.warn("[routes/user/settings.test] cleanup failed:", err);
    }
  });

  // Test POST setting creation
  it("should create a new setting", async () => {
    const response = await app.request(`/api/user/settings/${TEST_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `jwt=${jwt}`,
      },
      body: JSON.stringify({
        value: "test-value",
        description: "A test setting",
      }),
    });

    expect(response.status).toBe(200);
    const data: any = await response.json();
    expect(data.key).toBe(TEST_KEY);
    expect(data.value).toBe("test-value");
  });

  // Test GET setting retrieval
  it("should retrieve an existing setting", async () => {
    // First create a setting
    await app.request(`/api/user/settings/${THEME_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `jwt=${jwt}`,
      },
      body: JSON.stringify({
        value: "dark",
      }),
    });

    // Then retrieve it
    const response = await app.request(
      `/api/user/settings/${THEME_KEY}`,
      {
        method: "GET",
        headers: {
          Cookie: `jwt=${jwt}`,
        },
      }
    );

    expect(response.status).toBe(200);
    const data: any = await response.json();
    expect(data.key).toBe(THEME_KEY);
    expect(data.value).toBe("dark");
  });

  // Test GET non-existent setting
  it("should return 404 for non-existent setting", async () => {
    const response = await app.request(
      `/api/user/settings/non-existent-key`,
      {
        method: "GET",
        headers: {
          Cookie: `jwt=${jwt}`,
        },
      }
    );

    expect(response.status).toBe(404);
  });

  // Test PUT update of existing setting
  it("should update an existing setting", async () => {
    const settingKey = "update-test";

    // Create initial setting
    await app.request(`/api/user/settings/${settingKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `jwt=${jwt}`,
      },
      body: JSON.stringify({
        value: "initial-value",
      }),
    });

    // Update the setting
    const updateResponse = await app.request(
      `/api/user/settings/${settingKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `jwt=${jwt}`,
        },
        body: JSON.stringify({
          value: "updated-value",
        }),
      }
    );

    expect(updateResponse.status).toBe(200);
    const updateData: any = await updateResponse.json();
    expect(updateData.value).toBe("updated-value");

    // Verify the update
    const getResponse = await app.request(
      `/api/user/settings/${settingKey}`,
      {
        method: "GET",
        headers: {
          Cookie: `jwt=${jwt}`,
        },
      }
    );

    expect(getResponse.status).toBe(200);
    const getData: any = await getResponse.json();
    expect(getData.value).toBe("updated-value");

    // Cleanup
    const db = await getDb();
    await db.delete(userSettings).where(eq(userSettings.key, settingKey));
  });

  // Test theme setting workflow
  it("should handle theme setting workflow", async () => {
    // Set theme to light
    const setLightResponse = await app.request(
      `/api/user/settings/${THEME_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `jwt=${jwt}`,
        },
        body: JSON.stringify({
          value: "light",
        }),
      }
    );

    expect(setLightResponse.status).toBe(200);

    // Get theme
    const getResponse = await app.request(
      `/api/user/settings/${THEME_KEY}`,
      {
        method: "GET",
        headers: {
          Cookie: `jwt=${jwt}`,
        },
      }
    );

    expect(getResponse.status).toBe(200);
    const data: any = await getResponse.json();
    expect(data.value).toBe("light");

    // Switch to dark
    const setDarkResponse = await app.request(
      `/api/user/settings/${THEME_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `jwt=${jwt}`,
        },
        body: JSON.stringify({
          value: "dark",
        }),
      }
    );

    expect(setDarkResponse.status).toBe(200);
    const darkData: any = await setDarkResponse.json();
    expect(darkData.value).toBe("dark");
  });

  // Test missing authentication
  it("should return 401 without authentication", async () => {
    const response = await app.request(
      `/api/user/settings/${TEST_KEY}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    expect(response.status).toBe(401);
  });

  // Test invalid request body
  it("should validate request body", async () => {
    const response = await app.request(
      `/api/user/settings/${TEST_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `jwt=${jwt}`,
        },
        body: JSON.stringify({
          // Missing both 'value' and 'valueJson' fields
          description: "Invalid request",
        }),
      }
    );

    expect(response.status).toBe(400);
  });

  // Test JSON value storage
  it("should store and retrieve JSON values", async () => {
    const jsonKey = "json-setting";
    const jsonValue = { theme: "dark", fontSize: 14, notifications: true };

    // Set JSON value
    const setResponse = await app.request(
      `/api/user/settings/${jsonKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `jwt=${jwt}`,
        },
        body: JSON.stringify({
          valueJson: jsonValue,
          description: "A JSON setting",
        }),
      }
    );

    expect(setResponse.status).toBe(200);
    const setData: any = await setResponse.json();
    expect(setData.valueJson).toEqual(jsonValue);

    // Get JSON value
    const getResponse = await app.request(
      `/api/user/settings/${jsonKey}`,
      {
        method: "GET",
        headers: {
          Cookie: `jwt=${jwt}`,
        },
      }
    );

    expect(getResponse.status).toBe(200);
    const getData: any = await getResponse.json();
    expect(getData.valueJson).toEqual(jsonValue);
    expect(getData.value).toBeUndefined();

    // Cleanup
    const db = await getDb();
    await db.delete(userSettings).where(eq(userSettings.key, jsonKey));
  });

  // Test mixed value types
  it("should handle both string and JSON values", async () => {
    const stringKey = "string-value";
    const jsonKey = "json-value";

    // Store string value
    const stringResponse = await app.request(
      `/api/user/settings/${stringKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `jwt=${jwt}`,
        },
        body: JSON.stringify({ value: "hello" }),
      }
    );

    expect(stringResponse.status).toBe(200);
    const stringData: any = await stringResponse.json();
    expect(stringData.value).toBe("hello");
    expect(stringData.valueJson).toBeUndefined();

    // Store JSON value
    const jsonResponse = await app.request(
      `/api/user/settings/${jsonKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `jwt=${jwt}`,
        },
        body: JSON.stringify({ valueJson: { count: 42 } }),
      }
    );

    expect(jsonResponse.status).toBe(200);
    const jsonData: any = await jsonResponse.json();
    expect(jsonData.valueJson).toEqual({ count: 42 });
    expect(jsonData.value).toBeUndefined();

    // Cleanup
    const db = await getDb();
    await db
      .delete(userSettings)
      .where(inArray(userSettings.key, [stringKey, jsonKey]));
  });
});
