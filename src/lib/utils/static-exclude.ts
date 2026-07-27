/**
 * Withhold parts of the public static folder from being served.
 *
 * The public static mount hands out its whole root without authentication.
 * Some deployments ship bundles in that folder that are switched off on this
 * instance — the files are in the image, but must not answer. This decides,
 * per request, whether a path is one of them.
 *
 * The check cannot simply compare the request path against a prefix. The
 * static handler resolves the path before it touches the filesystem, so
 * several different-looking URLs reach the very same file:
 *
 *   /bundle/index.html          the obvious one
 *   /public/bundle/index.html   `rewriteRequestPath` strips a leading /public
 *   /publicbundle/index.html    …and it strips it without a segment boundary
 *   /%62undle/index.html        percent escapes are decoded
 *   /x/../bundle/index.html     dot segments are resolved
 *
 * A prefix test on the raw path would catch the first and miss the rest, which
 * is the worst possible outcome for something whose job is to keep files
 * unreachable. So the path is put through the same steps the handler applies
 * and the comparison happens on the result.
 */

/** Mirrors the `rewriteRequestPath` of the public static mount. */
const stripPublicPrefix = (path: string): string =>
  path.replace(/^\/public/, "/");

/**
 * Reduce a request path to the segments the static handler will look up.
 *
 * Percent-decoding is attempted once; a malformed escape sequence leaves the
 * path as-is rather than throwing, because an undecodable path still has to be
 * classified — and it is classified on what it literally says.
 */
const resolveSegments = (path: string): string[] => {
  let decoded = stripPublicPrefix(path);
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // keep the raw form; better a coarse match than an exception on a hot path
  }

  const out: string[] = [];
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out;
};

/** Normalise a configured entry to a list of plain segments. */
const excludeSegments = (entry: string): string[] =>
  entry.split("/").filter((segment) => segment !== "" && segment !== ".");

/**
 * Prepare the configured exclusions once, at server start, instead of on every
 * request. Entries that normalise to nothing (`""`, `"/"`, `"."`) are dropped:
 * they would otherwise match every path and silently take the whole public
 * folder — including the login pages — offline.
 */
export const prepareStaticExclusions = (
  exclude: string[] | undefined
): string[][] => (exclude ?? []).map(excludeSegments).filter((s) => s.length > 0);

/**
 * Is this request path inside one of the excluded subtrees?
 *
 * Matching is on whole segments, so `"bundle"` hides `/bundle` and everything
 * below it but leaves `/bundle-archive` alone. There are no globs: this decides
 * what stays reachable without a login, and a pattern language is a place for
 * surprises.
 */
export const isExcludedFromPublicStatic = (
  path: string,
  prepared: string[][]
): boolean => {
  if (prepared.length === 0) return false;

  const segments = resolveSegments(path);
  return prepared.some(
    (needle) =>
      segments.length >= needle.length &&
      needle.every((segment, i) => segments[i] === segment)
  );
};
