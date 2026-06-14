import type { AppDb } from "../db";
import { getNpmConnection, markNpmConnectionUsed } from "../db";
import { base64UrlDecode, base64UrlEncode } from "./crypto-utils";
import { errorMessage } from "./errors";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export interface NormalizeRegistryUrlOptions {
  allowInsecureLocalhost?: boolean;
}

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
    stagedListAccess: boolean;
    stagedTarballAccess?: boolean;
    stagedViewAccess?: boolean;
    readOnly?: boolean;
    whoami?: string | null;
    registryUrl: string;
    stageId?: string;
    status?: number;
    stagedListStatus?: number;
    stagedViewStatus?: number;
    stagedTarballStatus?: number;
    detail?: string;
    readOnlyMetadataAvailable?: boolean;
    stagedListDetail?: string;
    stagedViewDetail?: string;
    stagedTarballDetail?: string;
    readOnlyDetail?: string;
  };
}

export function allowInsecureLocalRegistry(
  env: Pick<Cloudflare.Env, "ALLOW_INSECURE_LOCAL_REGISTRY">,
): boolean {
  return env.ALLOW_INSECURE_LOCAL_REGISTRY === "true";
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1"
  );
}

export function registryProtocolAllowed(
  url: URL,
  options: NormalizeRegistryUrlOptions = {},
): boolean {
  return (
    url.protocol === "https:" ||
    (options.allowInsecureLocalhost === true &&
      url.protocol === "http:" &&
      isLoopbackHostname(url.hostname))
  );
}

export function normalizeRegistryUrl(
  value: unknown,
  options: NormalizeRegistryUrlOptions = {},
): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_REGISTRY;
  const url = new URL(raw);
  if (!registryProtocolAllowed(url, options)) throw new Error("registry URL must use https");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function publicNpmConnection(
  connection: Awaited<ReturnType<typeof getNpmConnection>>,
): PublicNpmConnection | null {
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

const CIPHERTEXT_VERSION_V1 = "v1:";

export async function encryptNpmToken(env: Cloudflare.Env, token: string): Promise<EncryptedToken> {
  const trimmed = token.trim();
  if (trimmed.length < 16) throw new Error("npm token is too short");
  const key = await encryptionKey(env, "v1");
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    new TextEncoder().encode(trimmed),
  );
  return {
    tokenCiphertext: CIPHERTEXT_VERSION_V1 + base64UrlEncode(new Uint8Array(ciphertext)),
    tokenNonce: base64UrlEncode(nonce),
    tokenFingerprint: await tokenFingerprint(trimmed),
    tokenLast4: trimmed.slice(-4),
  };
}

export async function decryptNpmToken(
  env: Cloudflare.Env,
  encrypted: { tokenCiphertext: string; tokenNonce: string },
): Promise<string> {
  const { version, payload } = splitCiphertext(encrypted.tokenCiphertext);
  const key = await encryptionKey(env, version);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(encrypted.tokenNonce) },
    key,
    base64UrlDecode(payload),
  );
  return new TextDecoder().decode(plaintext);
}

