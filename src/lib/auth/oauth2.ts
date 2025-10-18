import { getDb } from "../db/db-connection";
import { and, eq } from "drizzle-orm";
import { users } from "../db/db-schema";
import { generateJwt } from "./index";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { postRegisterActions } from "./actions";
import log from "../log";

// OAuth-Provider-Konfiguration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || "";
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || "";

export let GOOGLE_AUTH_IS_ACTIVE = false;
export let MICROSOFT_AUTH_IS_ACTIVE = false;

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_ID !== "") {
  GOOGLE_AUTH_IS_ACTIVE = true;
  log.info(
    "Google Auth active. Redirect URI: " + _GLOBAL_SERVER_CONFIG.baseUrl
  );
}

if (MICROSOFT_CLIENT_ID && MICROSOFT_CLIENT_ID !== "") {
  MICROSOFT_AUTH_IS_ACTIVE = true;
  log.info(
    "Microsoft Auth active. Redirect URI: " + _GLOBAL_SERVER_CONFIG.baseUrl
  );
}

// Helper function: Find or create a user based on OAuth data
async function findOrCreateOAuthUser(profile: {
  email: string;
  id: string;
  provider: "google" | "microsoft";
  firstname?: string;
  surname?: string;
}) {
  const { email, id, provider, firstname = "", surname = "" } = profile;

  // Check if user already exists
  const existingUser = await getDb()
    .select()
    .from(users)
    .where(and(eq(users.email, email), eq(users.provider, provider)));

  if (existingUser.length > 0) {
    const updatedUser = await getDb()
      .update(users)
      .set({
        extUserId: id,
      })
      .where(eq(users.id, existingUser[0].id))
      .returning();

    return updatedUser[0];
  } else {
    // Create new user
    const newUser = await getDb()
      .insert(users)
      .values({
        email,
        firstname: firstname || "",
        surname: surname || "",
        emailVerified: true, // When logging in with OAuth, we set it directly to verified
        provider,
        extUserId: id,
        salt: "",
        password: "",
      })
      .returning();

    log.info(`New user registered via ${provider}: ${newUser[0].id}`);

    // Perform post-register actions
    for (const action of postRegisterActions) {
      await action(newUser[0].id, newUser[0].email);
    }

    return newUser[0];
  }
}

export const OAuthAuth = {
  // Google OAuth functions
  async handleGoogleCallback(code: string) {
    // Get token from Google (with axios or fetch)
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:
          _GLOBAL_SERVER_CONFIG.baseUrl + "/api/v1/user/auth/google/callback",
        grant_type: "authorization_code",
      }),
    }).then((res) => res.json());

    // Get user data from Google
    const userInfo = await fetch(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      {
        headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
      }
    ).then((res) => res.json());

    // check for error
    if (userInfo.error) {
      throw new Error(userInfo.error + " " + userInfo.error_description);
    }

    // Find or create user in our DB
    const user = await findOrCreateOAuthUser({
      email: userInfo.email,
      id: userInfo.sub,
      provider: "google",
      firstname: userInfo.given_name,
      surname: userInfo.family_name,
    });

    // Generate JWT
    const { token, expiresAt } = await generateJwt(
      user,
      _GLOBAL_SERVER_CONFIG.jwtExpiresAfter
    );

    return { token, expiresAt, user };
  },

  // Microsoft OAuth functions
  async handleMicrosoftCallback(code: string) {
    // Get token from Microsoft
    const tokenResponse = await fetch(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: MICROSOFT_CLIENT_ID,
          client_secret: MICROSOFT_CLIENT_SECRET,
          redirect_uri:
            _GLOBAL_SERVER_CONFIG.baseUrl +
            "/api/v1/user/auth/microsoft/callback",
          grant_type: "authorization_code",
        }),
      }
    ).then((res) => res.json());

    // check for error
    if (tokenResponse.error) {
      throw new Error(
        tokenResponse.error + " " + tokenResponse.error_description
      );
    }

    // Get user data from Microsoft Graph API
    const userInfo = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
    }).then((res) => res.json());

    // Find or create user in our DB
    const user = await findOrCreateOAuthUser({
      email: userInfo.mail || userInfo.userPrincipalName,
      id: userInfo.id,
      provider: "microsoft",
      firstname: userInfo.givenName,
      surname: userInfo.surname,
    });

    // Generate JWT
    const { token, expiresAt } = await generateJwt(
      user,
      _GLOBAL_SERVER_CONFIG.jwtExpiresAfter
    );

    return { token, expiresAt, user };
  },

  // Shared functions for both providers
  getGoogleAuthUrl() {
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri:
        _GLOBAL_SERVER_CONFIG.baseUrl + "/api/v1/user/auth/google/callback",
      response_type: "code",
      scope: "email profile",
      access_type: "offline",
      prompt: "consent",
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  },

  getMicrosoftAuthUrl() {
    const params = new URLSearchParams({
      client_id: MICROSOFT_CLIENT_ID,
      redirect_uri:
        _GLOBAL_SERVER_CONFIG.baseUrl + "/api/v1/user/auth/microsoft/callback",
      response_type: "code",
      scope: "openid profile email User.Read",
      response_mode: "query",
    });

    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
  },

  getAvailableOAuthProviders() {
    return {
      google: GOOGLE_AUTH_IS_ACTIVE,
      microsoft: MICROSOFT_AUTH_IS_ACTIVE,
    };
  },
};
