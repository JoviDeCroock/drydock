import { API_KEY_ACCESS_LEVELS, type ApiKeyAccess } from "../../db/enums";
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
  access: ApiKeyAccess;
  /**
   * The key's creator, still a member of `organizationId` (the lookup joins the
   * membership). A review a `scan` key starts is owned by this user, the way a
   * cron-discovered review is owned by whoever connected npm.
   */
  userId: string;
  name: string;
  prefix: string;
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
 * The API key a request presents, or null when it presents none. An
 * Authorization value that mentions a `ddk_` key selects key authentication,
 * and anything but exactly `Bearer ddk_…` then fails as a malformed key (the
 * empty string): a request that presents a key is never authenticated by its
 * cookie. Other Authorization values (for example HTTP basic auth in front of
 * a self-hosted staging deploy) are left alone and keep the cookie path.
 */
export function readApiKeyCredential(authorization: string | undefined): string | null {
  if (!authorization?.includes(API_KEY_TOKEN_PREFIX)) return null;
  const match = /^Bearer[ \t]+(ddk_\S+)[ \t]*$/i.exec(authorization);
  return match ? match[1] : "";
}

/**
 * The endpoints every API key reaches, as `METHOD path` exactly as Hono
 * registers the route that answers the request. Matching the answering route
 * rather than the URL keeps `/scans/batch-approval` from passing as
 * `/scans/:id`. Every entry is a read a plain member can already make, so a key
 * never grants more than its creator's membership; adding a route is a security
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

/**
 * The writes a `scan` key adds: starting one review, and "Check npm" discovery.
 * Both are actions any member can take and neither decides a release; they
 * spend the organization's existing per-organization scan and discovery
 * budgets. Recording a decision, sharing, and settings stay session-only.
 */
export const API_KEY_SCAN_ROUTES: ReadonlySet<string> = new Set([
  "POST /api/v1/scans",
  "POST /api/v1/staged-publishes/scan",
]);

export type ApiKeyRouteVerdict = "allowed" | "endpoint_not_allowed" | "access_insufficient";

export function apiKeyMayReach(
  route: { method: string; path: string } | null,
  access: ApiKeyAccess,
): ApiKeyRouteVerdict {
  if (route === null) return "endpoint_not_allowed";
  const signature = `${route.method} ${route.path}`;
  if (API_KEY_ROUTES.has(signature)) return "allowed";
  if (!API_KEY_SCAN_ROUTES.has(signature)) return "endpoint_not_allowed";
  return access === "scan" ? "allowed" : "access_insufficient";
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

/** An omitted choice is a read-only key; an unknown one is null. */
export function parseApiKeyAccess(value: unknown): ApiKeyAccess | null {
  if (value === undefined) return "read";
  return API_KEY_ACCESS_LEVELS.find((access) => access === value) ?? null;
}

const DEFAULT_API_KEY_EXPIRY_DAYS: ApiKeyExpiryDays = 90;

/** Every key expires; an omitted choice takes the default, an unknown one is null. */
export function parseApiKeyExpiry(value: unknown): ApiKeyExpiryDays | null {
  if (value === undefined) return DEFAULT_API_KEY_EXPIRY_DAYS;
  return API_KEY_EXPIRY_DAYS.find((days) => days === value) ?? null;
}
