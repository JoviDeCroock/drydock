export function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

export function formatDateTime(value: string | number | Date): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Full local stamp with year and seconds, for surfaces that compare rows
 * against each other: a timeline whose rows are seconds apart, or one that
 * may span a year boundary, is ambiguous at `formatDateTime` resolution.
 */
export function formatDateTimeExact(value: string | number | Date): string {
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatTimestamp(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
