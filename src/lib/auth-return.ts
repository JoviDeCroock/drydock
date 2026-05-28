const DEFAULT_AUTH_RETURN_TO = "/dashboard";

export function normalizeAuthReturnTo(value: unknown, origin?: string): string {
  if (typeof value !== "string" || !value.trim()) return DEFAULT_AUTH_RETURN_TO;
  const baseOrigin = origin ?? window.location.origin;
  try {
    const parsed = new URL(value, baseOrigin);
    if (parsed.origin !== baseOrigin) return DEFAULT_AUTH_RETURN_TO;
    if (!parsed.pathname.startsWith("/dashboard")) return DEFAULT_AUTH_RETURN_TO;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return DEFAULT_AUTH_RETURN_TO;
  }
}
