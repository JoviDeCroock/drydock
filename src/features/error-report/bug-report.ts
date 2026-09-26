import { contactMailto } from "../../lib/contact";

// Mail clients and OSes cap `mailto:` URLs (Windows handlers at roughly 2,048
// characters), and an over-long link opens nothing at all. The per-field bounds
// keep the copyable text readable; the encoded-link bound is what keeps the
// email button working.
const MAX_FIELD_CHARS = 200;
const MAX_MESSAGE_CHARS = 400;
const MAX_STACK_FRAMES = 6;
const MAX_FRAME_CHARS = 160;
const MAX_MAILTO_CHARS = 1900;

const REDACTED = "[redacted]";
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export interface BugReportInput {
  error: unknown;
  pathname: string;
  userAgent: string;
  occurredAt: Date;
}

interface BugReport {
  page: string;
  time: string;
  browser: string;
  /** `name: message` for an Error, otherwise the thrown value as text; it can span lines. */
  error: string;
  frames: string[];
}

/**
 * The details a reader can review, copy, or email. The user sends them
 * themselves, so they must not carry anything the user would not expect to be
 * sharing: the query string and hash are dropped (verification, invite, and
 * OAuth callback parameters live there) and a public-report share token — a
 * bearer capability in the path — is replaced wherever it appears.
 */
export function buildBugReport({
  error,
  pathname,
  userAgent,
  occurredAt,
}: BugReportInput): BugReport {
  const shareToken = reportShareToken(pathname);
  const scrub = (text: string) => (shareToken ? text.replaceAll(shareToken, REDACTED) : text);
  const { summary, frames } = describeError(error, scrub);
  // `encodeURIComponent` throws on a lone surrogate, and this report is built
  // while the fallback renders, where a throw would blank the page again.
  const wellFormed = (text: string) => text.replace(LONE_SURROGATE, "\uFFFD");
  return {
    page: wellFormed(truncate(scrub(pathname), MAX_FIELD_CHARS)),
    time: occurredAt.toISOString(),
    browser: wellFormed(truncate(userAgent, MAX_FIELD_CHARS)),
    error: wellFormed(summary),
    frames: frames.map(wellFormed),
  };
}

export function bugReportText(report: BugReport): string {
  return formatReport(report);
}

/**
 * Sheds detail until the encoded link fits: stack frames from the end, then the
 * browser, then the tail of the error summary, so the error outlasts everything
 * but the page and time. The copyable text stays whole.
 */
export function bugReportMailto(report: BugReport): string {
  const whole = mailtoFor(formatReport(report));
  if (whole.length <= MAX_MAILTO_CHARS) return whole;
  for (const shorter of shorterReports(report)) {
    const href = mailtoFor(`${formatReport(shorter)}\n(trimmed; use Copy details for the rest)`);
    if (href.length <= MAX_MAILTO_CHARS) return href;
  }
  return mailtoFor("(details too long; use Copy details and paste them here)");
}

type ReportParts = Omit<BugReport, "browser"> & { browser?: string };

function* shorterReports(report: BugReport): Generator<ReportParts> {
  for (let kept = report.frames.length - 1; kept >= 0; kept--) {
    yield { ...report, frames: report.frames.slice(0, kept) };
  }
  const bare = { page: report.page, time: report.time, error: report.error, frames: [] };
  yield bare;
  // A non-ASCII message encodes to several characters per code point, so a
  // bounded one can still overflow the link on its own.
  for (let kept = Array.from(report.error).length - 1; kept > 1; kept--) {
    yield { ...bare, error: truncate(report.error, kept) };
  }
}

function formatReport({ page, time, browser, error, frames }: ReportParts): string {
  const lines = [`Page: ${page}`, `Time: ${time}`];
  if (browser !== undefined) lines.push(`Browser: ${browser}`);
  lines.push(`Error: ${error}`);
  if (frames.length > 0) lines.push("Stack:", ...frames.map((frame) => `  ${frame}`));
  return lines.join("\n");
}

function mailtoFor(details: string): string {
  return contactMailto(
    "Drydock bug report",
    `What were you doing when this happened?\n\n\n---\n${details}\n`,
  );
}

function reportShareToken(pathname: string): string | null {
  const match = /^\/reports\/([^/]+)/.exec(pathname);
  return match ? match[1] : null;
}

// Scrubbing runs before truncation so a cut can never leave half a token behind.
// Any thrown value reaches here, including ones whose getters or `toString` throw.
function describeError(
  error: unknown,
  scrub: (text: string) => string,
): { summary: string; frames: string[] } {
  try {
    return describeThrown(error, scrub);
  } catch {
    return { summary: "(the thrown value could not be described)", frames: [] };
  }
}

function describeThrown(
  error: unknown,
  scrub: (text: string) => string,
): { summary: string; frames: string[] } {
  if (!(error instanceof Error)) {
    return { summary: truncate(scrub(String(error)), MAX_MESSAGE_CHARS), frames: [] };
  }
  const header = `${error.name}: ${error.message}`;
  let stack = typeof error.stack === "string" ? error.stack : "";
  // V8 prefixes the stack with the header; Firefox and Safari list frames only.
  if (stack.startsWith(header)) stack = stack.slice(header.length);
  const frames = stack
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_STACK_FRAMES)
    .map((frame) => truncate(scrub(frame), MAX_FRAME_CHARS));
  return { summary: truncate(scrub(header), MAX_MESSAGE_CHARS), frames };
}

// Cuts on code points so an emoji at the boundary is never split in half.
function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}
