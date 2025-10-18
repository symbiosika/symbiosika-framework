import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { initTests } from "../../test/init.test";
import { logApiRoutes } from "./log-api-routes";
import type { FastAppHono } from "../../types";
import { Hono } from "hono";

describe("logApiRoutes", () => {
  let app: FastAppHono;
  let consoleOutput: string[] = [];
  let originalLog: typeof console.log;

  beforeAll(async () => {
    await initTests();
    app = new Hono() as FastAppHono;

    // Mock console.log
    originalLog = console.log;
    console.log = (...args: any[]) => {
      consoleOutput.push(args.join(" "));
      originalLog.apply(console, args);
    };
  });

  afterAll(() => {
    // Restore console.log
    console.log = originalLog;
  });

  test("should log registered routes correctly", () => {
    // Reset console output
    consoleOutput = [];

    // Add some test routes
    app.get("/test1", (c) => c.text(""));
    app.post("/test2", (c) => c.text(""));
    app.put("/test3", (c) => c.text(""));

    // Call the function
    logApiRoutes(app);

    // Check if the routes were logged correctly
    expect(consoleOutput[0]).toBe("\n🛣️  Registered Routes:");
    expect(consoleOutput[1]).toBe("GET    /test1");
    expect(consoleOutput[2]).toBe("POST   /test2");
    expect(consoleOutput[3]).toBe("PUT    /test3");
    expect(consoleOutput[4]).toBe(""); // Empty line check
  });

  test("should handle empty routes", () => {
    // Reset console output
    consoleOutput = [];

    // Create a new app instance without routes
    const emptyApp = new Hono() as FastAppHono;

    // Call the function
    logApiRoutes(emptyApp);

    // Check if only the header and empty line were logged
    expect(consoleOutput[0]).toBe("\n🛣️  Registered Routes:");
    expect(consoleOutput[1]).toBe(""); // Empty line check
  });
});
