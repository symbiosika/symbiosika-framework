import { describe, it, expect, beforeAll } from "bun:test";
import {
  extractWikilinkTargets,
  getKnowledgeTextLinks,
  getKnowledgeTextBacklinks,
  getRelatedKnowledgeTexts,
} from "./knowledge-text-links";
import {
  createKnowledgeText,
  updateKnowledgeText,
  deleteKnowledgeText,
} from "./knowledge-texts";
import { syncKnowledgeTextBlocks } from "./knowledge-text-blocks";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";

const ctx = { tenantId: TEST_ORGANISATION_1.id };

const uniqueTitle = (name: string) => `${name} ${crypto.randomUUID()}`;

describe("extractWikilinkTargets", () => {
  it("extracts plain and aliased wikilinks", () => {
    const targets = extractWikilinkTargets(
      "See [[Vacation Policy]] and [[Home Office|working from home]]."
    );
    expect(targets).toEqual(["Vacation Policy", "Home Office"]);
  });

  it("deduplicates and trims targets", () => {
    const targets = extractWikilinkTargets(
      "[[ Onboarding ]] then [[Onboarding]] again"
    );
    expect(targets).toEqual(["Onboarding"]);
  });

  it("ignores malformed markers", () => {
    expect(extractWikilinkTargets("[[]] [[|only alias]] [not a link]")).toEqual(
      []
    );
  });
});

describe("Knowledge Text Links", () => {
  beforeAll(async () => {
    await initTests();
  });

  it("resolves links to existing pages on save", async () => {
    const targetTitle = uniqueTitle("Link Target");
    const target = await createKnowledgeText({
      title: targetTitle,
      text: "target content",
      tenantId: ctx.tenantId,
    });

    const source = await createKnowledgeText({
      title: uniqueTitle("Link Source"),
      text: `Please read [[${targetTitle}]] first.`,
      tenantId: ctx.tenantId,
    });

    const links = await getKnowledgeTextLinks(source.id, ctx);
    expect(links.length).toBe(1);
    expect(links[0]?.resolved).toBe(true);
    expect(links[0]?.page?.id).toBe(target.id);

    const backlinks = await getKnowledgeTextBacklinks(target.id, ctx);
    expect(backlinks.some((b) => b.page.id === source.id)).toBe(true);
  });

  it("keeps phantom links and resolves them when the page appears", async () => {
    const futureTitle = uniqueTitle("Future Page");
    const source = await createKnowledgeText({
      title: uniqueTitle("Early Bird"),
      text: `This links to [[${futureTitle}]] which does not exist yet.`,
      tenantId: ctx.tenantId,
    });

    let links = await getKnowledgeTextLinks(source.id, ctx);
    expect(links[0]?.resolved).toBe(false);
    expect(links[0]?.page).toBeNull();
    expect(links[0]?.targetTitle).toBe(futureTitle);

    // now the target page gets created → the phantom link snaps into place
    const target = await createKnowledgeText({
      title: futureTitle,
      text: "now I exist",
      tenantId: ctx.tenantId,
    });

    links = await getKnowledgeTextLinks(source.id, ctx);
    expect(links[0]?.resolved).toBe(true);
    expect(links[0]?.page?.id).toBe(target.id);
  });

  it("resolves phantom links on rename", async () => {
    const wantedTitle = uniqueTitle("Renamed Target");
    const source = await createKnowledgeText({
      title: uniqueTitle("Waiting Source"),
      text: `Link to [[${wantedTitle}]].`,
      tenantId: ctx.tenantId,
    });
    const page = await createKnowledgeText({
      title: uniqueTitle("Old Name"),
      text: "content",
      tenantId: ctx.tenantId,
    });

    await updateKnowledgeText(page.id, { title: wantedTitle }, ctx);

    const links = await getKnowledgeTextLinks(source.id, ctx);
    expect(links[0]?.resolved).toBe(true);
    expect(links[0]?.page?.id).toBe(page.id);
  });

  it("turns links back into phantom links when the target is deleted", async () => {
    const targetTitle = uniqueTitle("Doomed Page");
    const target = await createKnowledgeText({
      title: targetTitle,
      text: "soon gone",
      tenantId: ctx.tenantId,
    });
    const source = await createKnowledgeText({
      title: uniqueTitle("Survivor"),
      text: `Points at [[${targetTitle}]].`,
      tenantId: ctx.tenantId,
    });

    await deleteKnowledgeText(target.id, ctx);

    const links = await getKnowledgeTextLinks(source.id, ctx);
    expect(links[0]?.resolved).toBe(false);
    expect(links[0]?.targetTitle).toBe(targetTitle);
  });

  it("updates links when content is edited via block sync", async () => {
    const firstTitle = uniqueTitle("First Target");
    const secondTitle = uniqueTitle("Second Target");
    await createKnowledgeText({
      title: firstTitle,
      text: "a",
      tenantId: ctx.tenantId,
    });
    const second = await createKnowledgeText({
      title: secondTitle,
      text: "b",
      tenantId: ctx.tenantId,
    });

    const page = await createKnowledgeText({
      title: uniqueTitle("Block Linker"),
      text: "",
      tenantId: ctx.tenantId,
    });
    await syncKnowledgeTextBlocks(
      page.id,
      [{ type: "markdown", content: `Linking [[${firstTitle}]]` }],
      ctx
    );
    let links = await getKnowledgeTextLinks(page.id, ctx);
    expect(links.map((l) => l.targetTitle)).toEqual([firstTitle]);

    // replace the content → old link disappears, new link appears
    await syncKnowledgeTextBlocks(
      page.id,
      [{ type: "markdown", content: `Linking [[${secondTitle}]] now` }],
      ctx
    );
    links = await getKnowledgeTextLinks(page.id, ctx);
    expect(links.map((l) => l.targetTitle)).toEqual([secondTitle]);
    expect(links[0]?.page?.id).toBe(second.id);
  });

  it("resolves titles case-insensitively", async () => {
    const title = uniqueTitle("CaseSensitive Page");
    const target = await createKnowledgeText({
      title,
      text: "x",
      tenantId: ctx.tenantId,
    });
    const source = await createKnowledgeText({
      title: uniqueTitle("Case Linker"),
      text: `See [[${title.toUpperCase()}]]`,
      tenantId: ctx.tenantId,
    });

    const links = await getKnowledgeTextLinks(source.id, ctx);
    expect(links[0]?.resolved).toBe(true);
    expect(links[0]?.page?.id).toBe(target.id);
  });

  it("returns empty related list for pages without embeddings", async () => {
    const page = await createKnowledgeText({
      title: uniqueTitle("No Embedding"),
      text: "content without embedding",
      tenantId: ctx.tenantId,
    });
    const related = await getRelatedKnowledgeTexts(page.id, ctx);
    expect(related).toEqual([]);
  });
});
