/**
 * Drop requests whose path contains a NUL byte, before anything looks at it.
 *
 * These are not our bugs and not a user's mistake: they are vulnerability
 * scanners walking the usual path-traversal list, e.g.
 *
 *   GET /file%3a///////etc/passwd%00
 *   GET /file%3a///////etc%2fpasswd%00.jpg
 *
 * Such a request matches no route and falls through to the public static mount,
 * which hands the percent-decoded path to `Bun.file()`. Bun — like Node —
 * refuses a path containing a NUL byte by throwing `TypeError: The argument
 * 'path' must be a string, Uint8Array, or URL without null bytes`. Thrown from
 * inside the static handler, that reaches `globalErrorHandler`, which logs it at
 * ERROR with a stack trace and answers 500.
 *
 * So every scanner hit costs a stack trace in the logs and a 500 on the wire.
 * Both are wrong: nothing is broken, and a 500 tells the scanner it found
 * something interesting where a 400 says there is nothing here. The trailing
 * `%00` is precisely the trick meant to make a naive server truncate the name —
 * a request carrying one is malformed and cannot be satisfied by any file, so it
 * is refused up front rather than turned into an exception four layers down.
 *
 * The guard wraps the server's `fetch` (see `defineServer()`) rather than being
 * a Hono middleware. The static mounts answer everything that matches no route,
 * so a middleware would have to be registered ahead of them; wrapping `fetch`
 * puts the check in front of the whole app regardless of registration order.
 *
 * Path traversal without a NUL (`/../../etc/passwd`) is deliberately not this
 * guard's business: the static handler resolves the dot segments itself and
 * stays inside its root, without an error and without a log line.
 */

/**
 * Is this request path unserveable — i.e. does it carry a NUL byte, literally
 * or percent-encoded?
 *
 * Only the path is considered. A NUL in the query string never reaches the
 * filesystem, and rejecting it would be a different (and unrequested) policy.
 * `%2500` is not a match: it decodes to the three characters `%00`, which is a
 * legal, if silly, file name — the static handler decodes exactly once, so this
 * check does too.
 */
export const hasNulByteInPath = (url: string): boolean => {
  const path = pathOf(url);
  if (path.includes("\0")) return true;

  // A hex escape has no case variants for "00", but the "%" may be part of a
  // longer malformed sequence, so decode and look at the result as well.
  if (path.includes("%00")) return true;

  try {
    return decodeURIComponent(path).includes("\0");
  } catch {
    // Undecodable escapes are somebody else's problem: an unserveable path is
    // what this function reports, and a malformed escape is not one.
    return false;
  }
};

/**
 * The path portion of a raw request URL, without parsing it.
 *
 * `new URL()` percent-decodes nothing but does throw on some of the very inputs
 * this guard exists for, so the string is cut by hand: everything after the
 * authority, up to the first `?` or `#`.
 */
const pathOf = (url: string): string => {
  const schemeEnd = url.indexOf("://");
  const pathStart =
    schemeEnd === -1 ? 0 : url.indexOf("/", schemeEnd + "://".length);
  if (pathStart === -1) return "";

  const path = url.slice(pathStart);
  const queryStart = path.search(/[?#]/);
  return queryStart === -1 ? path : path.slice(0, queryStart);
};

/**
 * Put the guard in front of a server's request handler.
 *
 * Rejected requests are answered 400 and are not logged: the whole point is to
 * stop a scanner's list from filling the log with stack traces.
 */
export const withRequestPathGuard =
  <Rest extends unknown[]>(
    handler: (request: Request, ...rest: Rest) => Response | Promise<Response>
  ) =>
  (request: Request, ...rest: Rest): Response | Promise<Response> =>
    hasNulByteInPath(request.url)
      ? new Response("Bad Request", { status: 400 })
      : handler(request, ...rest);
