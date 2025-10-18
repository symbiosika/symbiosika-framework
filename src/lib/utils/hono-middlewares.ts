import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import jwtlib from "jsonwebtoken";
import { _GLOBAL_SERVER_CONFIG } from "../../store";
import { hasPermission } from "../auth/permissions";
import { generateTemporaryJwtFromToken } from "../auth/token-auth";

const JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY || "";

// Hono can´t handle Auth0 JWT tokens
// https://github.com/honojs/hono/issues/672

/**
 * Helper function to get the JWT token from the request
 */
const getTokenFromJwt = (token: string) => {
  return jwtlib.verify(token, JWT_PUBLIC_KEY, {
    algorithms:
      _GLOBAL_SERVER_CONFIG.authType === "auth0" ? ["RS256"] : undefined,
  });
};

/**
 * HONO Middleware to add the user to the context
 */
export function addUserToContext(
  c: Context<any, any, {}>,
  decodedAndVerifiedToken: jwtlib.JwtPayload
) {
  c.set("usersEmail", decodedAndVerifiedToken.email ?? "");
  c.set("usersId", decodedAndVerifiedToken.sub ?? "");
  // c.set("usersRoles", decodedAndVerifiedToken["symbiosika/roles"] ?? []);
}

/**
 * HONO Middleware to add scopes to the context
 */
export function addScopesToContext(
  c: Context,
  decodedAndVerifiedToken: jwtlib.JwtPayload
) {
  c.set("scopes", decodedAndVerifiedToken.scopes ?? ["all"]);
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

  const decoded = getTokenFromJwt(jwtToken);
  return decoded;
};

/**
 * HONO Middleware to set the usersEmail, usersId and usersRoles in the context
 */
export const authAndSetUsersInfo = async (c: Context, next: Function) => {
  try {
    const decodedAndVerifiedToken = await checkToken(c);
    if (typeof decodedAndVerifiedToken === "object") {
      addUserToContext(c, decodedAndVerifiedToken);
      addScopesToContext(c, decodedAndVerifiedToken);
    } else {
      return c.text("Invalid token", 401);
    }
  } catch (err) {
    return c.text("Unauthorized", 401);
  }
  await next();
};

/**
 * HONO Middleware to check the JWT token and redirect to login if not valid
 */
export const authOrRedirectToLogin = async (c: Context, next: Function) => {
  try {
    await checkToken(c);
  } catch (error) {
    return c.redirect("/manage/#/login?redirect=" + c.req.url);
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
    const decodedAndVerifiedToken = await checkToken(c);

    if (typeof decodedAndVerifiedToken === "object") {
      addUserToContext(c, decodedAndVerifiedToken);
      addScopesToContext(c, decodedAndVerifiedToken);
    } else {
      return c.redirect("/manage/#/login?redirect=" + c.req.url);
    }
  } catch (err) {
    return c.redirect("/manage/#/login?redirect=" + c.req.url);
  }
  await next();
};
