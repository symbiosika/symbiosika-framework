import { describe, test, expect } from "bun:test";
import {
  parseQueryOptions,
  parseFilterParams,
  parseExpandParam,
  parseFilterValue,
  RESERVED_QUERY_KEYS,
} from "./query-params";

describe("resource query-params parser", () => {
  test("parseFilterValue: in operator splits a parenthesised list", () => {
    expect(parseFilterValue("in", "(a,b,c)")).toEqual(["a", "b", "c"]);
    expect(parseFilterValue("in", "(a, b , c)")).toEqual(["a", "b", "c"]);
    expect(parseFilterValue("in", "a,b")).toEqual(["a", "b"]);
    expect(parseFilterValue("in", "()")).toEqual([]);
  });

  test("parseFilterValue: non-in operators keep the raw string", () => {
    expect(parseFilterValue("eq", "active")).toBe("active");
    expect(parseFilterValue("gte", "18")).toBe("18");
    expect(parseFilterValue("like", "john")).toBe("john");
  });

  test("parseFilterParams: PostgREST-style operator prefixes", () => {
    const filters = parseFilterParams({
      status: "eq.active",
      name: "like.john",
      min: "gte.18",
      max: "lte.65",
      id: "in.(1,2,3)",
    });

    expect(filters).toEqual([
      { field: "status", operator: "eq", value: "active" },
      { field: "name", operator: "like", value: "john" },
      { field: "min", operator: "gte", value: "18" },
      { field: "max", operator: "lte", value: "65" },
      { field: "id", operator: "in", value: ["1", "2", "3"] },
    ]);
  });

  test("parseFilterParams: missing prefix defaults to eq", () => {
    expect(parseFilterParams({ status: "active" })).toEqual([
      { field: "status", operator: "eq", value: "active" },
    ]);
  });

  test("parseFilterParams: unknown prefix is treated as a literal eq value", () => {
    // 'example' is not an operator -> the whole value is an eq match
    expect(parseFilterParams({ domain: "example.com" })).toEqual([
      { field: "domain", operator: "eq", value: "example.com" },
    ]);
  });

  test("parseFilterParams: reserved keys and empty values are skipped", () => {
    const filters = parseFilterParams({
      limit: "10",
      offset: "5",
      orderBy: "createdAt",
      orderDirection: "desc",
      expand: "tenant",
      empty: "",
      status: "eq.active",
    });
    expect(filters).toEqual([
      { field: "status", operator: "eq", value: "active" },
    ]);
    // sanity check on the reserved set itself
    for (const key of [
      "limit",
      "offset",
      "orderBy",
      "orderDirection",
      "expand",
    ]) {
      expect(RESERVED_QUERY_KEYS.has(key)).toBe(true);
    }
  });

  test("parseExpandParam: splits, trims and drops empties", () => {
    expect(parseExpandParam("tenant,knowledgeChunks")).toEqual([
      "tenant",
      "knowledgeChunks",
    ]);
    expect(parseExpandParam(" tenant , , user ")).toEqual(["tenant", "user"]);
    expect(parseExpandParam("")).toEqual([]);
    expect(parseExpandParam(undefined)).toEqual([]);
  });

  test("parseQueryOptions: combines pagination, sorting, expand and filters", () => {
    const options = parseQueryOptions({
      limit: "20",
      offset: "40",
      orderBy: "createdAt",
      orderDirection: "desc",
      expand: "tenant,user",
      status: "eq.active",
      score: "gte.5",
    });

    expect(options.limit).toBe(20);
    expect(options.offset).toBe(40);
    expect(options.orderBy).toBe("createdAt");
    expect(options.orderDirection).toBe("desc");
    expect(options.expand).toEqual(["tenant", "user"]);
    expect(options.filters).toEqual([
      { field: "status", operator: "eq", value: "active" },
      { field: "score", operator: "gte", value: "5" },
    ]);
  });

  test("parseQueryOptions: invalid pagination values are ignored", () => {
    const options = parseQueryOptions({
      limit: "0",
      offset: "-1",
      orderDirection: "sideways",
    });
    expect(options.limit).toBeUndefined();
    expect(options.offset).toBeUndefined();
    expect(options.orderDirection).toBeUndefined();
  });

  test("parseQueryOptions: omits empty filter and expand keys", () => {
    const options = parseQueryOptions({ limit: "5" });
    expect(options.filters).toBeUndefined();
    expect(options.expand).toBeUndefined();
    expect(options.limit).toBe(5);
  });
});
