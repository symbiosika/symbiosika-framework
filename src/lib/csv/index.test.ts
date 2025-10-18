import { describe, it, expect } from "bun:test";
import { CsvService } from ".";

describe("CsvService", () => {
  const csvService = new CsvService();

  describe("objectsToCsv", () => {
    it("should convert array of objects to CSV with default options", async () => {
      const data = [
        { name: "John", age: 30 },
        { name: "Jane", age: 25 },
      ];

      const csv = await csvService.objectsToCsv(data, { useQuotes: false });
      const expectedCsv = "name,age\nJohn,30\nJane,25\n";

      expect(csv).toBe(expectedCsv);
    });

    it("should respect custom separator", async () => {
      const data = [
        { name: "John", age: 30 },
        { name: "Jane", age: 25 },
      ];

      const csv = await csvService.objectsToCsv(data, {
        separator: ";",
        useQuotes: false,
      });
      const expectedCsv = "name;age\nJohn;30\nJane;25\n";

      expect(csv).toBe(expectedCsv);
    });

    it("should handle empty data array", async () => {
      const data: Record<string, any>[] = [];
      const csv = await csvService.objectsToCsv(data, { useQuotes: false });
      expect(csv).toBe("\n");
    });

    it("should respect custom columns option", async () => {
      const data = [
        { name: "John", age: 30, city: "New York" },
        { name: "Jane", age: 25, city: "London" },
      ];

      const csv = await csvService.objectsToCsv(data, {
        columns: ["name", "city"],
        useQuotes: false,
      });
      const expectedCsv = "name,city\nJohn,New York\nJane,London\n";

      expect(csv).toBe(expectedCsv);
    });

    it("should handle disabled headers", async () => {
      const data = [
        { name: "John", age: 30 },
        { name: "Jane", age: 25 },
      ];

      const csv = await csvService.objectsToCsv(data, {
        header: false,
        useQuotes: true,
      });
      const expectedCsv = '"John","30"\n"Jane","25"\n';

      expect(csv).toBe(expectedCsv);
    });
  });
});
