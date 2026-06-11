import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  assertPublicHttpUrl,
  isBlockedAddress,
  SsrfBlockedError,
} from "./url-guard";

// Other test files (e.g. the webhook n8n simulation) enable the private-target
// opt-out; pin it to off here so the guard's default behavior is what we test.
let savedOptOut: string | undefined;
beforeAll(() => {
  savedOptOut = process.env.SSRF_ALLOW_PRIVATE_TARGETS;
  delete process.env.SSRF_ALLOW_PRIVATE_TARGETS;
});
afterAll(() => {
  if (savedOptOut !== undefined) {
    process.env.SSRF_ALLOW_PRIVATE_TARGETS = savedOptOut;
  }
});

describe("isBlockedAddress", () => {
  it("blocks loopback, private, link-local and metadata addresses", () => {
    const blocked = [
      "127.0.0.1",
      "127.5.5.5",
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "0.0.0.0",
      "100.64.0.1",
      "::1",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "::ffff:127.0.0.1", // IPv4-mapped loopback
    ];
    for (const ip of blocked) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it("allows public addresses", () => {
    const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"];
    for (const ip of allowed) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });
});

describe("assertPublicHttpUrl", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow(
      SsrfBlockedError
    );
    await expect(assertPublicHttpUrl("ftp://example.com")).rejects.toThrow(
      SsrfBlockedError
    );
    await expect(
      assertPublicHttpUrl("gopher://127.0.0.1")
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects localhost and internal literal IPs", async () => {
    await expect(assertPublicHttpUrl("http://localhost/")).rejects.toThrow(
      SsrfBlockedError
    );
    await expect(
      assertPublicHttpUrl("http://app.localhost/")
    ).rejects.toThrow(SsrfBlockedError);
    await expect(assertPublicHttpUrl("http://127.0.0.1/")).rejects.toThrow(
      SsrfBlockedError
    );
    await expect(
      assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/")
    ).rejects.toThrow(SsrfBlockedError);
    await expect(assertPublicHttpUrl("http://[::1]:8080/")).rejects.toThrow(
      SsrfBlockedError
    );
    await expect(assertPublicHttpUrl("http://192.168.0.10/")).rejects.toThrow(
      SsrfBlockedError
    );
  });

  it("rejects malformed urls", async () => {
    await expect(assertPublicHttpUrl("not a url")).rejects.toThrow(
      SsrfBlockedError
    );
  });

  it("allows private targets when SSRF_ALLOW_PRIVATE_TARGETS is set", async () => {
    process.env.SSRF_ALLOW_PRIVATE_TARGETS = "true";
    try {
      const url = await assertPublicHttpUrl("http://localhost:3000/hook");
      expect(url.hostname).toBe("localhost");
      // non-http(s) schemes stay blocked even with the opt-out
      await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow(
        SsrfBlockedError
      );
    } finally {
      delete process.env.SSRF_ALLOW_PRIVATE_TARGETS;
    }
  });
});