function splitCiphertext(value: string): { version: "v0" | "v1"; payload: string } {
  if (value.startsWith(CIPHERTEXT_VERSION_V1)) {
    return { version: "v1", payload: value.slice(CIPHERTEXT_VERSION_V1.length) };
  }
  return { version: "v0", payload: value };
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
  options: { stageId?: string; allowInsecureLocalhost?: boolean } = {},
): Promise<NpmCredentialValidation> {
  const registry = normalizeRegistryUrl(registryUrl, {
    allowInsecureLocalhost: options.allowInsecureLocalhost,
  });
  const [auth, stagedList, stagedView, stagedTarball] = await Promise.all([
    validateRegistryAuth(registry, token),
    validateStagedListAccess(registry, token),
    options.stageId
      ? validateStagedViewAccess(registry, token, options.stageId)
      : Promise.resolve(null),
    options.stageId
      ? validateStagedTarballAccess(registry, token, options.stageId)
      : Promise.resolve(null),
  ]);

  const baselineOk =
    auth.registryAuth &&
    stagedList.stagedListAccess &&
    (stagedView ? stagedView.stagedViewAccess : true) &&
    (stagedTarball ? stagedTarball.stagedTarballAccess : true);
  const npmjsRegistry = isNpmjsRegistry(registry);
  const readOnlyCheck: {
    readOnly?: boolean;
    readOnlyMetadataAvailable?: boolean;
    readOnlyDetail?: string;
  } = baselineOk
    ? npmjsRegistry
      ? await validateTokenReadOnly(registry, token)
      : { readOnly: true }
    : {};

  const ok = baselineOk && readOnlyCheck.readOnly !== false;

  return {
    ok,
    status: ok ? "valid" : "invalid",
    capabilities: {
      ...auth,
      ...stagedList,
      ...stagedView,
      ...stagedTarball,
      ...readOnlyCheck,
      registryUrl: registry,
    },
  };
}

function isNpmjsRegistry(registry: string): boolean {
  try {
    const url = new URL(registry);
    return url.hostname === "registry.npmjs.org";
  } catch {
    return false;
  }
}

/**
 * Checks whether the token is read-only by inspecting the caller's token
 * list on npmjs.org (`GET /-/npm/v1/tokens`). Drydock only needs read access
 * to staged artifacts; a write-capable token is an unnecessary blast radius.
 *
 * The `/tokens` endpoint only accepts session tokens as of the npm API docs.
 * If npm does not expose metadata for the submitted token, Drydock preserves
 * the existing staged-access validation result and only rejects when metadata
 * proves the token is write-capable.
 */
async function validateTokenReadOnly(
  registry: string,
  token: string,
): Promise<{
  readOnly?: boolean;
  readOnlyMetadataAvailable: boolean;
  readOnlyDetail?: string;
}> {
  try {
    const response = await fetch(`${registry}/-/npm/v1/tokens?perPage=100`, {
      headers: npmAuthHeaders(token, "application/json"),
    });
    if (!response.ok) {
      return {
        readOnlyMetadataAvailable: false,
        readOnlyDetail: `token metadata endpoint returned ${response.status}; could not verify read-only`,
      };
    }
    const data = (await response.json().catch(() => null)) as {
      objects?: unknown[];
    } | null;
    const objects = Array.isArray(data?.objects) ? data.objects : [];
    if (objects.length === 0) {
      return {
        readOnlyMetadataAvailable: false,
        readOnlyDetail: "token metadata returned no tokens; could not verify read-only",
      };
    }

    const redacted = redactTokenForMatching(token);
    const matched = objects.map(parseNpmTokenMetadata).find((entry) => entry?.token === redacted);

    if (!matched) {
      return {
        readOnlyMetadataAvailable: false,
        readOnlyDetail: "could not match token in metadata listing; could not verify read-only",
      };
    }

    if (matched.readonly === true && !hasWritePermission(matched)) {
      return { readOnly: true, readOnlyMetadataAvailable: true };
    }

    return {
      readOnly: false,
      readOnlyMetadataAvailable: true,
      readOnlyDetail: "npm token has write permissions; Drydock requires a read-only token",
    };
  } catch (err) {
    return {
      readOnlyMetadataAvailable: false,
      readOnlyDetail: `token read-only check failed: ${errorMessage(err)}`,
    };
  }
}

interface NpmTokenMetadata {
  token?: string;
  readonly?: boolean;
  permissions: Array<{ action: string }>;
}

function parseNpmTokenMetadata(value: unknown): NpmTokenMetadata | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as { token?: unknown; readonly?: unknown; permissions?: unknown };
  return {
    token: typeof entry.token === "string" ? entry.token : undefined,
    readonly: typeof entry.readonly === "boolean" ? entry.readonly : undefined,
    permissions: parseNpmTokenPermissions(entry.permissions),
  };
}

