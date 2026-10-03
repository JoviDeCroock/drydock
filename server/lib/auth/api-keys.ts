import { base64UrlEncode, sha256Base64Url } from "../platform/crypto-utils";

// Organization API keys are bearer credentials for scripts and the CLI. Only the
// SHA-256 of a key is persisted (organization_api_keys.key_hash), like
// invitation tokens: a database read never yields a usable key, and 256 bits of
// entropy make a slow hash unnecessary. The `ddk_` head lets secret scanners
// and humans recognize a leaked key.

const API_KEY_TOKEN_PREFIX = "ddk_";
const SECRET_BYTES = 32;
const TOKEN_RE = /^ddk_[A-Za-z0-9_-]{43}$/;
// The token prefix plus eight secret characters: enough to tell keys apart in
// settings, far too little to matter against the remaining 208 bits.
const DISPLAY_PREFIX_LENGTH = API_KEY_TOKEN_PREFIX.length + 8;

export const API_KEY_NAME_MAX_LENGTH = 64;
export const MAX_API_KEYS_PER_ORGANIZATION = 10;
export const API_KEY_EXPIRY_DAYS = [30, 90, 365] as const;
export type ApiKeyExpiryDays = (typeof API_KEY_EXPIRY_DAYS)[number];

/** Per-key request budget; a native per-minute tier serves it without a D1 write. */
export const API_KEY_REQUESTS_PER_MINUTE = 120;

/**
 * Per-IP budget for presenting keys at all, charged before the key lookup. A
 * cookieless request reaches D1 nowhere else, so without it any well-formed
 * random `ddk_` token would buy an anonymous D1 read. Twice the per-key budget
 * leaves room for two keys at full speed behind one address.
 */
export const API_KEY_ATTEMPTS_PER_IP_PER_MINUTE = 240;

export interface GeneratedApiKey {
  token: string;
  prefix: string;
  keyHash: string;
}

export interface ApiKeyPrincipal {
  id: string;
  organizationId: string;
}

export async function generateApiKey(): Promise<GeneratedApiKey> {
  const token = `${API_KEY_TOKEN_PREFIX}${base64UrlEncode(
    crypto.getRandomValues(new Uint8Array(SECRET_BYTES)),
  )}`;
  return {
    token,
    prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
    keyHash: await hashApiKey(token),
  };
}

export function hashApiKey(token: string): Promise<string> {
  return sha256Base64Url(token);
}

export function isWellFormedApiKey(token: string): boolean {
  return TOKEN_RE.test(token);
}

/**
 * The API key a request presents, or null when it presents none. Only
 * `Authorization: Bearer ddk_…` selects key authentication; any other
 * Authorization value (for example HTTP basic auth in front of a self-hosted
 * staging deploy) is left alone and the request keeps its cookie session path.
 * A request that does select a key is never also authenticated by cookie.
 */
export function readApiKeyCredential(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization);
  if (!match) return null;
  const credential = match[1];
  return credential.startsWith(API_KEY_TOKEN_PREFIX) ? credential : null;
}

/**
 * The only endpoints an API key reaches, as `METHOD path` exactly as Hono
 * registers the route that answers the request. Matching the answering route
 * rather than the URL keeps `/scans/batch-approval` from passing as
 * `/scans/:id`. Every entry is a read a plain member can already make, so a key
 * never grants more than its creator's membership; adding a write is a security
 * decision (docs/api-keys.md).
 */
export const API_KEY_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/v1/api-keys/current",
  "GET /api/v1/openapi.json",
  "GET /api/v1/scans",
  "GET /api/v1/scans/overview",
  "GET /api/v1/scans/:id",
  "GET /api/v1/scans/:id/status",
  "GET /api/v1/scans/:id/report.json",
  "GET /api/v1/scans/:id/release-receipt.json",
  "GET /api/v1/packages/:name{.+}/releases",
  "GET /api/v1/github-app/workflow-gates/by-scan/:scanId",
]);

export function apiKeyMayReach(route: { method: string; path: string } | null): boolean {
  return route !== null && API_KEY_ROUTES.has(`${route.method} ${route.path}`);
}

/**
 * `lastUsedAt` is a settings hint, not an access log: a script polling a scan
 * would otherwise write the row on every request. One write per window keeps
 * the surfaced time accurate to within it.
 */
export const API_KEY_USE_DEBOUNCE_MS = 5 * 60_000;

export function apiKeyUseIsStale(lastUsedAt: Date | null, nowMs: number = Date.now()): boolean {
  // A future timestamp (clock skew between colos) still counts as recent.
  return lastUsedAt === null || nowMs - lastUsedAt.getTime() >= API_KEY_USE_DEBOUNCE_MS;
}

export function apiKeyExpired(expiresAt: Date, nowMs: number = Date.now()): boolean {
  return expiresAt.getTime() <= nowMs;
}

export function parseApiKeyName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > API_KEY_NAME_MAX_LENGTH) return null;
  // Printable text only: the name is echoed in settings and the audit log.
  return /^[^\p{Cc}\p{Cf}]+$/u.test(name) ? name : null;
}

const DEFAULT_API_KEY_EXPIRY_DAYS: ApiKeyExpiryDays = 90;

/** Every key expires; an omitted choice takes the default, an unknown one is null. */
export function parseApiKeyExpiry(value: unknown): ApiKeyExpiryDays | null {
  if (value === undefined) return DEFAULT_API_KEY_EXPIRY_DAYS;
  return API_KEY_EXPIRY_DAYS.find((days) => days === value) ?? null;
}
