const DEFAULT_AUTH_RETURN_TO = "/dashboard";

// Where sign-in may send someone back to. The dashboard is the app; /diff is
// the public page an anonymous reader was on when they chose to sign up, and
// returning them to it keeps the review they were reading. /reports/:token is
// deliberately absent: a share token is a capability and must not be copied
// into auth URLs, emails, or provider callbacks.
const AUTH_RETURN_SECTIONS = ["/dashboard", "/diff"] as const;

export function normalizeAuthReturnTo(value: unknown, origin?: string): string {
  if (typeof value !== "string" || !value.trim()) return DEFAULT_AUTH_RETURN_TO;
  // The URL parser treats a backslash as a slash, so "/\evil.com" is a
  // protocol-relative URL to another host; refuse it before parsing.
  if (value.includes("\\")) return DEFAULT_AUTH_RETURN_TO;
  const baseOrigin = origin ?? window.location.origin;
  try {
    const parsed = new URL(value, baseOrigin);
    if (parsed.origin !== baseOrigin) return DEFAULT_AUTH_RETURN_TO;
    // Dot segments are already resolved by the parser, so the section check
    // reads the path the router will actually see.
    const { pathname } = parsed;
    if (pathname.includes("//")) return DEFAULT_AUTH_RETURN_TO;
    const allowed = AUTH_RETURN_SECTIONS.some(
      (section) => pathname === section || pathname.startsWith(`${section}/`),
    );
    if (!allowed) return DEFAULT_AUTH_RETURN_TO;
    return `${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return DEFAULT_AUTH_RETURN_TO;
  }
}
