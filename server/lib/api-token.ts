// Organization-scoped programmatic access tokens for the agent/MCP surface.
//
// A token is a high-entropy random secret with a recognizable prefix, e.g.
// `dryd_pat_<43 base64url chars>`. Because the secret is 256 bits of randomness
// (not a low-entropy password), a single SHA-256 is a sufficient lookup hash —
// there is nothing to brute-force — and it lets us find the row by hash in one
// indexed read. Only the hash is persisted; the plaintext is shown to the
// creator exactly once. Mirrors `invitation-token.ts`.

const TOKEN_BYTES = 32;
export const API_TOKEN_PREFIX = "dryd_pat_";
// How much of the plaintext we keep in the clear for display (prefix + a short
// recognizable head). Never enough to reconstruct the secret.
const DISPLAY_PREFIX_CHARS = API_TOKEN_PREFIX.length + 6;

export interface GeneratedApiToken {
  token: string;
  tokenHash: string;
  tokenPrefix: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashApiToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toBase64Url(new Uint8Array(digest));
}

export function apiTokenDisplayPrefix(token: string): string {
  return token.slice(0, DISPLAY_PREFIX_CHARS);
}

export async function generateApiToken(): Promise<GeneratedApiToken> {
  const token = `${API_TOKEN_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)))}`;
  return {
    token,
    tokenHash: await hashApiToken(token),
    tokenPrefix: apiTokenDisplayPrefix(token),
  };
}

// Pull the bearer credential out of an Authorization header. Returns null for a
// missing/malformed header or a value that isn't shaped like one of our tokens,
// so a stray cookie/opaque header never reaches the hash lookup.
export function parseBearerApiToken(authorization: string | undefined | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const token = match?.[1]?.trim();
  if (!token || !token.startsWith(API_TOKEN_PREFIX)) return null;
  return token;
}
