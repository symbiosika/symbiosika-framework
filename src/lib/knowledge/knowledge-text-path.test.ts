import { describe, test, expect, beforeAll } from "bun:test";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";
import { getDb } from "../db/db-connection";
import { knowledgeEntry, knowledgeChunks } from "../db/schema/knowledge";
import { createKnowledgeText, updateKnowledgeText } from "./knowledge-texts";
import {
  resolveKnowledgeTextPath,
  resolveKnowledgeTextPaths,
} from "./knowledge-text-path";
import { getPageChunkContext } from "./knowledge-text-chunks";
import { getNearestEmbeddings } from "./similarity-search";

const TENANT = TEST_ORGANISATION_1.id;
const ctx = { tenantId: TENANT };

describe("resolveKnowledgeTextPaths", () => {
  let rootId: string;
  let hrId: string;
  let vacationId: string;
  let standaloneId: string;

  beforeAll(async () => {
    await initTests();

    const root = await createKnowledgeText({
      tenantId: TENANT,
      title: "Handbook",
      text: "root",
    });
    rootId = root.id;

    const hr = await createKnowledgeText({
      tenantId: TENANT,
      title: "HR",
      text: "hr",
      parentId: rootId,
    });
    hrId = hr.id;

    const vacation = await createKnowledgeText({
      tenantId: TENANT,
      title: "Vacation Policy",
      text: "vacation",
      parentId: hrId,
    });
    vacationId = vacation.id;

    const standalone = await createKnowledgeText({
      tenantId: TENANT,
      title: "Standalone",
      text: "standalone",
    });
    standaloneId = standalone.id;
  });

  test("builds the full slash path root-first, including the page itself", async () => {
    const path = await resolveKnowledgeTextPath(vacationId, TENANT);
    expect(path).not.toBeNull();
    expect(path!.path).toBe("Handbook/HR/Vacation Policy");
    expect(path!.pathIds).toEqual([rootId, hrId, vacationId]);
    expect(path!.pathSegments.map((s) => s.title)).toEqual([
      "Handbook",
      "HR",
      "Vacation Policy",
    ]);
  });

  test("a top-level page's path is just its own title", async () => {
    const path = await resolveKnowledgeTextPath(rootId, TENANT);
    expect(path!.path).toBe("Handbook");
    expect(path!.pathIds).toEqual([rootId]);
  });

  test("includeSelf:false yields only the ancestor folders", async () => {
    const path = await resolveKnowledgeTextPath(vacationId, TENANT, {
      includeSelf: false,
    });
    expect(path!.path).toBe("Handbook/HR");
    expect(path!.pathIds).toEqual([rootId, hrId]);
  });

  test("a top-level page has an empty ancestor path", async () => {
    const path = await resolveKnowledgeTextPath(standaloneId, TENANT, {
      includeSelf: false,
    });
    expect(path!.path).toBe("");
    expect(path!.pathIds).toEqual([]);
  });

  test("custom separator is honoured", async () => {
    const path = await resolveKnowledgeTextPath(vacationId, TENANT, {
      separator: " > ",
    });
    expect(path!.path).toBe("Handbook > HR > Vacation Policy");
  });

  test("resolves many pages in one call, keyed by id", async () => {
    const map = await resolveKnowledgeTextPaths(
      [vacationId, hrId, standaloneId],
      TENANT
    );
    expect(map.get(vacationId)!.path).toBe("Handbook/HR/Vacation Policy");
    expect(map.get(hrId)!.path).toBe("Handbook/HR");
    expect(map.get(standaloneId)!.path).toBe("Standalone");
  });

  test("unknown / cross-tenant ids are omitted from the result", async () => {
    const map = await resolveKnowledgeTextPaths(
      ["00000000-9999-9999-9999-000000000000", vacationId],
      TENANT
    );
    expect(map.has("00000000-9999-9999-9999-000000000000")).toBe(false);
    expect(map.has(vacationId)).toBe(true);
  });
});

