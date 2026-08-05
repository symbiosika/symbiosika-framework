import { describe, expect, it } from "bun:test";
import { hasNulByteInPath, withRequestPathGuard } from "./request-path-guard";

describe("hasNulByteInPath", () => {
  it("rejects the scanner requests seen in the logs", () => {
    const seen = [
      "http://wiki.example.com/file%3a///////etc/passwd%00",
      "http://wiki.example.com/file%3a///////etc%5cpasswd%00",
      "http://wiki.example.com/file%3a///////etc/passwd%00.jpg",
      "http://wiki.example.com/file%3a///////etc%2fpasswd%00.jpg",
    ];
    for (const url of seen) {
      expect({ url, rejected: hasNulByteInPath(url) }).toEqual({
        url,
        rejected: true,
      });
    }
  });

  it("rejects a literal NUL byte in the path", () => {
    expect(hasNulByteInPath("http://x/docs/index.html\0.png")).toBe(true);
  });

  it("lets ordinary requests through", () => {
    const fine = [
      "http://x/",
      "http://x/login.html",
      "http://x/docs/assets/app-4f2a.js",
      "http://x/static/reports/2026-08.pdf",
      "http://x/api/v1/organisations",
      "http://x/api/v1/00000000-0000-0000-0000-000000000000/overview",
      // path traversal without a NUL is not this guard's business: the static
      // handler resolves the dot segments and stays inside its root
      "http://x/../../etc/passwd",
      "http://x/Ordner%20mit%20Leerzeichen/Datei%20%C3%A4.pdf",
    ];
    for (const url of fine) {
      expect({ url, rejected: hasNulByteInPath(url) }).toEqual({
        url,
        rejected: false,
      });
    }
  });

  it("ignores the query string", () => {
    expect(hasNulByteInPath("http://x/search?q=%00")).toBe(false);
    expect(hasNulByteInPath("http://x/search#%00")).toBe(false);
    // …but not a NUL before it
    expect(hasNulByteInPath("http://x/file%00?q=1")).toBe(true);
  });

  it("does not treat a double-encoded %00 as a NUL byte", () => {
    // decodes once, to the literal characters "%00" — a legal file name
    expect(hasNulByteInPath("http://x/file%2500.txt")).toBe(false);
  });

  it("survives malformed escape sequences", () => {
    expect(hasNulByteInPath("http://x/file%zz")).toBe(false);
    expect(hasNulByteInPath("http://x/file%")).toBe(false);
    expect(hasNulByteInPath("http://x/file%e0%a4%a")).toBe(false);
  });

  it("handles a URL with no path at all", () => {
    expect(hasNulByteInPath("http://x")).toBe(false);
  });
});

describe("withRequestPathGuard", () => {
  const guarded = (handler: (r: Request) => Response) =>
    withRequestPathGuard(handler);

  const reached = () => {
    let hit = false;
    const handler = guarded(() => {
      hit = true;
      return new Response("ok");
    });
    return { handler, wasReached: () => hit };
  };

  it("answers 400 without calling the app", async () => {
    const { handler, wasReached } = reached();
    const res = await handler(
      new Request("http://x/file%3a///////etc/passwd%00")
    );
    expect(res.status).toBe(400);
    expect(wasReached()).toBe(false);
  });

  it("passes ordinary requests to the app untouched", async () => {
    const { handler, wasReached } = reached();
    const res = await handler(new Request("http://x/login.html"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(wasReached()).toBe(true);
  });

  it("forwards the extra arguments Bun.serve passes along", async () => {
    const seen: unknown[] = [];
    const handler = withRequestPathGuard((_req: Request, server: unknown) => {
      seen.push(server);
      return new Response("ok");
    });
    const server = { id: "bun-server" };
    await handler(new Request("http://x/"), server);
    expect(seen).toEqual([server]);
  });
});

/*
 * The guard exists because of what Bun does with such a path. This pins that
 * premise down: if a future Bun stopped throwing here and returned an empty
 * file instead, the guard would be redundant rather than load-bearing, and this
 * test is where that shows up.
 */
describe("the reason the guard is needed", () => {
  it("Bun.file throws on a path containing a NUL byte", () => {
    // what the public static mount ends up doing with the scanner's URL, after
    // the handler has joined its root onto the decoded path
    expect(() => Bun.file("public/file:/etc/passwd\0")).toThrow(TypeError);
  });

  it("…and is perfectly happy without it", () => {
    expect(() => Bun.file("public/file:/etc/passwd")).not.toThrow();
  });
});
