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

export const RESET_PASSWORD_PATH = "/reset-password";

// Anyone can ask for a reset link for any address, so the inbox that opens it
// need not belong to whoever chose where it leads, and the mail itself comes
// from Drydock. A mailed destination may therefore only say where to go: its
// query may hold only these view parameters (the organization, settings tab,
// and the `useQuerySignal` names of the list, review, and diff pages) and its
// fragment only a section id. Anything else — an invitation token, a GitHub
// install callback's code and state, the Slack callback's message — falls back
// to the default rather than being mailed. A new view parameter that should
// survive a reset has to be added here; until then it degrades to /dashboard.
const MAILABLE_QUERY_PARAMS: ReadonlySet<string> = new Set([
  "org",
  "tab",
  "filter",
  "file",
  "changedOnly",
  "version",
  "path",
  "ecosystem",
]);
const MAILABLE_FRAGMENT = /^(?:#[\w-]*)?$/;
// The link goes out on one unwrapped 8bit mail line, which RFC 5322 caps at
// 998 characters; this leaves room for markup, the token, and an origin of
// up to about 120 characters.
const MAILED_RETURN_TO_MAX_ENCODED_LENGTH = 768;

function mailableAuthReturnTo(value: unknown, origin?: string): string {
  const target = normalizeAuthReturnTo(value, origin);
  if (target === DEFAULT_AUTH_RETURN_TO) return target;
  // `target` is root-relative now, so any base parses it the same way.
  const parsed = new URL(target, "https://drydock.invalid");
  const plainQuery = [...parsed.searchParams.keys()].every((name) =>
    MAILABLE_QUERY_PARAMS.has(name),
  );
  return plainQuery && MAILABLE_FRAGMENT.test(parsed.hash) ? target : DEFAULT_AUTH_RETURN_TO;
}

/**
 * The reset page an emailed link opens, carrying a mailable destination in
 * `returnTo`. The query is percent-encoded beyond `encodeURIComponent` because
 * Better Auth accepts a relative `redirectTo` only when its query is limited
 * to `[\w\-.+/=&%@]`.
 */
export function passwordResetPagePath(returnTo: unknown, origin?: string): string {
  const target = mailableAuthReturnTo(returnTo, origin);
  if (target === DEFAULT_AUTH_RETURN_TO) return RESET_PASSWORD_PATH;
  const encoded = encodeURIComponent(target).replace(
    /[!'()*~]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  if (encoded.length > MAILED_RETURN_TO_MAX_ENCODED_LENGTH) return RESET_PASSWORD_PATH;
  return `${RESET_PASSWORD_PATH}?returnTo=${encoded}`;
}

/**
 * The destination a requested reset page carries, checked again as mailable.
 * Anything but this origin's reset page carries none.
 */
export function passwordResetPageReturnTo(pagePath: unknown, origin: string): string {
  if (typeof pagePath !== "string" || pagePath.includes("\\")) return DEFAULT_AUTH_RETURN_TO;
  try {
    const parsed = new URL(pagePath, origin);
    if (parsed.origin !== origin || parsed.pathname !== RESET_PASSWORD_PATH) {
      return DEFAULT_AUTH_RETURN_TO;
    }
    return mailableAuthReturnTo(parsed.searchParams.get("returnTo"), origin);
  } catch {
    return DEFAULT_AUTH_RETURN_TO;
  }
}
