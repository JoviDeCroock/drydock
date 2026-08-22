import { base64UrlEncode, sha256Base64Url } from "../platform/crypto-utils";
// Invitation links carry a high-entropy bearer token. Only its SHA-256 hash is
// persisted (organization_invitations.token_hash), so a database read never
// yields a usable link and revocation is a single row update. This mirrors the
// password-reset token pattern: the raw token exists only in the email.

const TOKEN_BYTES = 32;

export interface InvitationToken {
  token: string;
  tokenHash: string;
}

export async function hashInvitationToken(token: string): Promise<string> {
  return sha256Base64Url(token);
}

export async function generateInvitationToken(): Promise<InvitationToken> {
  const token = base64UrlEncode(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  const tokenHash = await hashInvitationToken(token);
  return { token, tokenHash };
}
