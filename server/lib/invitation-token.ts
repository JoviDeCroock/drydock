// Invitation links carry a high-entropy bearer token. Only its SHA-256 hash is
// persisted (organization_invitations.token_hash), so a database read never
// yields a usable link and revocation is a single row update. This mirrors the
// password-reset token pattern: the raw token exists only in the email.

const TOKEN_BYTES = 32;

export interface InvitationToken {
  token: string;
  tokenHash: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashInvitationToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toBase64Url(new Uint8Array(digest));
}

export async function generateInvitationToken(): Promise<InvitationToken> {
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  const tokenHash = await hashInvitationToken(token);
  return { token, tokenHash };
}
