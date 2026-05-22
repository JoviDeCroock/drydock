const SAFE_PATH_RE = /^\/[A-Za-z0-9_\-./?&=%]*$/u;

export function resolveNextPath(raw: unknown, fallback = "/dashboard"): string {
  if (typeof raw !== "string" || !raw) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  if (!SAFE_PATH_RE.test(raw)) return fallback;
  return raw;
}
