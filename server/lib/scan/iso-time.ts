/**
 * Serialize a timestamp for an exported or persisted scan record. Drizzle
 * hands back `Date` for timestamp columns and a string for raw rows; sqlite
 * integer timestamps arrive as numbers. An unparseable date is `null` rather
 * than a `RangeError` from `toISOString`.
 */
export function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number") return toIsoOrNull(new Date(value));
  if (typeof value === "string") return value;
  return null;
}
