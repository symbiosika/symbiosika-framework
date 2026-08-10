import { describe, it, expect, beforeAll } from "bun:test";
import {
  readKnowledgeTextContent,
  editKnowledgeTextContent,
} from "./knowledge-text-edit";
import { createKnowledgeText } from "./knowledge-texts";
import {
  syncKnowledgeTextBlocks,
  getKnowledgeTextBlocks,
} from "./knowledge-text-blocks";
import { getKnowledgeTextLinks } from "./knowledge-text-links";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";

const ctx = { tenantId: TEST_ORGANISATION_1.id };

const createPage = async (text: string) =>
  await createKnowledgeText({
    title: `Edit Test ${crypto.randomUUID()}`,
    text,
    tenantId: TEST_ORGANISATION_1.id,
  });

describe("Knowledge Text Read (file-like)", () => {
  beforeAll(async () => {
    await initTests();
  });

  it("reads the full content with line metadata", async () => {
    const page = await createPage("line one\nline two\nline three");
    const view = await readKnowledgeTextContent(page.id, ctx);

    expect(view.content).toBe("line one\nline two\nline three");
    expect(view.fromLine).toBe(1);
    expect(view.toLine).toBe(3);
    expect(view.totalLines).toBe(3);
    expect(view.contentMode).toBe("text");
  });

  it("reads a line range", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const page = await createPage(lines.join("\n"));

    const view = await readKnowledgeTextContent(page.id, ctx, {
      fromLine: 5,
      maxLines: 3,
    });

    expect(view.content).toBe("line 5\nline 6\nline 7");
    expect(view.fromLine).toBe(5);
    expect(view.toLine).toBe(7);
    expect(view.totalLines).toBe(20);
  });

  it("rejects fromLine beyond the end", async () => {
    const page = await createPage("only one line");
    await expect(
      readKnowledgeTextContent(page.id, ctx, { fromLine: 99 })
    ).rejects.toThrow("beyond the end");
  });
});

