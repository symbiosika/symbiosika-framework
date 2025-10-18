/**
 * Parse an unknown value to a number
 */
export const parseIntFromUnknown = (
  value: unknown,
  defaultValue?: number
): number | undefined => {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = parseInt(value);
    if (!isNaN(parsed)) {
      return parsed;
    }
  }
  return defaultValue ?? undefined;
};

/**
 * Parse an unknown value to a boolean
 */
export const parseBooleanFromUnknown = (
  value: unknown,
  defaultValue?: boolean
): boolean | undefined => {
  if (typeof value === "boolean") {
    return value;
  }
  return defaultValue ?? undefined;
};

/**
 * Parse an unknown value to a string
 */
export const parseStringFromUnknown = (
  value: unknown,
  defaultValue?: string
): string | undefined => {
  return typeof value === "string" && value.length > 0 ? value : defaultValue;
};
