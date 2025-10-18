import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { validateAllEnvVariables } from "./env-validate";

describe("env-validate", () => {
  // Store original env variables and process.exit
  const originalEnv = { ...process.env };
  const originalExit = process.exit;

  beforeAll(() => {
    // Mock process.exit to throw an error instead of exiting
    process.exit = (code?: number) => {
      throw new Error(`Process exited with code ${code}`);
    };
  });

  afterAll(() => {
    // Restore original env variables and process.exit
    process.env = originalEnv;
    process.exit = originalExit;
  });

  test("should pass when all required environment variables are set", () => {
    // Set all required environment variables
    process.env.POSTGRES_HOST = "localhost";
    process.env.POSTGRES_PORT = "5432";
    process.env.POSTGRES_USER = "user";
    process.env.POSTGRES_PASSWORD = "password";
    process.env.POSTGRES_DB = "testdb";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLAMA_CLOUD_API_KEY = "test-key";
    process.env.SECRETS_AES_KEY = "test-key";
    process.env.SECRETS_AES_IV = "test-iv";
    process.env.JWT_PUBLIC_KEY = "test-key";

    // Test should not throw an error
    expect(() => validateAllEnvVariables()).not.toThrow();
  });

  test("should exit when environment variables are missing", () => {
    // Clear all environment variables
    process.env = {};

    // Test should throw an error (simulating process.exit)
    expect(() => validateAllEnvVariables()).toThrow(
      "Process exited with code 1"
    );
  });

  test("should validate custom environment variables", () => {
    // Set all required environment variables
    process.env.POSTGRES_HOST = "localhost";
    process.env.POSTGRES_PORT = "5432";
    process.env.POSTGRES_USER = "user";
    process.env.POSTGRES_PASSWORD = "password";
    process.env.POSTGRES_DB = "testdb";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLAMA_CLOUD_API_KEY = "test-key";
    process.env.SECRETS_AES_KEY = "test-key";
    process.env.SECRETS_AES_IV = "test-iv";
    process.env.JWT_PUBLIC_KEY = "test-key";

    // Add a custom environment variable that is not set
    const customVars = ["CUSTOM_VAR"];

    // Test should throw an error when custom variable is missing
    expect(() => validateAllEnvVariables(customVars)).toThrow(
      "Process exited with code 1"
    );
  });
});
