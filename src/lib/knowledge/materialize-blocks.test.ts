import { describe, it, expect } from "bun:test";
import { materializeBlocksText, renderBlockText } from "./materialize-blocks";

/**
 * The materialized text is what every full-text consumer reads: search,
 * embedding, export, and the agentic read/edit tools. Anything the html → markdown
 * projection cannot express is therefore invisible to all of them at once, which
 * is why these two shapes get their own tests — both used to lose content.
 */
const md = (html: string): string => renderBlockText({ type: "html", content: html });

/** What TipTap saves for a table: a colgroup, tbody, and cells wrapping <p>. */
const editorTable =
  '<table style="min-width: 50px;">' +
  '<colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup>' +
  "<tbody>" +
  '<tr><th colspan="1" rowspan="1"><p>Paket</p></th><th colspan="1" rowspan="1"><p>Preis</p></th></tr>' +
  '<tr><td colspan="1" rowspan="1"><p>Basis</p></td><td colspan="1" rowspan="1"><p>10 EUR</p></td></tr>' +
  "</tbody></table>";

/** What TipTap saves for a checklist: the checkbox in a label, the text in a div. */
const editorTaskList =
  '<ul data-type="taskList">' +
  '<li data-checked="true" data-type="taskItem">' +
  '<label><input type="checkbox" checked="checked"><span></span></label>' +
  "<div><p>erledigt</p></div></li>" +
  '<li data-checked="false" data-type="taskItem">' +
  '<label><input type="checkbox"><span></span></label>' +
  "<div><p>offen</p></div></li>" +
  "</ul>";

describe("materializeBlocksText — tables", () => {
  it("renders a table saved in the editor as a markdown table", () => {
    // The colgroup used to make turndown-plugin-gfm keep the whole table as raw
    // html, so table markup ended up in the page text — unsearchable, and
    // unreadable for anyone consuming the text.
    expect(md(editorTable)).toBe(
      "| Paket | Preis |\n| --- | --- |\n| Basis | 10 EUR |"
    );
  });

  it("renders a plain table and one with an explicit thead", () => {
    expect(md("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>")).toBe(
      "| A | B |\n| --- | --- |\n| 1 | 2 |"
    );
    expect(
      md("<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>")
    ).toBe("| A |\n| --- |\n| 1 |");
  });

  it("gives a table without a header row an empty header", () => {
    // GFM has no headerless table. An empty header keeps every data row
    // readable, where relabelling the first row would turn data into a heading.
    expect(md("<table><tbody><tr><td>A</td></tr><tr><td>1</td></tr></tbody></table>")).toBe(
      "|  |\n| --- |\n| A |\n| 1 |"
    );
  });

  it("keeps cell content that would otherwise break the row apart", () => {
    // a literal pipe would end the cell early
    expect(md("<table><tr><th>A|B</th></tr><tr><td>x|y</td></tr></table>")).toBe(
      "| A\\|B |\n| --- |\n| x\\|y |"
    );
    // inline formatting survives, block wrappers do not add newlines
    expect(
      md("<table><tr><th>A</th></tr><tr><td><p>Der <strong>Preis</strong></p></td></tr></table>")
    ).toBe("| A |\n| --- |\n| Der **Preis** |");
    // a short row is padded to the table's width
    expect(md("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td></tr></table>")).toBe(
      "| A | B |\n| --- | --- |\n| 1 |  |"
    );
  });

  it("keeps a page reference inside a cell as a plain marker", () => {
    expect(
      md(
        "<table><tr><th>Seite</th></tr><tr><td><p>" +
          '<code data-wiki-link="04 Historie">[[04 Historie]]</code></p></td></tr></table>'
      )
    ).toBe("| Seite |\n| --- |\n| [[04 Historie]] |");
  });

  it("renders an empty table as nothing", () => {
    expect(md("<table></table>")).toBe("");
  });
});

