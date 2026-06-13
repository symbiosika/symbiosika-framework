import { ensureJWTKeys } from "./jwt-keys";

/**
 * Validate all environment variables
 * to ensure that all required variables are set
 */
export const validateAllEnvVariables = async (
  customEnvVariablesToCheckOnStartup: string[] = []
): Promise<void> => {
  // When the embedded local database is used (USE_LOCAL_DB=true), no external
  // Postgres connection is configured, so the POSTGRES_* vars are not required.
  const useLocalDb = process.env.USE_LOCAL_DB === "true";
  const requiredEnvVars = [
    ...(useLocalDb
      ? []
      : [
          "POSTGRES_HOST",
          "POSTGRES_PORT",
          "POSTGRES_USER",
          "POSTGRES_PASSWORD",
          "POSTGRES_DB",
        ]),
    "SECRETS_AES_KEY",
    "SECRETS_AES_IV",
  ];
  const missingEnvVars = requiredEnvVars
    .concat(customEnvVariablesToCheckOnStartup)
    .filter((envVar) => !process.env[envVar]);

  await ensureJWTKeys().catch(console.error);

  if (missingEnvVars.length > 0) {
    console.error("Missing environment variables:", missingEnvVars);
    process.exit(1);
  } else {
    console.log("All environment variables are set");
  }
};
