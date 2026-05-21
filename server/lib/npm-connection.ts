import type { AppDb } from "../db";
import { getNpmConnection, markNpmConnectionUsed } from "../db";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export interface EncryptedToken {
  tokenCiphertext: string;
  tokenNonce: string;
  tokenFingerprint: string;
  tokenLast4: string;
}

export interface PublicNpmConnection {
  id: string;
  organizationId: string;
  registryUrl: string;
  label: string;
  tokenFingerprint: string;
  tokenLast4: string | null;
  validationStatus: string;
  capabilitiesJson: unknown;
  validatedAt: Date | string | number | null;
  lastUsedAt: Date | string | number | null;
  createdByUserId: string | null;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
}

export interface NpmCredentialValidation {
  ok: boolean;
  status: "valid" | "invalid";
  capabilities: {
    registryAuth: boolean;
    stagedTarballAccess?: boolean;
    whoami?: string | null;
    registryUrl: string;
    stageId?: string;
    status?: number;
    stagedTarballStatus?: number;
    detail?: string;
    stagedTarballDetail?: string;
  };
}

export function normalizeRegistryUrl(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_REGISTRY;
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("registry URL must use https");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function publicNpmConnection(connection: Awaited<ReturnType<typeof getNpmConnection>>): PublicNpmConnection | null {
  if (!connection) return null;
  return {
    id: connection.id,
    organizationId: connection.organizationId,
    registryUrl: connection.registryUrl,
    label: connection.label,
    tokenFingerprint: connection.tokenFingerprint,
    tokenLast4: connection.tokenLast4,
    validationStatus: connection.validationStatus,
    capabilitiesJson: connection.capabilitiesJson,
    validatedAt: connection.validatedAt,
    lastUsedAt: connection.lastUsedAt,
    createdByUserId: connection.createdByUserId,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

export async function encryptNpmToken(env: Cloudflare.Env, token: string): Promise<EncryptedToken> {
  const trimmed = token.trim();
  if (trimmed.length < 16) throw new Error("npm token is too short");
  const key = await encryptionKey(env);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    new TextEncoder().encode(trimmed),
  );
  return {
    tokenCiphertext: base64UrlEncode(new Uint8Array(ciphertext)),
    tokenNonce: base64UrlEncode(nonce),
    tokenFingerprint: await tokenFingerprint(trimmed),
    tokenLast4: trimmed.slice(-4),
  };
}

export async function decryptNpmToken(
  env: Cloudflare.Env,
  encrypted: { tokenCiphertext: string; tokenNonce: string },
): Promise<string> {
  const key = await encryptionKey(env);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(encrypted.tokenNonce) },
    key,
    base64UrlDecode(encrypted.tokenCiphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export async function getOrganizationNpmToken(
  db: AppDb,
  env: Cloudflare.Env,
  organizationId: string,
): Promise<{ token: string; registryUrl: string } | null> {
  const connection = await getNpmConnection(db, organizationId);
  if (!connection) return null;
  const token = await decryptNpmToken(env, connection);
  await markNpmConnectionUsed(db, organizationId);
  return { token, registryUrl: connection.registryUrl };
}

export async function validateNpmCredential(
  registryUrl: string,
  token: string,
  options: { stageId?: string } = {},
): Promise<NpmCredentialValidation> {
  const registry = normalizeRegistryUrl(registryUrl);
  const auth = await validateRegistryAuth(registry, token);
  const stagedTarball = options.stageId
    ? await validateStagedTarballAccess(registry, token, options.stageId)
    : null;
  const ok = auth.registryAuth && (stagedTarball ? stagedTarball.stagedTarballAccess : true);

  return {
    ok,
    status: ok ? "valid" : "invalid",
    capabilities: {
      ...auth,
      ...(stagedTarball ?? {}),
      registryUrl: registry,
    },
  };
}

async function validateRegistryAuth(registry: string, token: string) {
  try {
    const response = await fetch(`${registry}/-/whoami`, {
      headers: npmAuthHeaders(token, "application/json"),
    });
    const data = (await response.json().catch(() => null)) as { username?: unknown; error?: unknown } | null;
    const whoami = typeof data?.username === "string" ? data.username : null;
    const registryAuth = response.ok && Boolean(whoami);
    return {
      registryAuth,
      whoami,
      status: response.status,
      detail: registryAuth ? undefined : typeof data?.error === "string" ? data.error : response.statusText,
    };
  } catch (err) {
    return {
      registryAuth: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function validateStagedTarballAccess(registry: string, token: string, stageId: string) {
  const url = `${registry}/-/stage/${encodeURIComponent(stageId)}/tarball`;
  try {
    const head = await fetch(url, {
      method: "HEAD",
      headers: npmAuthHeaders(token, "application/octet-stream"),
    });
    if (head.ok) {
      return { stageId, stagedTarballAccess: true, stagedTarballStatus: head.status };
    }
    // Some registry endpoints do not implement HEAD consistently, so fall back to a ranged GET
    // for any non-OK HEAD response. The body is cancelled immediately after headers arrive.
    const ranged = await fetch(url, {
      headers: {
        ...npmAuthHeadersRecord(token, "application/octet-stream"),
        range: "bytes=0-0",
      },
    });
    await ranged.body?.cancel();
    return {
      stageId,
      stagedTarballAccess: ranged.ok || ranged.status === 206,
      stagedTarballStatus: ranged.status,
      stagedTarballDetail: ranged.ok || ranged.status === 206 ? undefined : ranged.statusText,
    };
  } catch (err) {
    return {
      stageId,
      stagedTarballAccess: false,
      stagedTarballDetail: err instanceof Error ? err.message : String(err),
    };
  }
}

function npmAuthHeaders(token: string, accept: string) {
  return {
    accept,
    authorization: `Bearer ${token}`,
    "user-agent": "staged-publish-review/credential-validation",
  };
}

function npmAuthHeadersRecord(token: string, accept: string): Record<string, string> {
  return npmAuthHeaders(token, accept);
}

async function encryptionKey(env: Cloudflare.Env) {
  const secret = env.NPM_CONNECTIONS_ENCRYPTION_KEY || env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("NPM_CONNECTIONS_ENCRYPTION_KEY or BETTER_AUTH_SECRET is required");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function tokenFingerprint(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
