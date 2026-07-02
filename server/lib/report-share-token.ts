// Public report links carry a high-entropy bearer token. Only its SHA-256 hash
// is persisted (scan_report_shares.token_hash), so a database read never yields
// a usable link and rotation/revocation is a single row update. This mirrors
// the invitation-token pattern: the raw token exists only in the shared URL.

const TOKEN_BYTES = 32;

// base64url of 32 bytes is 43 characters; the format check lets the public
// route reject junk before touching the database.
export const REPORT_SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{40,48}$/;

export interface ReportShareToken {
  token: string;
  tokenHash: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashReportShareToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toBase64Url(new Uint8Array(digest));
}

export async function generateReportShareToken(): Promise<ReportShareToken> {
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  const tokenHash = await hashReportShareToken(token);
  return { token, tokenHash };
}