function parseNpmTokenPermissions(value: unknown): Array<{ action: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((permission) => {
    if (!permission || typeof permission !== "object") return [];
    const entry = permission as { action?: unknown };
    return typeof entry.action === "string" ? [{ action: entry.action }] : [];
  });
}

function hasWritePermission(metadata: NpmTokenMetadata): boolean {
  return metadata.permissions.some((permission) => {
    const action = permission.action.toLowerCase();
    return action.includes("write") || action.includes("publish");
  });
}

/**
 * npm redacts listed tokens to `npm_aBcD...7890` (first 8 chars + "..." +
 * last 4 chars). Reproduce this format from the raw token for matching.
 */
function redactTokenForMatching(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

async function validateRegistryAuth(registry: string, token: string) {
  try {
    const response = await fetch(`${registry}/-/whoami`, {
      headers: npmAuthHeaders(token, "application/json"),
    });
    const data = (await response.json().catch(() => null)) as {
      username?: unknown;
      error?: unknown;
    } | null;
    const whoami = typeof data?.username === "string" ? data.username : null;
    const registryAuth = response.ok && Boolean(whoami);
    return {
      registryAuth,
      whoami,
      status: response.status,
      detail: registryAuth
        ? undefined
        : typeof data?.error === "string"
          ? data.error
          : response.statusText,
    };
  } catch (err) {
    return {
      registryAuth: false,
      detail: errorMessage(err),
    };
  }
}

async function validateStagedListAccess(registry: string, token: string) {
  try {
    const response = await fetch(`${registry}/-/stage?perPage=1`, {
      headers: npmAuthHeaders(token, "application/json"),
    });
    await response.body?.cancel();
    return {
      stagedListAccess: response.ok,
      stagedListStatus: response.status,
      stagedListDetail: response.ok ? undefined : response.statusText,
    };
  } catch (err) {
    return {
      stagedListAccess: false,
      stagedListDetail: errorMessage(err),
    };
  }
}

async function validateStagedViewAccess(registry: string, token: string, stageId: string) {
  const url = `${registry}/-/stage/${encodeURIComponent(stageId)}`;
  try {
    const response = await fetch(url, {
      headers: npmAuthHeaders(token, "application/json"),
    });
    await response.body?.cancel();
    return {
      stageId,
      stagedViewAccess: response.ok,
      stagedViewStatus: response.status,
      stagedViewDetail: response.ok ? undefined : response.statusText,
    };
  } catch (err) {
    return {
      stageId,
      stagedViewAccess: false,
      stagedViewDetail: errorMessage(err),
    };
  }
}

async function validateStagedTarballAccess(registry: string, token: string, stageId: string) {
  const url = `${registry}/-/stage/${encodeURIComponent(stageId)}/tarball`;
  try {
    const ranged = await fetch(url, {
      headers: {
        ...npmAuthHeaders(token, "application/octet-stream"),
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
      stagedTarballDetail: errorMessage(err),
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

async function encryptionKey(env: Cloudflare.Env, version: "v0" | "v1") {
  const secret = env.NPM_CONNECTIONS_ENCRYPTION_KEY;
  if (!secret) throw new Error("NPM_CONNECTIONS_ENCRYPTION_KEY is required");
  if (secret.length < 32) {
    throw new Error("NPM_CONNECTIONS_ENCRYPTION_KEY must be at least 32 characters of entropy");
  }
  const ikm = new TextEncoder().encode(secret);
  if (version === "v0") {
    const digest = await crypto.subtle.digest("SHA-256", ikm);
    return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  }
  const keyMaterial = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("staged-publish-review:npm-connection:salt:v1"),
      info: new TextEncoder().encode("aes-gcm-256"),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function tokenFingerprint(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return base64UrlEncode(new Uint8Array(digest));
}
