import { describe, test, expect, beforeAll } from "bun:test";
import { parsePdfFileAsMardownLlama } from "./llama-api";
import fs from "fs";

import { TEST_ORGANISATION_1 } from "../../../../test/init.test";
import { TEST_PDF_TEXT } from "../../../../test/files.test";

describe("Local PDF Parser Service", () => {
  beforeAll(() => {
    // environment variables are set!
  });

  test("should successfully parse a PDF file", async () => {
    // Read the test PDF file
    const fileBuffer = await fs.promises.readFile(TEST_PDF_TEXT);
    const file = new File([fileBuffer], "t.pdf", {
      type: "application/pdf",
    });

    const result = await parsePdfFileAsMardownLlama(file, {
      organisationId: TEST_ORGANISATION_1.id,
    });

    // Basic validation of the result
    expect(result).toBeDefined();
    expect(result.pages).toBeDefined();
    expect(result.pages?.length).toBeGreaterThan(0);
  }, 30000);
});
