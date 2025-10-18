import { testFetcher } from "./fetcher.test";
import type { FastAppHono } from "../types";
import { expect } from "bun:test";

/**
 * A helper wrapper to test endpoints against
 * unauthorized requests
 * app: the app to test
 * requests: [METHOD, PATH]
 *
 */
export const rejectUnauthorized = async (
  app: FastAppHono,
  requests: [string, string][]
) => {
  for (const [method, path] of requests) {
    if (method === "GET") {
      const response = await testFetcher.get(app, path, undefined);
      expect(response.status).toBe(401);
    } else if (method === "POST") {
      const response = await testFetcher.post(app, path, undefined, {});
      expect(response.status).toBe(401);
    } else if (method === "PUT") {
      const response = await testFetcher.put(app, path, undefined, {});
      expect(response.status).toBe(401);
    } else if (method === "DELETE") {
      const response = await testFetcher.delete(app, path, undefined);
      expect(response.status).toBe(401);
    }
  }
};
