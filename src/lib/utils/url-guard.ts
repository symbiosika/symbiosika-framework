/**
 * URL guard to mitigate Server-Side Request Forgery (SSRF).
 *
 * Before the server fetches a URL that originates (directly or indirectly) from
 * user input, we validate that:
 *   - the scheme is http(s),
 *   - the host does not resolve to a private, loopback, link-local, or otherwise
 *     internal address (which would let a caller reach internal services or the
 *     cloud metadata endpoint, e.g. 169.254.169.254).
 *
 * Because DNS can rebind and HTTP redirects can point at internal hosts, callers
 * that follow redirects must re-validate every hop. `fetchWithSsrfGuard` does
 * this by following redirects manually.
 */
import { lookup } from "node:dns/promises";

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
};

const isBlockedIpv4 = (ip: string): boolean => {
  const v = ipv4ToInt(ip);
  if (v === null) return false;
  const inRange = (cidrBase: string, bits: number) => {
    const base = ipv4ToInt(cidrBase)!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (v & mask) === (base & mask);
  };
  return (
    inRange("0.0.0.0", 8) || // "this" network
    inRange("10.0.0.0", 8) || // private
    inRange("100.64.0.0", 10) || // carrier-grade NAT
    inRange("127.0.0.0", 8) || // loopback
    inRange("169.254.0.0", 16) || // link-local incl. cloud metadata
    inRange("172.16.0.0", 12) || // private
    inRange("192.0.0.0", 24) || // IETF protocol assignments
    inRange("192.168.0.0", 16) || // private
    inRange("198.18.0.0", 15) || // benchmarking
    inRange("224.0.0.0", 4) || // multicast
    inRange("240.0.0.0", 4) // reserved / broadcast
  );
};

const isBlockedIpv6 = (ip: string): boolean => {
  const addr = ip.toLowerCase().split("%")[0]!; // strip zone id
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4 address.
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isBlockedIpv4(mapped[1]!);
  return (
    addr.startsWith("fe8") || // link-local fe80::/10
    addr.startsWith("fe9") ||
    addr.startsWith("fea") ||
    addr.startsWith("feb") ||
    addr.startsWith("fc") || // unique local fc00::/7
    addr.startsWith("fd")
  );
};

/** True when the literal IP must never be the target of a server-side fetch. */
export const isBlockedAddress = (ip: string): boolean =>
  ip.includes(":") ? isBlockedIpv6(ip) : isBlockedIpv4(ip);

/**
 * Validate that `rawUrl` is an http(s) URL whose host does not resolve to an
 * internal address. Throws `SsrfBlockedError` when the URL must not be fetched.
 */
export const assertPublicHttpUrl = async (rawUrl: string): Promise<URL> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError("Invalid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlockedError(`Blocked URL scheme: ${url.protocol}`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new SsrfBlockedError("Blocked host: localhost");
  }

  // If the host is already a literal IP, check it directly. Otherwise resolve
  // all addresses and ensure none are internal.
  const looksLikeIp = /^[0-9.]+$/.test(host) || host.includes(":");
  if (looksLikeIp) {
    if (isBlockedAddress(host)) {
      throw new SsrfBlockedError(`Blocked address: ${host}`);
    }
    return url;
  }

  let resolved: { address: string }[];
  try {
    resolved = await lookup(host, { all: true });
  } catch {
    throw new SsrfBlockedError(`Could not resolve host: ${host}`);
  }
  if (resolved.length === 0) {
    throw new SsrfBlockedError(`Host did not resolve: ${host}`);
  }
  for (const { address } of resolved) {
    if (isBlockedAddress(address)) {
      throw new SsrfBlockedError(
        `Host ${host} resolves to a blocked address (${address})`
      );
    }
  }
  return url;
};

/**
 * fetch() wrapper that validates the target (and every redirect hop) against
 * the SSRF guard. Redirects are followed manually so a 30x response cannot send
 * the request to an internal host.
 */
export const fetchWithSsrfGuard = async (
  rawUrl: string,
  init: RequestInit = {},
  maxRedirects = 5
): Promise<Response> => {
  let currentUrl = rawUrl;
  for (let i = 0; i <= maxRedirects; i++) {
    await assertPublicHttpUrl(currentUrl);
    const response = await fetch(currentUrl, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return response;
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return response;
  }
  throw new SsrfBlockedError("Too many redirects");
};
