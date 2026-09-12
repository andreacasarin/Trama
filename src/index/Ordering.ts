/** Locale-independent UTF-16 code-unit ordering for persisted index data. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
