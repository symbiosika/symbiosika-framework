import { describe, test, expect, beforeAll } from "bun:test";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";
import {
  createKnowledgeText,
  updateKnowledgeText,
  getKnowledgeText,
  getKnowledgeTextById,
} from "./knowledge-texts";
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
