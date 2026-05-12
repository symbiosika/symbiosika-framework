import type { Context } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { _GLOBAL_SERVER_CONFIG } from "../../store";

export const JWT_COOKIE_NAME = "jwt";
export const JWT_PRESENT_COOKIE_NAME = "jwt_present";

const isSecureContext = (): boolean =>
  _GLOBAL_SERVER_CONFIG.baseUrl.startsWith("https://");

/**
 * Sets the auth cookies after a successful login.
 *
 * - `jwt`: HttpOnly session cookie (not readable from JS, mitigates XSS).
 * - `jwt_present`: non-HttpOnly marker so the SPA can detect a logged-in state
 *   without reading the actual token. Holds no secret data.
 *
 * SameSite=Lax is required for magic-link flows: the user follows a link from
 * an external mail client (cross-site initiator), and Strict would drop the
 * cookie on the resulting top-level navigation in some browsers.
 */
export const setAuthCookies = (c: Context, token: string): void => {
  const maxAge = _GLOBAL_SERVER_CONFIG.jwtExpiresAfter;
  const secure = isSecureContext();

  setCookie(c, JWT_COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge,
  });

  setCookie(c, JWT_PRESENT_COOKIE_NAME, "1", {
    httpOnly: false,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge,
  });
};

export const clearAuthCookies = (c: Context): void => {
  const secure = isSecureContext();
  deleteCookie(c, JWT_COOKIE_NAME, {
    path: "/",
    secure,
    sameSite: "Lax",
  });
  deleteCookie(c, JWT_PRESENT_COOKIE_NAME, {
    path: "/",
    secure,
    sameSite: "Lax",
  });
};
