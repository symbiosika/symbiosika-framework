import { describe, test, expect } from "bun:test";

// DB env defaults so importing modules that build a Postgres client at load
// time does not crash. postgres.js is lazy — these pure tests never query.
process.env.POSTGRES_HOST ??= "localhost";
process.env.POSTGRES_PORT ??= "5432";
process.env.POSTGRES_USER ??= "postgres";
process.env.POSTGRES_PASSWORD ??= "postgres";
process.env.POSTGRES_DB ??= "symbiosika";

const { attributeDefinitionsToExtractionTargets } = await import(
  "./knowledge-config"
);
const { extractedMetadataToAttributes } = await import("./parsing");

describe("attributeDefinitionsToExtractionTargets", () => {
  test("maps label/description/type and enum options", () => {
    const targets = attributeDefinitionsToExtractionTargets([
      {
        key: "hersteller",
        label: "Hersteller",
        description: "Name des Herstellers auf dem Datenblatt",
      },
      { key: "typ", values: ["Datenblatt", "Handbuch"] },
      { key: "bareword" },
    ]);

    expect(targets).toEqual([
      {
        key: "hersteller",
        name: "Hersteller",
        description: "Name des Herstellers auf dem Datenblatt",
        type: "string",
      },
      {
        key: "typ",
        name: "typ",
        description: "typ",
        type: "enum",
        options: ["Datenblatt", "Handbuch"],
      },
      { key: "bareword", name: "bareword", description: "bareword", type: "string" },
    ]);
  });

  test("an explicit type wins over the values-derived enum default", () => {
    const [target] = attributeDefinitionsToExtractionTargets([
      { key: "count", type: "number", values: ["ignored"] },
    ]);
    expect(target.type).toBe("number");
    expect(target.options).toBeUndefined();
  });
});

describe("extractedMetadataToAttributes", () => {
  test("keeps only found, non-empty values and stringifies scalars", () => {
    const attrs = extractedMetadataToAttributes({
      hersteller: { value: "Siemens", found: true, confidence: 0.9 },
      typ: { value: null, found: false },
      leer: { value: "", found: true },
      count: { value: 42, found: true },
      flag: { value: false, found: true },
      missing: { value: "x", found: false },
    });
    expect(attrs).toEqual({
      hersteller: "Siemens",
      count: "42",
      flag: "false",
    });
  });

  test("undefined metadata yields an empty map", () => {
    expect(extractedMetadataToAttributes(undefined)).toEqual({});
  });
});
