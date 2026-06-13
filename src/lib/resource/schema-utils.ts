/**
 * Schema utilities for the resource system
 * Provides helpers to manipulate Valibot schemas for AI tools and API docs
 */

import * as v from "valibot";

// Re-export the type for convenience
export type { FieldDescriptions } from "./types";

/**
 * Merge field descriptions into a Valibot object schema.
 * Each matching field gets wrapped with v.pipe(..., v.description()).
 *
 * @example
 * ```typescript
 * const described = withDescriptions(insertSchema, {
 *   url: 'Website URL of the competitor',
 *   riskRating: 'Risk rating from 0 to 10',
 * });
 * ```
 */
export function withDescriptions(
  schema: any,
  descriptions: Record<string, string>
): any {
  const entries = schema.entries;
  if (!entries) return schema;

  const newEntries: Record<string, any> = {};
  for (const [key, fieldSchema] of Object.entries(entries)) {
    if (descriptions[key]) {
      newEntries[key] = v.pipe(
        fieldSchema as any,
        v.description(descriptions[key])
      );
    } else {
      newEntries[key] = fieldSchema;
    }
  }
  return v.object(newEntries);
}

/**
 * Strip internal/auto-managed fields from a Valibot object schema.
 * Used to create clean input schemas for AI tools and API validation.
 * Default stripped fields: id, tenantId, createdAt, updatedAt
 */
export function stripInternalFields(
  schema: any,
  fieldsToStrip: string[] = ["id", "tenantId", "createdAt", "updatedAt"]
): any {
  const entries = schema.entries;
  if (!entries) return schema;

  const newEntries: Record<string, any> = {};
  for (const [key, fieldSchema] of Object.entries(entries)) {
    if (!fieldsToStrip.includes(key)) {
      newEntries[key] = fieldSchema;
    }
  }
  return v.object(newEntries);
}

/**
 * Make all fields in a Valibot object schema optional.
 * Used for update input schemas where all fields are partial.
 */
export function makeAllOptional(schema: any): any {
  const entries = schema.entries;
  if (!entries) return schema;

  const newEntries: Record<string, any> = {};
  for (const [key, fieldSchema] of Object.entries(entries)) {
    newEntries[key] = v.optional(fieldSchema as any);
  }
  return v.object(newEntries);
}
