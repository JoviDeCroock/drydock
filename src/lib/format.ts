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

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Compact mono duration: `<1m`, `42m`, `3h`, `5d`. */
export function formatCompactDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < MINUTE_MS) return "<1m";
  if (clamped < HOUR_MS) return `${Math.floor(clamped / MINUTE_MS)}m`;
  if (clamped < 2 * DAY_MS) return `${Math.floor(clamped / HOUR_MS)}h`;
  return `${Math.floor(clamped / DAY_MS)}d`;
}

/** Readable elapsed time: `just now`, `3 minutes ago`, `2 hours ago`, `1 day ago`. */
export function formatRelativeTime(at: number, now: number): string {
  const diff = Math.max(0, now - at);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${pluralize("minute", minutes)} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${pluralize("hour", hours)} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${pluralize("day", days)} ago`;
}

export function formatSize(value: number | null): string {
  if (value === null || value === undefined) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
