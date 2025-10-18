import { ensureJWTKeys } from "./jwt-keys";

/**
 * Validate all environment variables
 * to ensure that all required variables are set
 */
export const validateAllEnvVariables = async (
  customEnvVariablesToCheckOnStartup: string[] = []
): Promise<void> => {
  const requiredEnvVars = [
    "POSTGRES_HOST",
    "POSTGRES_PORT",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
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
