import { describe, test, expect } from "bun:test";
import { validateScope } from "./validate-scope";
import type { Context } from "hono";

describe("validateScope", () => {
  test("should pass when scopes include 'all'", async () => {
    const middleware = validateScope();
    let nextCalled = false;
    const c = {
      get: () => ["all", "other"],
      text: () => {},
    } as unknown as Context;
    const next = () => {
      nextCalled = true;
      return Promise.resolve();
    };

    await middleware(c, next);
    expect(nextCalled).toBe(true);
  });

  test("should pass when required scope is present", async () => {
    const middleware = validateScope("read");
    let nextCalled = false;
    const c = {
      get: () => ["read", "write"],
      text: () => {},
    } as unknown as Context;
    const next = () => {
      nextCalled = true;
      return Promise.resolve();
    };

    await middleware(c, next);
    expect(nextCalled).toBe(true);
  });

  test("should return 403 when required scope is missing", async () => {
    const middleware = validateScope("read");
    let nextCalled = false;
    let responseText = "";
    let statusCode = 0;
    const c = {
      get: () => ["write", "delete"],
      text: (text: string, status: number) => {
        responseText = text;
        statusCode = status;
        return {};
      },
    } as unknown as Context;
    const next = () => {
      nextCalled = true;
      return Promise.resolve();
    };

    await middleware(c, next);
    expect(nextCalled).toBe(false);
    expect(statusCode).toBe(403);
    expect(responseText).toBe("Missing required scope: read");
  });

  test("should return 403 when no scope is required and 'all' is not present", async () => {
    const middleware = validateScope();
    let nextCalled = false;
    let responseText = "";
    let statusCode = 0;
    const c = {
      get: () => ["read", "write"],
      text: (text: string, status: number) => {
        responseText = text;
        statusCode = status;
        return {};
      },
    } as unknown as Context;
    const next = () => {
      nextCalled = true;
      return Promise.resolve();
    };

    await middleware(c, next);
    expect(nextCalled).toBe(false);
    expect(statusCode).toBe(403);
    expect(responseText).toBe("Missing required scope: all");
  });
});
