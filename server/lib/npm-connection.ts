import type { AppDb } from "../db";
import { getNpmConnection, markNpmConnectionUsed } from "../db";

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

export type NpmCredentialStatus = "valid" | "invalid" | "capability_limited";

export type NpmCredentialReason =
  | "registry_auth_failed"
  | "staged_list_denied"
  | "staged_view_denied"
  | "staged_tarball_denied"
  | "no_stages_to_probe";

export interface NpmCredentialValidation {
  ok: boolean;
  status: NpmCredentialStatus;
  reasons: NpmCredentialReason[];
  capabilities: {
    registryAuth: boolean;
    stagedListAccess: boolean;
    stagedTarballAccess?: boolean;
    stagedViewAccess?: boolean;
    whoami?: string | null;
    registryUrl: string;
    stageId?: string;
    probedStageSource?: "caller" | "list";
    status?: number;
    stagedListStatus?: number;
    stagedViewStatus?: number;
    stagedTarballStatus?: number;
    detail?: string;
    stagedListDetail?: string;
    stagedViewDetail?: string;
    stagedTarballDetail?: string;
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
  const [auth, stagedList] = await Promise.all([
    validateRegistryAuth(registry, token),
    validateStagedListAccess(registry, token),
  ]);

  const reasons: NpmCredentialReason[] = [];
  if (!auth.registryAuth) reasons.push("registry_auth_failed");
  if (!stagedList.stagedListAccess) reasons.push("staged_list_denied");

  const callerStageId = options.stageId;
  const listedStageId =
    !callerStageId && stagedList.stagedListAccess ? stagedList.firstStageId : null;
  const probedStageId = callerStageId ?? listedStageId;

  let stagedView: Awaited<ReturnType<typeof validateStagedViewAccess>> | null = null;
  let stagedTarball: Awaited<ReturnType<typeof validateStagedTarballAccess>> | null = null;

  if (auth.registryAuth && stagedList.stagedListAccess && probedStageId) {
    [stagedView, stagedTarball] = await Promise.all([
      validateStagedViewAccess(registry, token, probedStageId),
      validateStagedTarballAccess(registry, token, probedStageId),
    ]);
    if (stagedView && !stagedView.stagedViewAccess) reasons.push("staged_view_denied");
    if (stagedTarball && !stagedTarball.stagedTarballAccess) reasons.push("staged_tarball_denied");
  } else if (auth.registryAuth && stagedList.stagedListAccess) {
    reasons.push("no_stages_to_probe");
  }

  const status: NpmCredentialStatus =
    !auth.registryAuth || !stagedList.stagedListAccess
      ? "invalid"
      : reasons.length === 0
        ? "valid"
        : "capability_limited";

  return {
    ok: status === "valid",
    status,
    reasons,
    capabilities: {
      ...auth,
      registryAuth: auth.registryAuth,
      stagedListAccess: stagedList.stagedListAccess,
      stagedListStatus: stagedList.stagedListStatus,
      stagedListDetail: stagedList.stagedListDetail,
      ...stagedView,
      ...stagedTarball,
      ...(probedStageId
        ? { probedStageSource: callerStageId ? "caller" : "list", stageId: probedStageId }
        : {}),
      registryUrl: registry,
    },
  };
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
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function validateStagedListAccess(registry: string, token: string) {
  try {
    const response = await fetch(`${registry}/-/stage?perPage=1`, {
      headers: npmAuthHeaders(token, "application/json"),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        stagedListAccess: false,
        stagedListStatus: response.status,
        stagedListDetail: response.statusText,
        firstStageId: null as string | null,
      };
    }
    const data = (await response.json().catch(() => null)) as unknown;
    const firstStageId = extractFirstStageId(data);
    return {
      stagedListAccess: true,
      stagedListStatus: response.status,
      stagedListDetail: undefined as string | undefined,
      firstStageId,
    };
  } catch (err) {
    return {
      stagedListAccess: false,
      stagedListDetail: err instanceof Error ? err.message : String(err),
      firstStageId: null as string | null,
    };
  }
}

function extractFirstStageId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as { items?: unknown };
  if (!Array.isArray(root.items)) return null;
  for (const entry of root.items) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { id?: unknown; stageId?: unknown };
    const candidate =
      typeof record.id === "string" && record.id.trim()
        ? record.id.trim()
        : typeof record.stageId === "string" && record.stageId.trim()
          ? record.stageId.trim()
          : null;
    if (candidate) return candidate;
  }
  return null;
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
      stagedViewDetail: err instanceof Error ? err.message : String(err),
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
