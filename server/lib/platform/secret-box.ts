import { base64UrlDecode, base64UrlEncode } from "./crypto-utils";

export interface EncryptedSlackBotToken {
  ciphertext: string;
  nonce: string;
}

const CIPHERTEXT_VERSION_V1 = "v1:";

/**
 * Symmetric encryption for an organization's Slack bot token (`xoxb-…`). It
 * mirrors the AES-GCM + HKDF scheme used for npm connection tokens and reuses the
 * same key material (`NPM_CONNECTIONS_ENCRYPTION_KEY`), but with a distinct HKDF
 * salt/info so the derived key is domain-separated from npm tokens. The bot token
 * is the credential that posts release alerts on the org's behalf, so it is never
 * stored or logged in clear — only the ciphertext + nonce are persisted.
 */
export async function encryptSlackBotToken(
  env: Cloudflare.Env,
  plaintext: string,
): Promise<EncryptedSlackBotToken> {
  const trimmed = plaintext.trim();
  if (!trimmed) throw new Error("slack bot token is empty");
  const key = await encryptionKey(env);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    new TextEncoder().encode(trimmed),
  );
  return {
    ciphertext: CIPHERTEXT_VERSION_V1 + base64UrlEncode(new Uint8Array(ciphertext)),
    nonce: base64UrlEncode(nonce),
  };
}

export async function decryptSlackBotToken(
  env: Cloudflare.Env,
  encrypted: { ciphertext: string; nonce: string },
): Promise<string> {
  const payload = splitCiphertext(encrypted.ciphertext);
  const key = await encryptionKey(env);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(encrypted.nonce) },
    key,
    base64UrlDecode(payload),
  );
  return new TextDecoder().decode(plaintext);
}

function splitCiphertext(value: string): string {
  if (value.startsWith(CIPHERTEXT_VERSION_V1)) return value.slice(CIPHERTEXT_VERSION_V1.length);
  return value;
}

async function encryptionKey(env: Cloudflare.Env) {
  const secret = env.NPM_CONNECTIONS_ENCRYPTION_KEY;
  if (!secret) throw new Error("NPM_CONNECTIONS_ENCRYPTION_KEY is required");
  if (secret.length < 32) {
    throw new Error("NPM_CONNECTIONS_ENCRYPTION_KEY must be at least 32 characters of entropy");
  }
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("drydock:slack-bot-token:salt:v1"),
      info: new TextEncoder().encode("aes-gcm-256"),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
