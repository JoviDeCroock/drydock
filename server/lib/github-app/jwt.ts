import { base64UrlEncode, base64UrlString } from "../crypto-utils";
import type { GithubAppConfig } from "./config";

export async function generateGithubAppJwt(config: GithubAppConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlString(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlString(
    JSON.stringify({
      iat: now - 60,
      exp: now + 10 * 60,
      iss: config.appId,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const key = await importPrivateKey(config.privateKeyPem);
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)),
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.replace(/\\n/g, "\n");
  const isPkcs1 = /-----BEGIN RSA PRIVATE KEY-----/.test(normalized);
  const begin = isPkcs1 ? /-----BEGIN RSA PRIVATE KEY-----/ : /-----BEGIN PRIVATE KEY-----/;
  const end = isPkcs1 ? /-----END RSA PRIVATE KEY-----/ : /-----END PRIVATE KEY-----/;
  let base64 = normalized.replace(begin, "").replace(end, "").replace(/\s/g, "");
  base64 = base64.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = base64.length % 4;
  if (remainder === 2) base64 += "==";
  else if (remainder === 3) base64 += "=";
  const keyData = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const binary = isPkcs1 ? wrapPkcs1RsaPrivateKey(keyData) : keyData;
  return crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(binary),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function wrapPkcs1RsaPrivateKey(pkcs1: Uint8Array): Uint8Array {
  const rsaEncryptionOid = new Uint8Array([
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  ]);
  const algorithmIdentifier = derSequence(
    concatBytes(rsaEncryptionOid, new Uint8Array([0x05, 0x00])),
  );
  return derSequence(concatBytes(derIntegerZero(), algorithmIdentifier, derOctetString(pkcs1)));
}

function derIntegerZero(): Uint8Array {
  return new Uint8Array([0x02, 0x01, 0x00]);
}

function derOctetString(value: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([0x04]), derLength(value.length), value);
}

function derSequence(value: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([0x30]), derLength(value.length), value);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  return combined;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
