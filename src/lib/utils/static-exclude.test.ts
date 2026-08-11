import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { serveStatic } from "hono/serve-static";
import { join } from "node:path";
import {
  isExcludedFromPrivateStatic,
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

/**
 * The private mount's counterpart. Same matching, other prefix: what the public
 * side reaches under `/bundle`, the private side reaches under `/static/bundle`.
 * The entries stay relative to the mount, so a deployment writes `["app"]` and
 * not `["static", "app"]`.
 */
describe("isExcludedFromPrivateStatic", () => {
  it("keeps the whole mount behind the login when nothing is configured", () => {
    expect(isExcludedFromPrivateStatic("/static/app/index.html", [])).toBe(
      false
    );
  });

  it("opens the subtree and its root", () => {
    const p = prepared("app");
    expect(isExcludedFromPrivateStatic("/static/app", p)).toBe(true);
    expect(isExcludedFromPrivateStatic("/static/app/", p)).toBe(true);
    expect(isExcludedFromPrivateStatic("/static/app/index.html", p)).toBe(true);
    expect(isExcludedFromPrivateStatic("/static/app/assets/x.js", p)).toBe(true);
  });

  it("leaves the rest of the private folder protected", () => {
    const p = prepared("app");
    for (const path of [
      "/static/",
      "/static/internal/report.pdf",
      "/static/app-internal/x",
      "/static/apps/x",
    ]) {
      expect(isExcludedFromPrivateStatic(path, p)).toBe(false);
    }
  });

  /*
   * The same alias tricks as on the public side — the private mount strips a
   * literal "/static", without a segment boundary, and the handler decodes and
   * resolves the path before the filesystem lookup. An opened subtree must not
   * be reachable under a name that resolves *outside* it, and a protected file
   * must not be reachable under a name that resolves *into* it.
   */
  it("sees through the /static rewrite and its missing boundary", () => {
    const p = prepared("app");
    expect(isExcludedFromPrivateStatic("/staticapp/index.html", p)).toBe(true);
    expect(isExcludedFromPrivateStatic("/static/%61pp/index.html", p)).toBe(
      true
    );
    expect(isExcludedFromPrivateStatic("/static/x/../app/index.html", p)).toBe(
      true
    );
  });

  it("does not open a protected file that only looks like it is inside", () => {
    const p = prepared("app");
    // resolves to /internal/secret.pdf, i.e. outside the opened subtree
    expect(
      isExcludedFromPrivateStatic("/static/app/../internal/secret.pdf", p)
    ).toBe(false);
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

/**
 * The private mount with an opened subtree, wired exactly like `defineServer`
 * does: the exclusion decides whether the auth middleware runs at all, and the
 * static handler behind it is the same in both cases.
 *
 * What must hold: the opened bundle is served to an anonymous request under every
 * alias that resolves into it, and everything else still redirects to the login —
 * including a path that only looks like it is inside the bundle.
 */
describe("in front of the private static mount", () => {
  const FILES: Record<string, string> = {
    "/root/app/index.html": "<p>spa</p>",
    "/root/app/assets/app.js": "console.log(1)",
    "/root/internal/secret.pdf": "%PDF",
  };

  const LOGIN = "/login.html";

  const mount = (exclude: string[]) => {
    const app = new Hono();
    const exclusions = prepareStaticExclusions(exclude);

    app.use(
      "/static/*",
      async (c, next) => {
        if (isExcludedFromPrivateStatic(c.req.path, exclusions)) return next();
        // stands in for authOrRedirectToLogin with no session present
        return c.redirect(LOGIN);
      },
      serveStatic({
        root: "/root",
        rewriteRequestPath: (path) => path.replace(/^\/static/, "/"),
        join,
        getContent: async (path) => FILES[path] ?? null,
        isDir: (path) => {
          const dir = path.replace(/\/+$/, "");
          return Object.keys(FILES).some((file) => file.startsWith(dir + "/"));
        },
      })
    );
    return app;
  };

  const BUNDLE_PATHS = [
    "/static/app/index.html",
    "/static/app/",
    "/static/app",
    "/static/app/assets/app.js",
    "/static/%61pp/index.html",
    "/static/./app/index.html",
    "/static/x/../app/index.html",
  ];

  it("redirects anonymous requests for the bundle without the exclusion", async () => {
    const app = mount([]);
    for (const path of BUNDLE_PATHS) {
      const res = await app.request(`http://x${path}`);
      expect({ path, status: res.status }).toEqual({ path, status: 302 });
    }
  });

  it("serves the opened bundle to an anonymous request", async () => {
    const app = mount(["app"]);
    for (const path of BUNDLE_PATHS) {
      const res = await app.request(`http://x${path}`);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }
  });

  /*
   * The rewrite's missing segment boundary — "/staticapp/x" becoming "/app/x" —
   * is the one public-side alias that has no private-side counterpart: the mount
   * is registered for "/static/*", so a path that does not start with that
   * prefix never reaches this middleware at all. `isExcludedFromPrivateStatic`
   * still classifies it, which costs nothing and keeps the matcher correct if the
   * mount pattern is ever widened.
   */
  it("does not reach the mount at all without the /static/ prefix", async () => {
    for (const exclude of [[], ["app"]]) {
      const res = await mount(exclude).request("http://x/staticapp/index.html");
      expect({ exclude, status: res.status }).toEqual({ exclude, status: 404 });
    }
  });

  it("keeps the rest of the private folder behind the login", async () => {
    const app = mount(["app"]);
    for (const path of [
      "/static/internal/secret.pdf",
      // resolves out of the bundle again — the alias must not smuggle it out
      "/static/app/../internal/secret.pdf",
    ]) {
      const res = await app.request(`http://x${path}`);
      expect({ path, status: res.status }).toEqual({ path, status: 302 });
      expect(res.headers.get("location")).toBe(LOGIN);
    }
  });
});