describe("materializeBlocksText — task lists", () => {
  it("keeps the checked state of a checklist saved in the editor", () => {
    // Without this a checklist read as a plain bullet list: neither a reader nor
    // an agent could tell done from open.
    expect(md(editorTaskList)).toBe("*   [x] erledigt\n*   [ ] offen");
  });

  it("keeps nesting and inline formatting inside a task item", () => {
    const nested =
      '<ul data-type="taskList"><li data-checked="false" data-type="taskItem">' +
      '<label><input type="checkbox"></label><div><p>Der <strong>Preis</strong> fehlt</p>' +
      '<ul data-type="taskList"><li data-checked="true" data-type="taskItem">' +
      '<label><input type="checkbox" checked="checked"></label><div><p>unten</p></div>' +
      "</li></ul></div></li></ul>";

    expect(md(nested)).toBe(
      "*   [ ] Der **Preis** fehlt\n    \n    *   [x] unten"
    );
  });

  it("also handles the shape a markdown task list renders to", () => {
    expect(
      md(
        '<ul><li><input disabled="" type="checkbox"> offen</li>' +
          '<li><input checked="" disabled="" type="checkbox"> erledigt</li></ul>'
      )
    ).toBe("*   [ ] offen\n*   [x] erledigt");
  });

  it("leaves a plain bullet list alone", () => {
    expect(md("<ul><li>eins</li><li>zwei</li></ul>")).toBe("*   eins\n*   zwei");
  });
});

describe("materializeBlocksText — assembly", () => {
  it("joins blocks with a blank line and drops empty ones", () => {
    expect(
      materializeBlocksText([
        { type: "html", content: "<p>Preisliste:</p>" },
        { type: "html", content: "" },
        { type: "html", content: editorTable },
      ])
    ).toBe("Preisliste:\n\n| Paket | Preis |\n| --- | --- |\n| Basis | 10 EUR |");
  });
});

describe("materializeBlocksText — images", () => {
  const SRC = "/files/db/knowledge/33333333-3333-3333-3333-333333333333.png";

  it("materializes an image without a description exactly as before", () => {
    expect(md(`<img src="${SRC}" alt="Schaltplan">`)).toBe(
      `![Schaltplan](${SRC})`
    );
    expect(md(`<img src="${SRC}">`)).toBe(`![](${SRC})`);
    expect(md(`<img src="${SRC}" alt="a" title="t">`)).toBe(
      `![a](${SRC} "t")`
    );
    // the editor's own attributes are decoration, not content
    expect(
      md(`<img src="${SRC}" alt="a" data-size="lg" data-align="center">`)
    ).toBe(`![a](${SRC})`);
    expect(md('<img alt="no src">')).toBe("");
  });

  it("emits the description as a marker below the image", () => {
    expect(
      md(
        `<img src="${SRC}" alt="Schaltplan" data-description="Steuerplatine: links das Netzteil.">`
      )
    ).toBe(
      `![Schaltplan](${SRC})\n` +
        `<image-description src="${SRC}">Steuerplatine: links das Netzteil.</image-description>`
    );
  });

  it("keeps the description on one line and escapes it", () => {
    expect(
      md(
        `<img src="${SRC}" alt="a" data-description="Zeile eins&#10;  Zeile zwei &amp; &lt;mehr&gt;">`
      )
    ).toBe(
      `![a](${SRC})\n` +
        `<image-description src="${SRC}">Zeile eins Zeile zwei &amp; &lt;mehr&gt;</image-description>`
    );
  });

  it("ignores an empty description attribute", () => {
    expect(md(`<img src="${SRC}" alt="a" data-description="   ">`)).toBe(
      `![a](${SRC})`
    );
  });

  it("describes each image of a block separately", () => {
    const other = "/files/db/images/44444444-4444-4444-4444-444444444444.jpg";
    expect(
      md(
        `<img src="${SRC}" alt="a" data-description="Erstes">` +
          `<img src="${other}" alt="b" data-description="Zweites">`
      )
    ).toBe(
      `![a](${SRC})\n<image-description src="${SRC}">Erstes</image-description>` +
        `![b](${other})\n<image-description src="${other}">Zweites</image-description>`
    );
  });

  it("survives the trip through a paragraph and stays with its image", () => {
    expect(
      md(
        `<p>Vorher</p><p><img src="${SRC}" alt="a" data-description="Beschreibung"></p><p>Nachher</p>`
      )
    ).toBe(
      `Vorher\n\n![a](${SRC})\n<image-description src="${SRC}">Beschreibung</image-description>\n\nNachher`
    );
  });
});
