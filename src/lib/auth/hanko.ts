import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { getDb } from "../db/db-connection";
import { users } from "../db/db-schema";
import log from "../log";
import { getCachedToken, setCachedToken } from "../utils/redis-cache";

const HANKO_API_URL = process.env.HANKO_API_URL ?? "";

export async function verifyHankoToken(c: Context) {
  let token: any = null;

  const authHeader = c.req.header("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  } else {
    token = getCookie(c, "hanko");
  }

  if (!token || token.length === 0) {
    log.error("Could not find a token to validate");
    throw new Error("Unauthorized");
  }

  // Check cache first
  const cached = await getCachedToken(token);
  if (cached) {
    log.debug("Token validated from cache");
    return cached;
  }

  // Token not in cache, validate with Hanko API
  let authError = false;
  let validationData: any = null;

  try {
    const validationOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session_token: token }),
    };

    const validationResponse = await fetch(
      `${HANKO_API_URL}/sessions/validate`,
      validationOptions
    );

    if (!validationResponse.ok) {
      authError = true;
    } else {
      validationData = await validationResponse.json();
      if (!validationData.is_valid) {
        authError = true;
      }
    }
  } catch (error) {
    console.error("Error validating token:", error);
    authError = true;
  }

  if (authError || !validationData) {
    log.error("Your token was not valid");
    throw new Error("Unauthorized");
  }

  log.info("Token not in cache, fetching/upserting user...");

  // Extract data from Hanko response structure
  const userEmail = validationData.claims?.email?.address ?? "";
  const userId =
    validationData.user_id ?? validationData.claims?.subject ?? "";
  const emailVerified = validationData.claims?.email?.is_verified ?? false;

  // Validate required fields
  if (!userEmail || userEmail.length === 0) {
    log.error("Could not extract email from Hanko validation response", {
      validationData,
    });
    throw new Error("Unauthorized - no email in token");
  }

  if (!userId || userId.length === 0) {
    log.error("Could not extract user ID from Hanko validation response", {
      validationData,
    });
    throw new Error("Unauthorized - no user ID in token");
  }

  log.info("Upserting user", { email: userEmail, extUserId: userId });

  // upsert user in db
  const [user] = await getDb()
    .insert(users)
    .values({
      email: userEmail,
      emailVerified: true,
      extUserId: userId,
      firstname: "",
      surname: "",
      provider: "hanko",
    })
    .onConflictDoUpdate({
      target: [users.email],
      set: {
        extUserId: userId,
        provider: "hanko",
        emailVerified: true,
      },
    })
    .returning();

  if (!user) {
    throw new Error("Failed to upsert user in database");
  }

  const result = {
    usersEmail: user.email,
    usersId: user.id,
  };

  // Cache the validated token
  await setCachedToken(token, result);

  return result;
}
