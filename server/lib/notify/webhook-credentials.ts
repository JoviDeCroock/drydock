import { base64UrlDecode, base64UrlEncode } from "../platform/crypto-utils";

export interface EncryptedWebhookCredentials {
  ciphertext: string;
  nonce: string;
}

const CIPHERTEXT_VERSION_V1 = "v1:";

// Endpoint URLs can contain credentials in their path/query, so encrypt both fields.
export async function encryptWebhookCredentials(
  env: Cloudflare.Env,
  credentials: { url: string; secret: string },
): Promise<EncryptedWebhookCredentials> {
  if (!credentials.url || !credentials.secret) throw new Error("Webhook credentials are empty");
  const plaintext = JSON.stringify(credentials);
  const key = await encryptionKey(env);
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

export async function decryptWebhookCredentials(
  env: Cloudflare.Env,
  encrypted: { ciphertext: string; nonce: string },
): Promise<{ url: string; secret: string }> {
  const payload = splitCiphertext(encrypted.ciphertext);
  const key = await encryptionKey(env);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(encrypted.nonce) },
    key,
    base64UrlDecode(payload),
  );
  const value: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  if (
    !value ||
    typeof value !== "object" ||
    !("url" in value) ||
    !("secret" in value) ||
    typeof value.url !== "string" ||
    typeof value.secret !== "string" ||
    !value.url ||
    !value.secret
  ) {
    throw new Error("Webhook credentials are invalid");
  }
  return { url: value.url, secret: value.secret };
}

function splitCiphertext(value: string): string {
  if (value.startsWith(CIPHERTEXT_VERSION_V1)) return value.slice(CIPHERTEXT_VERSION_V1.length);
  throw new Error("Webhook credential version is unsupported");
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
      salt: new TextEncoder().encode("drydock:webhook-credentials:salt:v1"),
      info: new TextEncoder().encode("aes-gcm-256"),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
