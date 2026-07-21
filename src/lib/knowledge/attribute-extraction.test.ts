import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";
import { setKnowledgeTenantConfig } from "./knowledge-config";
import { resolveExtractionTargets } from "./parsing";
import { filterValidAttributes } from "./facets";
import { _GLOBAL_SERVER_CONFIG } from "../../store";

const TENANT = TEST_ORGANISATION_1.id;

describe("attribute extraction driven by tenant config", () => {
  beforeAll(async () => {
    await initTests();
    await setKnowledgeTenantConfig(TENANT, {
      attributes: [
        { key: "hersteller", label: "Hersteller" },
        { key: "typ", values: ["Datenblatt", "Handbuch"] },
      ],
    });
  });

  afterAll(() => {
    _GLOBAL_SERVER_CONFIG.enablePdfParserExtraction = false;
  });

  test("filterValidAttributes drops unknown keys and off-list enum values", async () => {
    const kept = await filterValidAttributes(TENANT, {
      hersteller: "Siemens", // known free-form key -> kept
      typ: "Flyer", // off the closed list -> dropped
      farbe: "blau", // unknown key -> dropped
    });
    expect(kept).toEqual({ hersteller: "Siemens" });
  });

  test("filterValidAttributes keeps an on-list enum value", async () => {
    const kept = await filterValidAttributes(TENANT, { typ: "Datenblatt" });
    expect(kept).toEqual({ typ: "Datenblatt" });
  });

  test("resolveExtractionTargets returns undefined while the flag is off", async () => {
    _GLOBAL_SERVER_CONFIG.enablePdfParserExtraction = false;
    expect(await resolveExtractionTargets(TENANT)).toBeUndefined();
  });

  test("explicitly provided targets always win over config/flag", async () => {
    _GLOBAL_SERVER_CONFIG.enablePdfParserExtraction = true;
    const provided = [{ key: "x", name: "X", description: "d" }];
    expect(await resolveExtractionTargets(TENANT, provided)).toBe(provided);
  });

  test("maps the tenant's configured attributes when the flag is on", async () => {
    _GLOBAL_SERVER_CONFIG.enablePdfParserExtraction = true;
    const targets = await resolveExtractionTargets(TENANT);
    expect(targets).toEqual([
      { key: "hersteller", name: "Hersteller", description: "Hersteller", type: "string" },
      {
        key: "typ",
        name: "typ",
        description: "typ",
        type: "enum",
        options: ["Datenblatt", "Handbuch"],
      },
    ]);
  });
});
