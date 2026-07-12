/**
 * Fractional indexing for ordered lists (wiki blocks, page trees).
 *
 * Keys are lowercase strings over the alphabet a–z. Lexicographic string
 * order = list order. `generateKeyBetween(a, b)` returns a key strictly
 * between its two arguments, so inserting or moving an item is always a
 * single-row update — no renumbering of siblings required.
 *
 * Invariants:
 *   - keys never end with "a" (the minimum character), otherwise no key
 *     could be generated before them
 *   - `null` bounds mean "start of list" / "end of list"
 *
 * The midpoint algorithm is the well-known "string between two strings"
 * approach (as used by Figma-style fractional indexing): find the first
 * differing character, then emit the character halfway between the two
 * bounds, descending a level when the bounds are adjacent.
 */

const MIN_CODE = "a".charCodeAt(0); // 97
const BELOW_MIN = MIN_CODE - 1; // virtual char before "a"
const MAX_CODE = "z".charCodeAt(0); // 122
const ABOVE_MAX = MAX_CODE + 1; // virtual char after "z"

const isValidKey = (key: string): boolean =>
  key.length > 0 && !key.endsWith("a") && /^[a-z]+$/.test(key);

/**
 * Generate a key strictly between `a` and `b`.
 * `a = null` means "before everything", `b = null` means "after everything".
 */
export const generateKeyBetween = (
  a: string | null,
  b: string | null
): string => {
  if (a !== null && !isValidKey(a)) {
    throw new Error(`Invalid fractional-index key: "${a}"`);
  }
  if (b !== null && !isValidKey(b)) {
    throw new Error(`Invalid fractional-index key: "${b}"`);
  }
  if (a !== null && b !== null && a >= b) {
    throw new Error(
      `generateKeyBetween: lower bound "${a}" must be < upper bound "${b}"`
    );
  }

  const prev = a ?? "";
  const next = b ?? "";

  let p = 0;
  let n = 0;
  let pos = 0;
  // find the first position where the bounds differ
  for (pos = 0; p === n; pos++) {
    p = pos < prev.length ? prev.charCodeAt(pos) : BELOW_MIN;
    n = pos < next.length ? next.charCodeAt(pos) : ABOVE_MAX;
  }

  let str = prev.slice(0, pos - 1); // shared prefix
  if (p === BELOW_MIN) {
    // prev is a prefix of next: descend along next's minimum characters
    while (n === MIN_CODE) {
      n = pos < next.length ? next.charCodeAt(pos++) : ABOVE_MAX;
      str += "a";
    }
    if (n === MIN_CODE + 1) {
      // next character is "b": can't go below "b" without ending in "a",
      // so descend one more level
      str += "a";
      n = ABOVE_MAX;
    }
  } else if (p + 1 === n) {
    // bounds are adjacent at this position: keep prev's char and find a
    // key above the rest of prev
    str += String.fromCharCode(p);
    n = ABOVE_MAX;
    while ((p = pos < prev.length ? prev.charCodeAt(pos++) : BELOW_MIN) === MAX_CODE) {
      str += "z";
    }
  }
  return str + String.fromCharCode(Math.ceil((p + n) / 2));
};

/**
 * Generate `count` keys strictly between `a` and `b`, evenly nested.
 */
export const generateNKeysBetween = (
  a: string | null,
  b: string | null,
  count: number
): string[] => {
  if (count <= 0) return [];
  if (count === 1) return [generateKeyBetween(a, b)];
  // generate the middle key, then recurse into both halves
  const midIndex = Math.floor(count / 2);
  const mid = generateKeyBetween(a, b);
  return [
    ...generateNKeysBetween(a, mid, midIndex),
    mid,
    ...generateNKeysBetween(mid, b, count - midIndex - 1),
  ];
};

/**
 * Assign positions to an ordered list of items, reusing existing keys where
 * the relative order still holds so an unchanged list produces zero writes.
 *
 * Input: items in their DESIRED order, each optionally carrying the key it
 * currently has in the database. Output: the final key per item (same order).
 *
 * An existing key is kept iff it is strictly greater than the previously
 * assigned key; otherwise a fresh key is generated between the previous key
 * and the nearest following reusable key (so kept keys are never jumped over).
 */
export const assignPositions = (
  items: { position?: string | null }[]
): string[] => {
  const result: string[] = [];
  let last: string | null = null;

  for (let i = 0; i < items.length; i++) {
    const existing = items[i]?.position ?? null;
    if (existing !== null && isValidKey(existing) && (last === null || existing > last)) {
      result.push(existing);
      last = existing;
      continue;
    }
    // upper bound: the smallest existing key after i that is still usable
    // (greater than `last`) — new keys must stay below every kept key
    let upper: string | null = null;
    for (let j = i + 1; j < items.length; j++) {
      const candidate = items[j]?.position ?? null;
      if (
        candidate !== null &&
        isValidKey(candidate) &&
        (last === null || candidate > last) &&
        (upper === null || candidate < upper)
      ) {
        upper = candidate;
      }
    }
    const key = generateKeyBetween(last, upper);
    result.push(key);
    last = key;
  }
  return result;
};
