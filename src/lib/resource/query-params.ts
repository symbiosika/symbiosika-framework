/**
 * URL query parsing for the resource system.
 *
 * This module is intentionally free of runtime dependencies (only type-only
 * imports) so it can be unit-tested without a database or HTTP framework.
 *
 * It turns a flat query-string record (as returned by Hono's `c.req.query()`)
 * into a normalized {@link QueryOptions} object understood by the CRUD layer.
 *
 * ## Filtering syntax (PostgREST-style)
 *
 * Any query parameter that is not a reserved key is treated as a filter on the
 * column with that name. The value uses an `operator.value` form:
 *
 * ```text
 * ?status=eq.active          status = 'active'
 * ?name=like.john            name ILIKE '%john%'
 * ?age=gte.18                age >= 18
 * ?age=lte.65                age <= 65
 * ?id=in.(a,b,c)             id IN ('a','b','c')
 * ?status=active             status = 'active'   (no prefix -> defaults to eq)
 * ```
 *
 * If the prefix before the first `.` is not a known operator the whole value is
 * treated as an `eq` value (so `?domain=example.com` filters for the literal
 * `example.com`).
 *
 * ## Reserved keys
 *
 * `limit`, `offset`, `orderBy`, `orderDirection`, `expand` are never treated as
 * filters. They control pagination, sorting and relation expansion instead.
 */

import type { QueryOptions, QueryFilter, FilterOperator } from "./types";

/**
 * Query parameters that control the query itself and are never treated as
 * column filters.
 */
export const RESERVED_QUERY_KEYS = new Set<string>([
  "limit",
  "offset",
  "orderBy",
  "orderDirection",
  "expand",
]);

const KNOWN_OPERATORS: readonly FilterOperator[] = [
  "eq",
  "like",
  "gte",
  "lte",
  "in",
];

function isOperator(value: string): value is FilterOperator {
  return (KNOWN_OPERATORS as readonly string[]).includes(value);
}

/**
 * Parse the value part of a filter into the shape expected by the CRUD layer.
 * For the `in` operator a parenthesised, comma-separated list is split into an
 * array; all other operators keep the raw string value.
 */
export function parseFilterValue(
  operator: FilterOperator,
  raw: string
): unknown {
  if (operator === "in") {
    const inner = raw.replace(/^\(/, "").replace(/\)$/, "").trim();
    if (inner.length === 0) return [];
    return inner.split(",").map((part) => part.trim());
  }
  return raw;
}

/**
 * Extract column filters from a raw query record. Reserved keys and empty
 * values are skipped. Field-name validation against the actual table columns
 * happens later in the CRUD layer, so unknown columns are harmless here.
 */
export function parseFilterParams(
  query: Record<string, string | undefined>
): QueryFilter[] {
  const filters: QueryFilter[] = [];

  for (const [field, rawValue] of Object.entries(query)) {
    if (RESERVED_QUERY_KEYS.has(field)) continue;
    if (rawValue === undefined || rawValue === "") continue;

    let operator: FilterOperator = "eq";
    let valuePart = rawValue;

    const dotIndex = rawValue.indexOf(".");
    if (dotIndex > 0) {
      const maybeOperator = rawValue.slice(0, dotIndex);
      if (isOperator(maybeOperator)) {
        operator = maybeOperator;
        valuePart = rawValue.slice(dotIndex + 1);
      }
    }

    filters.push({
      field,
      operator,
      value: parseFilterValue(operator, valuePart),
    });
  }

  return filters;
}

/**
 * Parse the `expand` parameter into a list of relation names.
 * Accepts a comma-separated list, e.g. `?expand=tenant,knowledgeChunks`.
 */
export function parseExpandParam(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Parse a raw query record into {@link QueryOptions} for `getAll`:
 * pagination, sorting, relation expansion and column filters.
 */
export function parseQueryOptions(
  query: Record<string, string | undefined>
): QueryOptions {
  const options: QueryOptions = {};

  if (query.limit) {
    const parsed = parseInt(query.limit, 10);
    if (!isNaN(parsed) && parsed > 0) {
      options.limit = parsed;
    }
  }
  if (query.offset) {
    const parsed = parseInt(query.offset, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      options.offset = parsed;
    }
  }
  if (query.orderBy) {
    options.orderBy = query.orderBy;
  }
  if (query.orderDirection === "asc" || query.orderDirection === "desc") {
    options.orderDirection = query.orderDirection;
  }

  const expand = parseExpandParam(query.expand);
  if (expand.length > 0) {
    options.expand = expand;
  }

  const filters = parseFilterParams(query);
  if (filters.length > 0) {
    options.filters = filters;
  }

  return options;
}
