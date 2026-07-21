import { describe, test, expect, beforeAll } from "bun:test";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";
import {
  createKnowledgeText,
  updateKnowledgeText,
  getKnowledgeText,
  getKnowledgeTextById,
  getUsedAttributeValues,
} from "./knowledge-texts";
import { searchKnowledgeTexts } from "./knowledge-text-search";
import { FacetValidationError } from "./facets";
import { setKnowledgeTenantConfig, getKnowledgeTenantConfig } from "./knowledge-config";

const TENANT = TEST_ORGANISATION_1.id;

describe("controlled facets", () => {
  beforeAll(async () => {
    await initTests();
  });

  test("accepts a page type / status from the default vocabulary", async () => {
    const page = await createKnowledgeText({
      tenantId: TENANT,
      title: "Facet ok",
      text: "content",
      pageType: "manual",
      status: "draft",
    });
    const fetched = await getKnowledgeTextById(page.id, { tenantId: TENANT });
    expect(fetched.pageType).toBe("manual");
    expect(fetched.status).toBe("draft");
  });

  test("rejects a page type outside the controlled vocabulary", async () => {
    await expect(
      createKnowledgeText({
        tenantId: TENANT,
        title: "Facet bad",
        text: "content",
        pageType: "not-a-real-type",
      })
    ).rejects.toBeInstanceOf(FacetValidationError);
  });

  test("rejects an invalid status on update", async () => {
    const page = await createKnowledgeText({
      tenantId: TENANT,
      title: "Facet update",
      text: "content",
    });
    await expect(
      updateKnowledgeText(page.id, { status: "bogus" }, { tenantId: TENANT })
    ).rejects.toBeInstanceOf(FacetValidationError);
  });

  test("clearing a facet (null) is always allowed", async () => {
    const page = await createKnowledgeText({
      tenantId: TENANT,
      title: "Facet clear",
      text: "content",
      pageType: "policy",
    });
    const updated = await updateKnowledgeText(
      page.id,
      { pageType: null },
      { tenantId: TENANT }
    );
    expect(updated.pageType).toBeNull();
  });

  test("list is filterable by facet", async () => {
    await createKnowledgeText({
      tenantId: TENANT,
      title: "FAQ page",
      text: "c",
      pageType: "FAQ",
    });
    const faqs = await getKnowledgeText({
      tenantId: TENANT,
      pageType: "FAQ",
    });
    expect(faqs.length).toBeGreaterThanOrEqual(1);
    expect(faqs.every((p) => p.pageType === "FAQ")).toBe(true);
  });

  test("list carries the facet fields (delivered everywhere)", async () => {
    const list = await getKnowledgeText({ tenantId: TENANT });
    const sample = list[0] as Record<string, unknown>;
    expect(sample).toHaveProperty("pageType");
    expect(sample).toHaveProperty("status");
    expect(sample).toHaveProperty("summary");
  });

  test("tenant vocabulary is configurable and then enforced", async () => {
    await setKnowledgeTenantConfig(TENANT, { pageTypes: ["sondertyp"] });
    const cfg = await getKnowledgeTenantConfig(TENANT);
    expect(cfg.pageTypes).toEqual(["sondertyp"]);

    // now the new value is accepted...
    const ok = await createKnowledgeText({
      tenantId: TENANT,
      title: "Custom vocab page",
      text: "c",
      pageType: "sondertyp",
    });
    expect(ok.pageType).toBe("sondertyp");

    // ...and a previously-valid default value is now rejected
    await expect(
      createKnowledgeText({
        tenantId: TENANT,
        title: "Old vocab page",
        text: "c",
        pageType: "manual",
      })
    ).rejects.toBeInstanceOf(FacetValidationError);

    // restore defaults for other tests
    await setKnowledgeTenantConfig(TENANT, {
      pageTypes: ["manual", "FAQ", "policy", "note", "text"],
    });
  });
});
describe("catalog attributes", () => {
  beforeAll(async () => {
    await initTests();
    // add attribute definitions on top of the existing config (pageTypes/
    // statuses untouched, so the facet tests above are unaffected)
    await setKnowledgeTenantConfig(TENANT, {
      attributes: [
        { key: "typ", label: "Typ", values: ["Datenblatt", "Handbuch"] },
        { key: "hersteller", label: "Hersteller" },
      ],
    });
  });

  test("accepts defined keys (closed list and free-form) and stores them", async () => {
    const page = await createKnowledgeText({
      tenantId: TENANT,
      title: `Attr ok ${crypto.randomUUID()}`,
      text: "content",
      attributes: { typ: "Datenblatt", hersteller: "Miele" },
    });
    const fetched = await getKnowledgeTextById(page.id, { tenantId: TENANT });
    expect(fetched.attributes).toEqual({
      typ: "Datenblatt",
      hersteller: "Miele",
    });
  });

  test("rejects an unknown attribute key", async () => {
    await expect(
      createKnowledgeText({
        tenantId: TENANT,
        title: `Attr bad key ${crypto.randomUUID()}`,
        text: "content",
        attributes: { farbe: "rot" },
      })
    ).rejects.toBeInstanceOf(FacetValidationError);
  });

  test("rejects a value outside a closed value list", async () => {
    await expect(
      createKnowledgeText({
        tenantId: TENANT,
        title: `Attr bad value ${crypto.randomUUID()}`,
        text: "content",
        attributes: { typ: "Prospekt" },
      })
    ).rejects.toBeInstanceOf(FacetValidationError);
  });

  test("rejects invalid attributes on update", async () => {
    const page = await createKnowledgeText({
      tenantId: TENANT,
      title: `Attr update ${crypto.randomUUID()}`,
      text: "content",
    });
    await expect(
      updateKnowledgeText(
        page.id,
        { attributes: { unbekannt: "x" } },
        { tenantId: TENANT }
      )
    ).rejects.toBeInstanceOf(FacetValidationError);
  });

  test("list filter matches only pages carrying all given attributes", async () => {
    const marker = crypto.randomUUID();
    const hit = await createKnowledgeText({
      tenantId: TENANT,
      title: `Attr filter hit ${marker}`,
      text: "content",
      attributes: { typ: "Datenblatt", hersteller: marker },
    });
    await createKnowledgeText({
      tenantId: TENANT,
      title: `Attr filter miss ${marker}`,
      text: "content",
      attributes: { typ: "Handbuch", hersteller: marker },
    });

    const both = await getKnowledgeText({
      tenantId: TENANT,
      attributes: { hersteller: marker },
    });
    expect(both.length).toBe(2);

    const filtered = await getKnowledgeText({
      tenantId: TENANT,
      attributes: { hersteller: marker, typ: "Datenblatt" },
    });
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.id).toBe(hit.id);
  });

  test("search (fulltext leg) respects the attribute filter", async () => {
    const marker = crypto.randomUUID().replaceAll("-", "");
    await createKnowledgeText({
      tenantId: TENANT,
      title: `Search attr A ${marker}`,
      text: `The unique word attrsearch${marker} appears here.`,
      attributes: { typ: "Datenblatt", hersteller: "Miele" },
    });
    await createKnowledgeText({
      tenantId: TENANT,
      title: `Search attr B ${marker}`,
      text: `The unique word attrsearch${marker} appears here too.`,
      attributes: { typ: "Handbuch", hersteller: "Miele" },
    });

    const results = await searchKnowledgeTexts(
      `attrsearch${marker}`,
      { tenantId: TENANT },
      { mode: "fulltext", filters: { attributes: { typ: "Datenblatt" } } }
    );
    expect(results.length).toBe(1);
    expect(results[0]!.title).toContain("Search attr A");
  });

  test("getUsedAttributeValues lists values per key", async () => {
    const used = await getUsedAttributeValues({ tenantId: TENANT });
    expect(used["typ"]).toContain("Datenblatt");
    expect(used["typ"]).toContain("Handbuch");
    expect(used["hersteller"]).toContain("Miele");
  });
});
