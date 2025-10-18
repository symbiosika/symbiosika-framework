/**
 * Try to parse a number from undefined or string
 * Returns a default value or undefined if the value is not a number
 */
export function parseNumberFromUrlParam(
  value: string | undefined
): number | undefined;
export function parseNumberFromUrlParam(
  value: string | undefined,
  defaultValue: number
): number;
export function parseNumberFromUrlParam(
  value: string | undefined,
  defaultValue?: number
): number | undefined {
  return value ? parseInt(value) : defaultValue;
}

/**
 * Try to parse a comma separated list of strings from undefined or string
 * Returns a default value or undefined if the value is not a comma separated list of strings
 */

export function parseCommaSeparatedListFromUrlParam(
  value: string | undefined
): string[] | undefined;
export function parseCommaSeparatedListFromUrlParam(
  value: string | undefined,
  defaultValue: string[]
): string[];
export function parseCommaSeparatedListFromUrlParam(
  value: string | undefined,
  defaultValue?: string[]
): string[] | undefined {
  return value ? value.split(",") : defaultValue;
}
