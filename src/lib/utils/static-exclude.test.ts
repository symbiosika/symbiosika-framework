import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { serveStatic } from "hono/serve-static";
import { join } from "node:path";
import {
  isExcludedFromPublicStatic,
  prepareStaticExclusions,
} from "./static-exclude";

const prepared = (...entries: string[]) => prepareStaticExclusions(entries);

describe("prepareStaticExclusions", () => {
  it("normalises entries to plain segments", () => {
    expect(prepared("bundle")).toEqual([["bundle"]]);
    expect(prepared("/bundle/")).toEqual([["bundle"]]);
    expect(prepared("a/b")).toEqual([["a", "b"]]);
    expect(prepared("./a//b/")).toEqual([["a", "b"]]);
  });

  it("keeps several entries", () => {
    expect(prepared("a", "b")).toEqual([["a"], ["b"]]);
  });

  it("drops entries that would match everything", () => {
    // An empty needle matches every path, which would take the login pages
    // offline together with the intended subtree.
    expect(prepareStaticExclusions(["", "/", ".", "//"])).toEqual([]);
  });

  it("treats an absent configuration as no exclusions", () => {
    expect(prepareStaticExclusions(undefined)).toEqual([]);
  });
});

describe("isExcludedFromPublicStatic", () => {
  it("passes everything through when nothing is configured", () => {
    expect(isExcludedFromPublicStatic("/anything", [])).toBe(false);
  });

  it("excludes the subtree and its root", () => {
    const p = prepared("bundle");
    expect(isExcludedFromPublicStatic("/bundle", p)).toBe(true);
    expect(isExcludedFromPublicStatic("/bundle/", p)).toBe(true);
    expect(isExcludedFromPublicStatic("/bundle/index.html", p)).toBe(true);
    expect(isExcludedFromPublicStatic("/bundle/assets/app.js", p)).toBe(true);
  });

  it("leaves the rest of the public folder alone", () => {
    const p = prepared("bundle");
    for (const path of ["/", "/login.html", "/styles.css", "/favicon.png"]) {
      expect(isExcludedFromPublicStatic(path, p)).toBe(false);
    }
  });

  it("matches whole segments, not string prefixes", () => {
    const p = prepared("bundle");
    expect(isExcludedFromPublicStatic("/bundle-archive/x", p)).toBe(false);
    expect(isExcludedFromPublicStatic("/bundles/x", p)).toBe(false);
  });

  it("is case sensitive, like the filesystem lookup it guards", () => {
    expect(isExcludedFromPublicStatic("/BUNDLE/x", prepared("bundle"))).toBe(
      false
    );
  });

  it("supports nested entries", () => {
    const p = prepared("a/b");
    expect(isExcludedFromPublicStatic("/a/b/c", p)).toBe(true);
    expect(isExcludedFromPublicStatic("/a/b", p)).toBe(true);
    expect(isExcludedFromPublicStatic("/a/c", p)).toBe(false);
    expect(isExcludedFromPublicStatic("/a", p)).toBe(false);
  });

  /*
   * The static handler resolves the path before the filesystem lookup, so the
   * following all reach the same file as /bundle/index.html. Each one is a way
   * around a naive prefix check.
   */
  describe("paths that resolve to the same file", () => {
    const p = prepared("bundle");

    it("sees through the /public rewrite", () => {
      expect(isExcludedFromPublicStatic("/public/bundle/index.html", p)).toBe(
        true
      );
    });

    it("sees through the rewrite's missing segment boundary", () => {
      // rewriteRequestPath strips a literal "/public", so "/publicbundle/x"
      // becomes "/bundle/x" — an alias that does not look like one.
      expect(isExcludedFromPublicStatic("/publicbundle/index.html", p)).toBe(
        true
      );
    });

    it("sees through percent escapes", () => {
      expect(isExcludedFromPublicStatic("/%62undle/index.html", p)).toBe(true);
      expect(isExcludedFromPublicStatic("/public/%62undle/x", p)).toBe(true);
    });

    it("sees through dot segments", () => {
      expect(isExcludedFromPublicStatic("/./bundle/index.html", p)).toBe(true);
      expect(isExcludedFromPublicStatic("/x/../bundle/index.html", p)).toBe(
        true
      );
      expect(isExcludedFromPublicStatic("/a/b/../../bundle/x", p)).toBe(true);
    });

    it("does not throw on a malformed escape sequence", () => {
      expect(isExcludedFromPublicStatic("/%zz/x", p)).toBe(false);
      expect(isExcludedFromPublicStatic("/%", p)).toBe(false);
    });
  });
});

/*
 * The unit tests above encode what the static handler is believed to do. These
 * check that belief against hono's real serve-static middleware: every path
 * that serves the file without the guard must 404 with it. A path the guard
 * misses is a file that stays public after being switched off, so the aliases
 * are worth pinning down rather than reasoning about.
 *
 * The middleware is mounted with an in-memory filesystem instead of the
 * `hono/bun` adapter. Everything under test — percent-decoding, the rewrite,
 * dot-segment resolution, the index.html default — lives in this shared
 * middleware; the adapter only supplies `getContent`/`isDir` on top of
 * `Bun.file` and `node:fs/promises`. Supplying them here keeps the test
 * deterministic: another file in this suite installs a process-wide
 * `mock.module("fs/promises")` whose fake `stat` has no `isDirectory`, which
 * silently changes how the adapter resolves a trailing slash.
 */
describe("in front of hono's static middleware", () => {
  const FILES: Record<string, string> = {
    "/root/bundle/index.html": "<p>bundle</p>",
    "/root/login.html": "<p>login</p>",
  };

  const mount = (exclude: string[]) => {
    const app = new Hono();
    const exclusions = prepareStaticExclusions(exclude);
    if (exclusions.length > 0) {
      app.use("/*", async (c, next) =>
        isExcludedFromPublicStatic(c.req.path, exclusions)
          ? c.notFound()
          : next()
      );
    }
    app.use(
      "/*",
      serveStatic({
        root: "/root",
        rewriteRequestPath: (path) => path.replace(/^\/public/, "/"),
        join,
        getContent: async (path) => FILES[path] ?? null,
        // `stat` reports a directory whether or not the path ends in a slash;
        // trim it so a request for "/bundle/" resolves its index.html the way
        // it does against a real filesystem.
        isDir: (path) => {
          const dir = path.replace(/\/+$/, "");
          return Object.keys(FILES).some((file) => file.startsWith(dir + "/"));
        },
      })
    );
    return app;
  };

  const PATHS = [
    "/bundle/index.html",
    "/bundle/",
    "/bundle",
    "/public/bundle/index.html",
    "/publicbundle/index.html",
    "/%62undle/index.html",
    "/./bundle/index.html",
    "/x/../bundle/index.html",
  ];

  it("serves every alias without exclusions", async () => {
    const app = mount([]);
    for (const path of PATHS) {
      const res = await app.request(`http://x${path}`);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }
  });

  it("blocks every alias with the subtree excluded", async () => {
    const app = mount(["bundle"]);
    for (const path of PATHS) {
      const res = await app.request(`http://x${path}`);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
  });

  it("keeps the rest of the folder reachable", async () => {
    const app = mount(["bundle"]);
    for (const path of ["/login.html", "/public/login.html"]) {
      const res = await app.request(`http://x${path}`);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }
  });
});
