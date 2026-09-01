import { describe, it, expect } from "bun:test";
import {
  containsImageDescription,
  extractImageDescriptions,
  imageDescriptionMarker,
  normalizeImageDescription,
  stripImageDescriptions,
} from "./image-descriptions";

const SRC = "/files/db/knowledge/11111111-1111-1111-1111-111111111111.png";

describe("normalizeImageDescription", () => {
  it("collapses every whitespace run to one space and trims", () => {
    expect(normalizeImageDescription("  Schaltplan\n\n  der   Platine \t")).toBe(
      "Schaltplan der Platine"
    );
  });

  it("maps everything empty to null, so 'no description' has one form", () => {
    expect(normalizeImageDescription(null)).toBeNull();
    expect(normalizeImageDescription(undefined)).toBeNull();
    expect(normalizeImageDescription("")).toBeNull();
    expect(normalizeImageDescription("   \n  ")).toBeNull();
  });
});

describe("imageDescriptionMarker", () => {
  it("builds the marker", () => {
    expect(imageDescriptionMarker(SRC, "Schaltplan")).toBe(
      `<image-description src="${SRC}">Schaltplan</image-description>`
    );
  });

  it("is empty when there is nothing to say", () => {
    expect(imageDescriptionMarker(SRC, "  ")).toBe("");
    expect(imageDescriptionMarker(SRC, null)).toBe("");
  });

  it("escapes text and attribute so the marker cannot be broken from inside", () => {
    const marker = imageDescriptionMarker(
      '/x.png"onload="alert(1)',
      'A <b>bold</b> & "quoted" caption'
    );
    // the attribute also loses its quotes; in text content a quote is literal
    expect(marker).toBe(
      '<image-description src="/x.png&quot;onload=&quot;alert(1)">' +
        'A &lt;b&gt;bold&lt;/b&gt; &amp; "quoted" caption' +
        "</image-description>"
    );
  });

  it("round-trips through the extraction", () => {
    const text = `![x](${SRC})\n${imageDescriptionMarker(SRC, 'A <b> & "q"')}`;
    expect(extractImageDescriptions(text)).toEqual({ [SRC]: 'A <b> & "q"' });
  });
});

describe("extractImageDescriptions", () => {
  it("keys the descriptions by the image they describe", () => {
    const other = "/files/db/images/22222222-2222-2222-2222-222222222222.jpg";
    const text =
      `![a](${SRC})\n<image-description src="${SRC}">Erstes Bild</image-description>\n\n` +
      `![b](${other})\n<image-description src="${other}">Zweites Bild</image-description>`;
    expect(extractImageDescriptions(text)).toEqual({
      [SRC]: "Erstes Bild",
      [other]: "Zweites Bild",
    });
  });

  it("does not run one marker into the next", () => {
    const text =
      `<image-description src="/a.png">A</image-description>` +
      `<image-description src="/b.png">B</image-description>`;
    expect(extractImageDescriptions(text)).toEqual({
      "/a.png": "A",
      "/b.png": "B",
    });
  });

  it("tolerates what an agent writes by hand", () => {
    const text =
      `<image-description  data-x='1'  src='${SRC}' >\n  Mehrzeilig\n  getippt\n</image-description >`;
    expect(extractImageDescriptions(text)).toEqual({
      [SRC]: "Mehrzeilig getippt",
    });
  });

  it("skips markers without a src or without text", () => {
    expect(
      extractImageDescriptions(
        `<image-description>orphan</image-description>` +
          `<image-description src="${SRC}">   </image-description>`
      )
    ).toEqual({});
  });

  it("keeps the first description of a repeated image", () => {
    expect(
      extractImageDescriptions(
        `<image-description src="${SRC}">Naht am Bild</image-description>` +
          `<image-description src="${SRC}">Weiter unten</image-description>`
      )
    ).toEqual({ [SRC]: "Naht am Bild" });
  });

  it("returns nothing for content without markers", () => {
    expect(extractImageDescriptions(`![a](${SRC})`)).toEqual({});
    expect(containsImageDescription(`![a](${SRC})`)).toBe(false);
  });
});

describe("stripImageDescriptions", () => {
  it("takes the whole line when the marker sits alone on it", () => {
    const text =
      `# Titel\n\n![a](${SRC})\n<image-description src="${SRC}">Schaltplan</image-description>\n\nWeiter.`;
    expect(stripImageDescriptions(text)).toBe(
      `# Titel\n\n![a](${SRC})\n\nWeiter.`
    );
  });

  it("removes an inline marker without eating its neighbours", () => {
    expect(
      stripImageDescriptions(
        `Text ![a](${SRC}) <image-description src="${SRC}">x</image-description> danach`
      )
    ).toBe(`Text ![a](${SRC})  danach`);
  });

  it("leaves content without markers untouched", () => {
    const text = `![a](${SRC})\n\nNur Text.`;
    expect(stripImageDescriptions(text)).toBe(text);
  });
});