describe("getPageChunkContext surfaces the wiki path", () => {
  let childId: string;

  beforeAll(async () => {
    await initTests();

    const parent = await createKnowledgeText({
      tenantId: TENANT,
      title: "Docs",
      text: "parent",
    });

    const child = await createKnowledgeText({
      tenantId: TENANT,
      title: "Nested Page",
      text: "child",
      parentId: parent.id,
    });
    childId = child.id;

    const [entry] = await getDb()
      .insert(knowledgeEntry)
      .values({ tenantId: TENANT, name: "Nested Page entry" })
      .returning();

    const vec = new Array(1024).fill(0);
    await getDb()
      .insert(knowledgeChunks)
      .values(
        [0, 1].map((order) => ({
          knowledgeEntryId: entry!.id,
          text: `chunk-${order}`,
          order,
          embeddingModel: "test",
          dimensions: 1024,
          textEmbedding1024: vec,
        }))
      );

    // link the page to the mirrored RAG entry
    await updateKnowledgeText(childId, { knowledgeEntryId: entry!.id }, ctx);
  });

  test("returns the breadcrumb path of the page", async () => {
    const result = await getPageChunkContext(childId, ctx, { order: 0 });
    expect(result.path).toBe("Docs/Nested Page");
    expect(result.pathIds.length).toBe(2);
    expect(result.chunks.length).toBeGreaterThan(0);
  });
});

describe("getNearestEmbeddings surfaces the source wiki path", () => {
  let entryId: string;
  let plainEntryId: string;

  beforeAll(async () => {
    await initTests();

    // a wiki page mirrored into the RAG layer -> chunks carry its path
    const parent = await createKnowledgeText({
      tenantId: TENANT,
      title: "Knowledge",
      text: "parent",
    });
    const page = await createKnowledgeText({
      tenantId: TENANT,
      title: "Bees",
      text: "page",
      parentId: parent.id,
    });

    const [entry] = await getDb()
      .insert(knowledgeEntry)
      .values({ tenantId: TENANT, name: `Wiki mirror ${crypto.randomUUID()}` })
      .returning();
    entryId = entry!.id;
    await getDb()
      .insert(knowledgeChunks)
      .values({
        knowledgeEntryId: entryId,
        text: "Worker bees visit millions of flowers to make honey.",
        order: 0,
        embeddingModel: "test",
        dimensions: 1024,
        textEmbedding1024: new Array(1024).fill(0),
      });
    await updateKnowledgeText(page.id, { knowledgeEntryId: entryId }, ctx);

    // a plain RAG entry with no linked wiki page -> path is null
    const [plain] = await getDb()
      .insert(knowledgeEntry)
      .values({ tenantId: TENANT, name: `Plain RAG ${crypto.randomUUID()}` })
      .returning();
    plainEntryId = plain!.id;
    await getDb()
      .insert(knowledgeChunks)
      .values({
        knowledgeEntryId: plainEntryId,
        text: "Standalone honey document not part of the wiki tree.",
        order: 0,
        embeddingModel: "test",
        dimensions: 1024,
        textEmbedding1024: new Array(1024).fill(0),
      });
  });

  test("chunk from a wiki page carries the page's breadcrumb path", async () => {
    const previousProvider = process.env.EMBEDDING_PROVIDER;
    process.env.EMBEDDING_PROVIDER = "__not-configured__";
    try {
      const results = await getNearestEmbeddings({
        tenantId: TENANT,
        searchText: "honey flowers bees",
        n: 3,
        filterKnowledgeEntryIds: [entryId],
      });
      expect(results.length).toBe(1);
      expect(results[0]!.path).toBe("Knowledge/Bees");
      expect(results[0]!.knowledgeTextId).not.toBeNull();
      expect(results[0]!.pathIds.length).toBe(2);
    } finally {
      if (previousProvider === undefined)
        delete process.env.EMBEDDING_PROVIDER;
      else process.env.EMBEDDING_PROVIDER = previousProvider;
    }
  });

  test("chunk from a plain RAG entry has a null path", async () => {
    const previousProvider = process.env.EMBEDDING_PROVIDER;
    process.env.EMBEDDING_PROVIDER = "__not-configured__";
    try {
      const results = await getNearestEmbeddings({
        tenantId: TENANT,
        searchText: "standalone honey document",
        n: 3,
        filterKnowledgeEntryIds: [plainEntryId],
      });
      expect(results.length).toBe(1);
      expect(results[0]!.path).toBeNull();
      expect(results[0]!.knowledgeTextId).toBeNull();
      expect(results[0]!.pathIds).toEqual([]);
    } finally {
      if (previousProvider === undefined)
        delete process.env.EMBEDDING_PROVIDER;
      else process.env.EMBEDDING_PROVIDER = previousProvider;
    }
  });
});
