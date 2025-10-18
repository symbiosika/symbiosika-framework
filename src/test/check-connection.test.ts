import { describe, it } from "bun:test";
import { initTests } from "./init.test";

// Test suite for admin endpoints
describe("Admin API Endpoints", () => {
  it("should clear logs successfully", async () => {
    await initTests();
  });
});
