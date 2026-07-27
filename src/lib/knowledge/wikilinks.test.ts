import { describe, it, expect } from "bun:test";
import {
  containsWikiLinkMarker,
  unescapeWikiLinkMarkers,
  wikiLinkHtml,
  wikiLinkMarker,
  wikiLinksToHtml,
  PAGE_LINK_PATTERN,
} from "./wikilinks";
import { materializeBlocksText } from "./materialize-blocks";

/**
 * The extraction as `knowledge-text-links.ts` runs it (that module talks to
 * the DB, so the pattern is exercised directly here).
 */
const extractPageLinkTargets = (content: string): string[] => [
  ...new Set(
    [...content.matchAll(PAGE_LINK_PATTERN)].map((m) => m[1]!.trim())
  ),
];

describe("wikilink markers", () => {
  it("detects markers", () => {
    expect(containsWikiLinkMarker("see [[Onboarding]] first")).toBe(true);
    expect(containsWikiLinkMarker("a [link](http://x) and [brackets]")).toBe(
      false
    );
    // a global regex must not carry lastIndex over between calls
    expect(containsWikiLinkMarker("[[A]]")).toBe(true);
    expect(containsWikiLinkMarker("[[A]]")).toBe(true);
  });

  it("builds the marker with and without an alias", () => {
    expect(wikiLinkMarker("Home Office")).toBe("[[Home Office]]");
    expect(wikiLinkMarker("Home Office", "wfh")).toBe("[[Home Office|wfh]]");
  });

  it("lifts plain markers into the editor's canonical html", () => {
    expect(wikiLinksToHtml("<p>siehe [[03.03.01 Systemhaus]] hier</p>")).toBe(
      `<p>siehe ${wikiLinkHtml("03.03.01 Systemhaus")} hier</p>`
    );
    expect(wikiLinksToHtml("<p>[[Home Office|wfh]]</p>")).toBe(
      `<p>${wikiLinkHtml("Home Office", "wfh")}</p>`
    );
  });

  it("leaves references that are already canonical alone (idempotent)", () => {
    const once = wikiLinksToHtml("<p>a [[Target]] b</p>");
    expect(wikiLinksToHtml(once)).toBe(once);
  });

  it("never touches code / pre content or tag attributes", () => {
    const code = "<pre><code>if (a[[0]]) {}</code></pre>";
    expect(wikiLinksToHtml(code)).toBe(code);
    const attr = '<a href="/x?q=[[Target]]">x</a>';
    expect(wikiLinksToHtml(attr)).toBe(attr);
  });

  it("escapes html in target and alias", () => {
    const html = wikiLinksToHtml('<p>[[A & B|"x"]]</p>');
    expect(html).toContain('data-wiki-link="A &amp; B"');
    expect(html).toContain('data-wiki-alias="&quot;x&quot;"');
    expect(html).toContain('[[A &amp; B|"x"]]');
  });

  it("does not build a reference out of a marker containing markup", () => {
    const withTag = '<p>[[A<script>alert(1)</script>]]</p>';
    expect(wikiLinksToHtml(withTag)).toBe(withTag);
  });

  it("heals an escaped marker into a real reference", () => {
    expect(wikiLinksToHtml("<p>siehe \\[\\[Systemhaus\\]\\] hier</p>")).toBe(
      `<p>siehe ${wikiLinkHtml("Systemhaus")} hier</p>`
    );
  });

  it("restores markers escaped by turndown", () => {
    expect(unescapeWikiLinkMarkers("siehe \\[\\[Systemhaus\\]\\] hier")).toBe(
      "siehe [[Systemhaus]] hier"
    );
    expect(unescapeWikiLinkMarkers("\\[\\[Home Office\\|wfh\\]\\]")).toBe(
      "[[Home Office|wfh]]"
    );
    // unrelated escaped brackets stay escaped
    expect(unescapeWikiLinkMarkers("\\[not a link\\]")).toBe(
      "\\[not a link\\]"
    );
  });
});

describe("materializing blocks with references", () => {
  it("renders a canonical reference back to a plain marker", () => {
    const text = materializeBlocksText([
      {
        type: "html",
        content: `<p>Zwei Ausprägungen: ${wikiLinkHtml(
          "03.03.01 Systemhaus"
        )} und ${wikiLinkHtml("03.03.01 Elektriker", "Elektriker")}.</p>`,
      },
    ]);

    expect(text).toBe(
      "Zwei Ausprägungen: [[03.03.01 Systemhaus]] und " +
        "[[03.03.01 Elektriker|Elektriker]]."
    );
    expect(extractPageLinkTargets(text)).toEqual([
      "03.03.01 Systemhaus",
      "03.03.01 Elektriker",
    ]);
  });

  it("keeps a bare marker in an html block extractable (no \\[\\[)", () => {
    const text = materializeBlocksText([
      { type: "html", content: "<p>siehe [[Onboarding]]</p>" },
    ]);

    expect(text).toBe("siehe [[Onboarding]]");
    expect(extractPageLinkTargets(text)).toEqual(["Onboarding"]);
  });

  it("leaves markdown blocks verbatim", () => {
    const text = materializeBlocksText([
      { type: "markdown", content: "siehe [[Onboarding]]" },
    ]);
    expect(text).toBe("siehe [[Onboarding]]");
  });
});
