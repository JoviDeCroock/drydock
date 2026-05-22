const INVITE_TOKEN_PREFIX = "inv_";
const INVITE_TOKEN_BYTES = 24;
export const INVITE_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function generateInviteToken(): string {
  const bytes = new Uint8Array(INVITE_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return `${INVITE_TOKEN_PREFIX}${base64UrlEncode(bytes)}`;
}

export async function hashInviteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return bytesToHex(new Uint8Array(digest));
}

export function inviteTokenLast4(token: string): string {
  return token.slice(-4);
}

export function buildInviteUrl(baseUrl: string | undefined, token: string): string {
  const path = `/invites/${encodeURIComponent(token)}`;
  if (!baseUrl) return path;
  try {
    return new URL(path, baseUrl).toString();
  } catch {
    return path;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/u, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
