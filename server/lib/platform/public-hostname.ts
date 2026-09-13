// This syntactic policy excludes literal addresses and local/reserved names.
// Public DNS resolution and network routing remain the Worker platform boundary.
const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host || host.length > 253) return false;
  if (host.startsWith("[") || host.endsWith("]")) return false;
  // IPv4 literal, or anything that is all digits and dots.
  if (/^[0-9.]+$/.test(host)) return false;
  // IPv6 literal without brackets.
  if (host.includes(":")) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => HOST_LABEL_RE.test(label))) return false;
  const tld = labels[labels.length - 1];
  if (!/^[a-z]/.test(tld)) return false;
  return !RESERVED_TLDS.has(tld);
}

// atproto-reserved and local-use suffixes cannot identify a public PDS or
// handle. Keep the protocol list even where URL fetches would ordinarily fail:
// rejection must happen before attacker-chosen resolution or redirects.
const RESERVED_TLDS = new Set([
  "alt",
  "arpa",
  "example",
  "invalid",
  "local",
  "localhost",
  "onion",
  "internal",
  "intranet",
  "home",
  "lan",
  "test",
]);
