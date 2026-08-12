import { describe, it, expect } from "bun:test";
import {
  generateKeyBetween,
  generateNKeysBetween,
  assignPositions,
  MAX_KEY_LENGTH_BEFORE_REBALANCE,
} from "./fractional-index";

describe("generateKeyBetween", () => {
  it("generates a key for an empty list", () => {
    const key = generateKeyBetween(null, null);
    expect(key.length).toBeGreaterThan(0);
    expect(key.endsWith("a")).toBe(false);
  });

  it("generates keys before and after an existing key", () => {
    const mid = generateKeyBetween(null, null);
    const before = generateKeyBetween(null, mid);
    const after = generateKeyBetween(mid, null);
    expect(before < mid).toBe(true);
    expect(mid < after).toBe(true);
  });

  it("generates a key between two adjacent-looking keys", () => {
    const key = generateKeyBetween("n", "o");
    expect(key > "n").toBe(true);
    expect(key < "o").toBe(true);
  });

  it("handles prefix bounds (a is prefix of b)", () => {
    const key = generateKeyBetween("n", "nb");
    expect(key > "n").toBe(true);
    expect(key < "nb").toBe(true);
  });

  it("never produces keys ending with the minimum character", () => {
    // stress: repeatedly insert at the very beginning
    let upper: string | null = null;
    for (let i = 0; i < 200; i++) {
      const key: string = generateKeyBetween(null, upper);
      expect(key.endsWith("a")).toBe(false);
      if (upper !== null) expect(key < upper).toBe(true);
      upper = key;
    }
  });

  it("supports many sequential appends at the end", () => {
    let last: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 200; i++) {
      const key: string = generateKeyBetween(last, null);
      if (last !== null) expect(key > last).toBe(true);
      keys.push(key);
      last = key;
    }
    // keys must be strictly ascending
    const sorted = [...keys].sort();
    expect(sorted).toEqual(keys);
  });

  it("supports many repeated midpoint insertions", () => {
    let a: string | null = "b";
    let b: string | null = "c";
    for (let i = 0; i < 100; i++) {
      const key: string = generateKeyBetween(a, b);
      expect(key > (a as string)).toBe(true);
      expect(key < (b as string)).toBe(true);
      // narrow the interval alternately from both sides
      if (i % 2 === 0) a = key;
      else b = key;
    }
  });

  it("rejects invalid bounds", () => {
    expect(() => generateKeyBetween("b", "b")).toThrow();
    expect(() => generateKeyBetween("c", "b")).toThrow();
    expect(() => generateKeyBetween("", null)).toThrow();
    expect(() => generateKeyBetween("na", null)).toThrow(); // ends with "a"
    expect(() => generateKeyBetween("A1", null)).toThrow(); // outside alphabet
  });
});

describe("generateNKeysBetween", () => {
  it("generates n strictly ascending keys", () => {
    const keys = generateNKeysBetween(null, null, 10);
    expect(keys.length).toBe(10);
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i - 1]! < keys[i]!).toBe(true);
    }
  });

  it("respects the given bounds", () => {
    const keys = generateNKeysBetween("b", "c", 5);
    for (const key of keys) {
      expect(key > "b").toBe(true);
      expect(key < "c").toBe(true);
    }
  });

  it("returns an empty array for count <= 0", () => {
    expect(generateNKeysBetween(null, null, 0)).toEqual([]);
  });
});

describe("assignPositions", () => {
  it("assigns fresh keys to a new list", () => {
    const keys = assignPositions([{}, {}, {}]);
    expect(keys.length).toBe(3);
    expect(keys[0]! < keys[1]!).toBe(true);
    expect(keys[1]! < keys[2]!).toBe(true);
  });

  it("keeps all existing keys when order is unchanged", () => {
    const existing = ["f", "n", "u"];
    const keys = assignPositions(existing.map((position) => ({ position })));
    expect(keys).toEqual(existing);
  });

  it("only reassigns moved items", () => {
    // original order: A(f), B(n), C(u) — move C before B => A, C, B
    const keys = assignPositions([
      { position: "f" },
      { position: "u" },
      { position: "n" },
    ]);
    expect(keys[0]).toBe("f"); // untouched
    expect(keys[1]).toBe("u"); // kept (still > f)
    expect(keys[2]).not.toBe("n"); // reassigned
    expect(keys[1]! < keys[2]!).toBe(true);
  });

  it("inserts a new item between existing ones without touching them", () => {
    const keys = assignPositions([
      { position: "f" },
      {}, // new block inserted in the middle
      { position: "n" },
    ]);
    expect(keys[0]).toBe("f");
    expect(keys[2]).toBe("n");
    expect(keys[1]! > "f").toBe(true);
    expect(keys[1]! < "n").toBe(true);
  });

  it("produces strictly ascending keys for arbitrary shuffles", () => {
    const keys = assignPositions([
      { position: "u" },
      { position: "n" },
      {},
      { position: "f" },
      { position: null },
    ]);
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i - 1]! < keys[i]!).toBe(true);
    }
  });

  it("handles an empty list", () => {
    expect(assignPositions([])).toEqual([]);
  });

  /**
   * Appending grows the keys by ~1 character per 4 items. Left alone that ends
   * in a write failure once the column's limit is reached (a 257-block page
   * produced a 65-character key and could no longer be saved), so the list is
   * re-keyed compactly once the keys get long.
   */
  it("rebalances a list whose keys have grown long", () => {
    const long = ["z".repeat(40) + "b", "z".repeat(40) + "c"];
    const keys = assignPositions(long.map((position) => ({ position })));

    expect(keys.length).toBe(2);
    expect(keys).not.toEqual(long); // every row is rewritten
    for (const key of keys) {
      expect(key.length).toBeLessThanOrEqual(MAX_KEY_LENGTH_BEFORE_REBALANCE);
      expect(/^[a-z]+$/.test(key)).toBe(true);
    }
    expect(keys[0]! < keys[1]!).toBe(true);
  });

  it("keeps appended keys bounded over many rounds", () => {
    // 600 appends: without the rebalance the last key would be ~150 chars
    let keys: string[] = [];
    for (let i = 0; i < 600; i++) {
      keys = assignPositions([
        ...keys.map((position) => ({ position })),
        {} as { position?: string | null },
      ]);
    }
    expect(keys.length).toBe(600);
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(
      MAX_KEY_LENGTH_BEFORE_REBALANCE
    );
    expect(new Set(keys).size).toBe(600);
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i - 1]! < keys[i]!).toBe(true);
    }
  });

  it("does not rebalance a list with short keys", () => {
    const existing = ["f", "n", "u"];
    expect(assignPositions(existing.map((position) => ({ position })))).toEqual(
      existing
    );
  });
});
