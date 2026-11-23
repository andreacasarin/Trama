/** Check the container while keeping unchecked elements typed as unknown. */
export function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}
