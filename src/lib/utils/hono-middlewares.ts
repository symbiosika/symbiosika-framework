import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import jwtlib from "jsonwebtoken";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { generateTemporaryJwtFromToken } from "../auth/token-auth";
import { verifyHankoToken } from "../auth/hanko";
import { getCachedToken, setCachedToken } from "./redis-cache";

const JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY || "";

// Hono can´t handle Auth0 JWT tokens
// https://github.com/honojs/hono/issues/672

/**
 * Helper function to verify JWT token with caching
 */
const getTokenFromJwt = async (token: string) => {
  // Check cache first
  const cached = await getCachedToken(token);
  if (cached) {
    return {
      email: cached.usersEmail,
      sub: cached.usersId,
      scopes: cached.scopes,
    };
  }

  // Verify token
  const decoded = jwtlib.verify(token, JWT_PUBLIC_KEY, {
    algorithms:
      _GLOBAL_SERVER_CONFIG.authType === "auth0" ? ["RS256"] : undefined,
  });

  // Cache the validated token
  if (typeof decoded === "object" && decoded.email && decoded.sub) {
    await setCachedToken(token, {
      usersEmail: decoded.email ?? "",
      usersId: decoded.sub ?? "",
      scopes: (decoded as any).scopes,
    });
  }

  return decoded;
};

/**
 * HONO Middleware to add scopes to the context
 */
export function addScopesToContext(c: Context, scopes?: string[]) {
  c.set("scopes", scopes ?? ["all"]);
}

/**
 * HONO Middleware to check if the user has permission for the given path and method
 */
export async function checkUserPermission(c: Context, next: Function) {
  // HACK!!!
  await next();
  // const userId = c.get("usersId");
  // const method = c.req.method;
  // const path = c.req.path;
  // const userCanAccess = await hasPermission(userId, method, path);
  // if (!userCanAccess) {
  //   return c.text("Not permitted", 403);
  // }
  // await next();
}

/**
 * HONO Middleware to check the JWT token
 */
export const checkToken = async (c: Context) => {
  if (_GLOBAL_SERVER_CONFIG.authType === "hanko") {
    const { usersEmail, usersId } = await verifyHankoToken(c);
    return {
      usersEmail: usersEmail,
      usersId: usersId,
      scopes: ["all"], // Hanko tokens always have full access
    };
  } else {
    // get existing params
    const token = c.req.query("token");
    const authHeader = c.req.header("Authorization");
    const xApiKey = c.req.header("X-API-KEY");

    let jwtToken = "";

    // check if there is a "token=xxx" set in the URL request
    if (token || xApiKey) {
      const tokenToUse: string = token || xApiKey || "";
      // try to generate a JWT token from the token string
      const temporaryJwt = await generateTemporaryJwtFromToken(tokenToUse);
      jwtToken = temporaryJwt.token;
    } else if (authHeader && authHeader.startsWith("Bearer ")) {
      jwtToken = authHeader.substring(7);
    } else {
      jwtToken = getCookie(c, "jwt") || "";
    }

    if (!jwtToken || jwtToken === "") {
      throw new Error("Invalid token");
    }

    const decoded = await getTokenFromJwt(jwtToken);
    if (typeof decoded === "object") {
      // Extract scopes from JWT, default to ["all"] if not present (normal session)
      const scopes = (decoded as any).scopes || ["all"];
      return {
        usersEmail: decoded.email ?? "",
        usersId: decoded.sub ?? "",
        scopes: Array.isArray(scopes) ? scopes : ["all"],
      };
    } else {
      throw new Error("Invalid token");
    }
  }
};

/**
 * HONO Middleware to set the usersEmail, usersId and usersRoles in the context
 */
export const authAndSetUsersInfo = async (c: Context, next: Function) => {
  try {
    const { usersEmail, usersId, scopes } = await checkToken(c);
    c.set("usersEmail", usersEmail);
    c.set("usersId", usersId);
    addScopesToContext(c, scopes);
  } catch (error) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  await next();
};

/**
 * HONO Middleware to check the JWT token and redirect to login if not valid
 */
export const authOrRedirectToLogin = async (c: Context, next: Function) => {
  try {
    await checkToken(c);
    addScopesToContext(c, ["all"]);
  } catch (error) {
    return c.redirect(
      _GLOBAL_SERVER_CONFIG.loginUrl +
        "?redirectUrl=" +
        encodeURIComponent(c.req.url)
    );
  }
  await next();
};

/**
 * HONO Middleware to check the JWT token and redirect to login if not valid
 * and set the usersEmail, usersId and usersRoles in the context
 */
export const authAndSetUsersInfoOrRedirectToLogin = async (
  c: Context,
  next: Function
) => {
  try {
    const { usersEmail, usersId, scopes } = await checkToken(c);
    c.set("usersEmail", usersEmail);
    c.set("usersId", usersId);
    addScopesToContext(c, scopes);
  } catch (error) {
    return c.redirect(
      _GLOBAL_SERVER_CONFIG.loginUrl +
        "?redirectUrl=" +
        encodeURIComponent(c.req.url)
    );
  }
  await next();
};