describe("Knowledge Text Edit (string replacement)", () => {
  beforeAll(async () => {
    await initTests();
  });

  it("replaces a unique string in a text page", async () => {
    const page = await createPage("The old value should change.");
    const result = await editKnowledgeTextContent(
      page.id,
      { oldString: "old value", newString: "new value" },
      ctx
    );

    expect(result.replacements).toBe(1);
    expect(result.content).toBe("The new value should change.");
  });

  it("rejects a non-unique string without replaceAll", async () => {
    const page = await createPage("dup here and dup there");
    await expect(
      editKnowledgeTextContent(
        page.id,
        { oldString: "dup", newString: "x" },
        ctx
      )
    ).rejects.toThrow("not unique");
  });

  it("replaces all occurrences with replaceAll", async () => {
    const page = await createPage("dup here and dup there");
    const result = await editKnowledgeTextContent(
      page.id,
      { oldString: "dup", newString: "item", replaceAll: true },
      ctx
    );
    expect(result.replacements).toBe(2);
    expect(result.content).toBe("item here and item there");
  });

  it("rejects a string that does not exist", async () => {
    const page = await createPage("some content");
    await expect(
      editKnowledgeTextContent(
        page.id,
        { oldString: "missing", newString: "x" },
        ctx
      )
    ).rejects.toThrow("not found in the document");
  });

  it("edits inside the affected block of a block page", async () => {
    const page = await createPage("");
    const saved = await syncKnowledgeTextBlocks(
      page.id,
      [
        { type: "markdown", content: "# Stable heading" },
        { type: "markdown", content: "Body with a typo_here inside." },
      ],
      ctx
    );

    const result = await editKnowledgeTextContent(
      page.id,
      { oldString: "typo_here", newString: "correction" },
      ctx
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toContain("correction");

    // only the affected block changed, ids stayed stable
    const blocks = await getKnowledgeTextBlocks(page.id, ctx);
    expect(blocks.length).toBe(2);
    expect(blocks[0]?.id).toBe(saved.blocks[0]!.id);
    expect(blocks[0]?.content).toBe("# Stable heading");
    expect(blocks[1]?.id).toBe(saved.blocks[1]!.id);
    expect(blocks[1]?.content).toBe("Body with a correction inside.");
  });

  it("applies a non-empty replacement that spans block boundaries", async () => {
    const page = await createPage("");
    await syncKnowledgeTextBlocks(
      page.id,
      [
        { type: "markdown", content: "end of first" },
        { type: "markdown", content: "start of second" },
      ],
      ctx
    );

    // this string only exists in the materialized text across the block gap
    const result = await editKnowledgeTextContent(
      page.id,
      { oldString: "end of first\n\nstart of second", newString: "x" },
      ctx
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toBe("x");

    const blocks = await getKnowledgeTextBlocks(page.id, ctx);
    expect(blocks.map((b) => b.content)).toEqual(["x"]);
  });

  it("replaces several paragraphs at once with new multi-paragraph text", async () => {
    const page = await createPage("");
    await syncKnowledgeTextBlocks(
      page.id,
      [
        { type: "markdown", content: "Einleitung bleibt." },
        { type: "markdown", content: "Alter Absatz A." },
        { type: "markdown", content: "Alter Absatz B." },
        { type: "markdown", content: "Schluss bleibt." },
      ],
      ctx
    );

    const result = await editKnowledgeTextContent(
      page.id,
      {
        oldString: "Alter Absatz A.\n\nAlter Absatz B.",
        newString: "Neuer Absatz.",
      },
      ctx
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toBe(
      "Einleitung bleibt.\n\nNeuer Absatz.\n\nSchluss bleibt."
    );
  });

  it("drops a block that an edit empties instead of leaving a placeholder", async () => {
    const page = await createPage("");
    const saved = await syncKnowledgeTextBlocks(
      page.id,
      [
        { type: "markdown", content: "Keep me" },
        { type: "markdown", content: "Remove me entirely" },
        { type: "markdown", content: "Keep me too" },
      ],
      ctx
    );

    const result = await editKnowledgeTextContent(
      page.id,
      { oldString: "Remove me entirely", newString: "" },
      ctx
    );
    expect(result.replacements).toBe(1);

    const blocks = await getKnowledgeTextBlocks(page.id, ctx);
    expect(blocks.map((b) => b.content)).toEqual(["Keep me", "Keep me too"]);
    // surviving blocks kept their ids
    expect(blocks[0]?.id).toBe(saved.blocks[0]!.id);
    expect(blocks[1]?.id).toBe(saved.blocks[2]!.id);
    // no empty placeholder left behind in the materialized text
    expect(result.content).toBe("Keep me\n\nKeep me too");
  });

  it("removes multiple whole blocks at once when the deletion spans them", async () => {
    const page = await createPage("");
    const saved = await syncKnowledgeTextBlocks(
      page.id,
      [
        { type: "markdown", content: "Intro paragraph" },
        { type: "markdown", content: "Section to drop A" },
        { type: "markdown", content: "Section to drop B" },
        { type: "markdown", content: "Closing paragraph" },
      ],
      ctx
    );

    // oldString is copied verbatim from read_page_content: the two middle
    // blocks joined by the block separator, plus the leading separator.
    const result = await editKnowledgeTextContent(
      page.id,
      {
        oldString: "\n\nSection to drop A\n\nSection to drop B",
        newString: "",
      },
      ctx
    );
    expect(result.replacements).toBe(1);

    const blocks = await getKnowledgeTextBlocks(page.id, ctx);
    expect(blocks.map((b) => b.content)).toEqual([
      "Intro paragraph",
      "Closing paragraph",
    ]);
    expect(blocks[0]?.id).toBe(saved.blocks[0]!.id);
    expect(blocks[1]?.id).toBe(saved.blocks[3]!.id);
    expect(result.content).toBe("Intro paragraph\n\nClosing paragraph");
  });

  it("trims boundary blocks partially covered by a spanning deletion", async () => {
    const page = await createPage("");
    await syncKnowledgeTextBlocks(
      page.id,
      [
        { type: "markdown", content: "keep start remove tail" },
        { type: "markdown", content: "remove head keep end" },
      ],
      ctx
    );

    const result = await editKnowledgeTextContent(
      page.id,
      { oldString: "remove tail\n\nremove head", newString: "" },
      ctx
    );
    expect(result.replacements).toBe(1);

    // both boundary blocks survive (they still have content) and the
    // materialized text is clean — the removed middle is gone
    const blocks = await getKnowledgeTextBlocks(page.id, ctx);
    expect(blocks.length).toBe(2);
    expect(result.content).toBe("keep start\n\nkeep end");
  });

  it("rejects a spanning deletion that is not unique without replaceAll", async () => {
    const page = await createPage("");
    await syncKnowledgeTextBlocks(
      page.id,
      [
        { type: "markdown", content: "alpha" },
        { type: "markdown", content: "beta" },
        { type: "markdown", content: "alpha" },
        { type: "markdown", content: "beta" },
      ],
      ctx
    );

    // "alpha\n\nbeta" spans the 1↔2 and 3↔4 gaps: two occurrences
    await expect(
      editKnowledgeTextContent(
        page.id,
        { oldString: "alpha\n\nbeta", newString: "" },
        ctx
      )
    ).rejects.toThrow("not unique");

    // replaceAll removes every spanning occurrence, leaving no blocks
    const result = await editKnowledgeTextContent(
      page.id,
      { oldString: "alpha\n\nbeta", newString: "", replaceAll: true },
      ctx
    );
    expect(result.replacements).toBe(2);
    const blocks = await getKnowledgeTextBlocks(page.id, ctx);
    expect(blocks.length).toBe(0);
    expect(result.content).toBe("");
  });

  it("counts occurrences across blocks for uniqueness", async () => {
    const page = await createPage("");
    await syncKnowledgeTextBlocks(
      page.id,
      [
        { type: "markdown", content: "shared word" },
        { type: "markdown", content: "another shared word" },
      ],
      ctx
    );

    await expect(
      editKnowledgeTextContent(
        page.id,
        { oldString: "shared", newString: "x" },
        ctx
      )
    ).rejects.toThrow("not unique");

    const result = await editKnowledgeTextContent(
      page.id,
      { oldString: "shared", newString: "common", replaceAll: true },
      ctx
    );
    expect(result.replacements).toBe(2);
  });

  it("writes a [[wikilink]] into an html block as a real reference", async () => {
    const page = await createPage("");
    await syncKnowledgeTextBlocks(
      page.id,
      [
        {
          type: "html",
          content: "<p>Zwei Ausprägungen: Systemhaus und Elektriker.</p>",
        },
      ],
      ctx
    );

    const result = await editKnowledgeTextContent(
      page.id,
      {
        oldString: "Systemhaus und Elektriker",
        newString: "[[03.03.01 Systemhaus]] und [[03.03.01 Elektriker]]",
      },
      ctx
    );

    // stored in the editor's canonical form → a clickable chip, not text
    const blocks = await getKnowledgeTextBlocks(page.id, ctx);
    expect(blocks[0]!.content).toContain('data-wiki-link="03.03.01 Systemhaus"');
    expect(blocks[0]!.content).toContain(
      'data-wiki-link="03.03.01 Elektriker"'
    );
    // ...and the materialized text carries plain markers, no backslashes
    expect(result.content).toBe(
      "Zwei Ausprägungen: [[03.03.01 Systemhaus]] und [[03.03.01 Elektriker]]."
    );
    expect(result.content).not.toContain("\\[");

    const links = await getKnowledgeTextLinks(page.id, ctx);
    expect(links.map((l) => l.targetTitle).sort()).toEqual([
      "03.03.01 Elektriker",
      "03.03.01 Systemhaus",
    ]);
  });

  it("edits over a reference read back as a plain marker", async () => {
    const page = await createPage("");
    await syncKnowledgeTextBlocks(
      page.id,
      [
        {
          type: "html",
          content:
            '<p>Siehe <code data-wiki-link="Onboarding" class="wiki-link">' +
            "[[Onboarding]]</code> für den Start.</p>",
        },
      ],
      ctx
    );

    // the agent copies oldString out of read_page_content, where the
    // reference reads as the bare marker
    const view = await readKnowledgeTextContent(page.id, ctx);
    expect(view.content).toBe("Siehe [[Onboarding]] für den Start.");

    const result = await editKnowledgeTextContent(
      page.id,
      {
        oldString: "Siehe [[Onboarding]] für den Start.",
        newString: "Siehe [[Onboarding]] und [[Handbuch]].",
      },
      ctx
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toBe("Siehe [[Onboarding]] und [[Handbuch]].");

    const blocks = await getKnowledgeTextBlocks(page.id, ctx);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.content).toContain('data-wiki-link="Handbuch"');
  });

  it("edits over a reference the web editor stored with data-page-id", async () => {
    const page = await createPage("");
    // what the block editor saves for a RESOLVED reference: it adds
    // data-page-id, which wikiLinkHtml does not — so the html can never be
    // rebuilt byte-identically and must be matched structurally
    await syncKnowledgeTextBlocks(
      page.id,
      [
        {
          type: "html",
          content:
            "<p>Die Entstehung des Unternehmens beschreibt die " +
            '<code data-wiki-link="04 Historie" data-page-id="7f3d" ' +
            'class="wiki-link">[[04 Historie]]</code>.</p>',
        },
      ],
      ctx
    );

    const view = await readKnowledgeTextContent(page.id, ctx);
    expect(view.content).toBe(
      "Die Entstehung des Unternehmens beschreibt die [[04 Historie]]."
    );

    const result = await editKnowledgeTextContent(
      page.id,
      {
        oldString: view.content,
        newString: "Die Entstehung beschreibt die [[04 Historie]].",
      },
      ctx
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toBe("Die Entstehung beschreibt die [[04 Historie]].");
  });

  it("removes a reference the web editor stored with data-page-id", async () => {
    const page = await createPage("");
    await syncKnowledgeTextBlocks(
      page.id,
      [
        {
          type: "html",
          content:
            '<p>Mehr dazu <code data-wiki-link="04 Historie" ' +
            'data-page-id="7f3d" class="wiki-link">[[04 Historie]]</code> ' +
            "und Ende.</p>",
        },
      ],
      ctx
    );

    const result = await editKnowledgeTextContent(
      page.id,
      { oldString: " [[04 Historie]]", newString: "" },
      ctx
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toBe("Mehr dazu und Ende.");

    const blocks = await getKnowledgeTextBlocks(page.id, ctx);
    expect(blocks[0]!.content).not.toContain("data-wiki-link");
  });

  it("removes a whole section stored as html blocks", async () => {
    const page = await createPage("");
    const saved = await syncKnowledgeTextBlocks(
      page.id,
      [
        { type: "html", content: "<p>Der eigentliche Fließtext.</p>" },
        { type: "html", content: "<h2>Verwandte Artikel</h2>" },
        {
          type: "html",
          content:
            "<ul><li>" +
            '<code data-wiki-link="04 Historie" data-page-id="a1" ' +
            'class="wiki-link">[[04 Historie]]</code></li><li>' +
            '<code data-wiki-link="01 Pflegemarkt" data-page-id="b2" ' +
            'class="wiki-link">[[01 Pflegemarkt]]</code></li></ul>',
        },
      ],
      ctx
    );

    const view = await readKnowledgeTextContent(page.id, ctx);
    // everything after the intro paragraph, copied verbatim out of the read
    const oldString = view.content.slice("Der eigentliche Fließtext.".length);

    const result = await editKnowledgeTextContent(
      page.id,
      { oldString, newString: "" },
      ctx
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toBe("Der eigentliche Fließtext.");

    const blocks = await getKnowledgeTextBlocks(page.id, ctx);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.id).toBe(saved.blocks[0]!.id);
  });

  it("matches text whose html carries entities and line breaks", async () => {
    const page = await createPage("");
    await syncKnowledgeTextBlocks(
      page.id,
      [
        {
          type: "html",
          content:
            "<p>Pflege\n   &amp; Betreuung f&uuml;r Tr&auml;ger</p>",
        },
      ],
      ctx
    );

    const view = await readKnowledgeTextContent(page.id, ctx);
    expect(view.content).toBe("Pflege & Betreuung für Träger");

    const result = await editKnowledgeTextContent(
      page.id,
      { oldString: "Pflege & Betreuung", newString: "Pflege und Betreuung" },
      ctx
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toBe("Pflege und Betreuung für Träger");
  });

  it("writes a replacement with line breaks as a markdown block", async () => {
    const page = await createPage("");
    await syncKnowledgeTextBlocks(
      page.id,
      [{ type: "html", content: "<p>Siehe auch die Nachbarseiten.</p>" }],
      ctx
    );

    const result = await editKnowledgeTextContent(
      page.id,
      {
        oldString: "Siehe auch die Nachbarseiten.",
        newString: "Siehe auch:\n\n- [[04 Historie]]\n- [[01 Pflegemarkt]]",
      },
      ctx
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toBe(
      "Siehe auch:\n\n- [[04 Historie]]\n- [[01 Pflegemarkt]]"
    );

    // html cannot carry the list, so the block is stored as markdown
    const blocks = await getKnowledgeTextBlocks(page.id, ctx);
    expect(blocks[0]!.type).toBe("markdown");

    const links = await getKnowledgeTextLinks(page.id, ctx);
    expect(links.map((l) => l.targetTitle).sort()).toEqual([
      "01 Pflegemarkt",
      "04 Historie",
    ]);
  });

  it("keeps an html block as html when the replacement fits in it", async () => {
    const page = await createPage("");
    await syncKnowledgeTextBlocks(
      page.id,
      [{ type: "html", content: "<p>Wir betreuen Kunden im Pflegemarkt.</p>" }],
      ctx
    );

    const result = await editKnowledgeTextContent(
      page.id,
      { oldString: "im Pflegemarkt", newString: "im Bildungsmarkt" },
      ctx
    );
    expect(result.content).toBe("Wir betreuen Kunden im Bildungsmarkt.");

    const blocks = await getKnowledgeTextBlocks(page.id, ctx);
    expect(blocks[0]!.type).toBe("html");
    expect(blocks[0]!.content).toBe(
      "<p>Wir betreuen Kunden im Bildungsmarkt.</p>"
    );
  });

  it("trims an html block that a spanning deletion cuts into", async () => {
    const page = await createPage("");
    await syncKnowledgeTextBlocks(
      page.id,
      [
        { type: "markdown", content: "erster Block" },
        { type: "html", content: "<p>Anfang bleibt, Ende geht weg.</p>" },
      ],
      ctx
    );

    const result = await editKnowledgeTextContent(
      page.id,
      { oldString: "erster Block\n\nAnfang bleibt,", newString: "" },
      ctx
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toBe("Ende geht weg.");
  });

  it("edits text the projection formats (bold, heading, list)", async () => {
    const page = await createPage("");
    await syncKnowledgeTextBlocks(
      page.id,
      [
        { type: "html", content: "<h2>Abrechnung und Preise</h2>" },
        {
          type: "html",
          content:
            "<p>Der <strong>Listenpreis</strong> beträgt 10 EUR pro Monat.</p>",
        },
      ],
      ctx
    );

    // the agent copies oldString verbatim out of read_page_content, where the
    // bold word reads as **Listenpreis** — invisible in the stored html
    const view = await readKnowledgeTextContent(page.id, ctx);
    expect(view.content).toBe(
      "## Abrechnung und Preise\n\n" +
        "Der **Listenpreis** beträgt 10 EUR pro Monat."
    );

    const result = await editKnowledgeTextContent(
      page.id,
      {
        oldString: "Der **Listenpreis** beträgt 10 EUR pro Monat.",
        newString: "Der **Listenpreis** beträgt 12 EUR pro Monat.",
      },
      ctx
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toBe(
      "## Abrechnung und Preise\n\n" +
        "Der **Listenpreis** beträgt 12 EUR pro Monat."
    );

    // only the edited block changed format; the heading block is untouched
    const blocks = await getKnowledgeTextBlocks(page.id, ctx);
    expect(blocks[0]!.content).toBe("<h2>Abrechnung und Preise</h2>");
    expect(blocks[1]!.type).toBe("markdown");
  });

  it("edits a heading stored as an html block", async () => {
    const page = await createPage("");
    await syncKnowledgeTextBlocks(
      page.id,
      [
        { type: "html", content: "<h2>Alte Überschrift</h2>" },
        { type: "html", content: "<p>Text darunter.</p>" },
      ],
      ctx
    );

    const result = await editKnowledgeTextContent(
      page.id,
      { oldString: "## Alte Überschrift", newString: "## Neue Überschrift" },
      ctx
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toBe("## Neue Überschrift\n\nText darunter.");
  });

  it("edits one item of a list stored as an html block", async () => {
    const page = await createPage("");
    await syncKnowledgeTextBlocks(
      page.id,
      [
        {
          type: "html",
          content: "<ul><li>Punkt eins</li><li>Punkt zwei</li></ul>",
        },
      ],
      ctx
    );

    // plain text inside a list item still matches the stored html directly
    const result = await editKnowledgeTextContent(
      page.id,
      { oldString: "Punkt zwei", newString: "Punkt drei" },
      ctx
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toContain("Punkt drei");

    const blocks = await getKnowledgeTextBlocks(page.id, ctx);
    expect(blocks[0]!.type).toBe("html");
  });

  it("rejects empty or identical strings", async () => {
    const page = await createPage("content");
    await expect(
      editKnowledgeTextContent(
        page.id,
        { oldString: "", newString: "x" },
        ctx
      )
    ).rejects.toThrow("must not be empty");
    await expect(
      editKnowledgeTextContent(
        page.id,
        { oldString: "content", newString: "content" },
        ctx
      )
    ).rejects.toThrow("identical");
  });
});
