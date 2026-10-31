import { base64UrlDecode, base64UrlEncode } from "./crypto-utils";

export interface SealedSecret {
  ciphertext: string;
  nonce: string;
}

export type EncryptedSlackBotToken = SealedSecret;

/**
 * Domain separation for secrets sealed under `NPM_CONNECTIONS_ENCRYPTION_KEY`.
 * Each purpose derives its own AES-GCM key through a distinct HKDF salt, so a
 * ciphertext of one kind can never be decrypted as another. Add a purpose
 * rather than reusing one.
 */
export type SecretPurpose = "slack-bot-token" | "pypi-project-token" | "pypi-session-links";

const CIPHERTEXT_VERSION_V1 = "v1:";

/**
 * Symmetric encryption for organization secrets that are not npm tokens. It
 * mirrors the AES-GCM + HKDF scheme used for npm connection tokens and reuses the
 * same key material (`NPM_CONNECTIONS_ENCRYPTION_KEY`), with a per-purpose HKDF
 * salt. Only ciphertext + nonce are ever persisted.
 */
export async function sealSecret(
  env: Cloudflare.Env,
  purpose: SecretPurpose,
  plaintext: string,
): Promise<SealedSecret> {
  if (!plaintext) throw new Error(`${purpose} is empty`);
  const key = await encryptionKey(env, purpose);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    ciphertext: CIPHERTEXT_VERSION_V1 + base64UrlEncode(new Uint8Array(ciphertext)),
    nonce: base64UrlEncode(nonce),
  };
}

export async function openSecret(
  env: Cloudflare.Env,
  purpose: SecretPurpose,
  sealed: SealedSecret,
): Promise<string> {
  const payload = splitCiphertext(sealed.ciphertext);
  const key = await encryptionKey(env, purpose);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(sealed.nonce) },
    key,
    base64UrlDecode(payload),
  );
  return new TextDecoder().decode(plaintext);
}

/** Slack bot token (`xoxb-…`): the credential that posts release alerts. */
export async function encryptSlackBotToken(
  env: Cloudflare.Env,
  plaintext: string,
): Promise<EncryptedSlackBotToken> {
  const trimmed = plaintext.trim();
  if (!trimmed) throw new Error("slack bot token is empty");
  return sealSecret(env, "slack-bot-token", trimmed);
}

export async function decryptSlackBotToken(
  env: Cloudflare.Env,
  encrypted: { ciphertext: string; nonce: string },
): Promise<string> {
  return openSecret(env, "slack-bot-token", encrypted);
}

function splitCiphertext(value: string): string {
  if (value.startsWith(CIPHERTEXT_VERSION_V1)) return value.slice(CIPHERTEXT_VERSION_V1.length);
  return value;
}

async function encryptionKey(env: Cloudflare.Env, purpose: SecretPurpose) {
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
      // The Slack salt predates the generic helper; the template reproduces it
      // exactly so stored Slack ciphertexts keep decrypting.
      salt: new TextEncoder().encode(`drydock:${purpose}:salt:v1`),
      info: new TextEncoder().encode("aes-gcm-256"),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
