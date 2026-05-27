import { and, eq } from "drizzle-orm";
import type { AppDb } from "../db";
import { githubAppInstallations, githubReleaseTargets } from "../db/schema";

export interface GithubAppEnv {
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  GITHUB_APP_STATE_SECRET?: string;
  BETTER_AUTH_SECRET: string;
}

export const SUPPORTED_ECOSYSTEMS = ["pypi"] as const;
export type SupportedEcosystem = (typeof SUPPORTED_ECOSYSTEMS)[number];

export const INSTALLATION_STATUSES = ["active", "suspended", "uninstalled"] as const;
export type InstallationStatus = (typeof INSTALLATION_STATUSES)[number];

// GitHub places a 64KB limit on installation_target/account_login; we cap shorter to
// keep state/state-payloads bounded.
const ACCOUNT_LOGIN_MAX = 100;
const PACKAGE_NAME_MAX = 214;
const REPO_FULL_NAME_MAX = 140;
const WORKFLOW_FILENAME_MAX = 200;
const ENVIRONMENT_MAX = 80;

// ── Errors ───────────────────────────────────────────────────────────────────

export class GithubAppConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubAppConfigError";
  }
}

export class GithubAppValidationError extends Error {
  constructor(
    public code: GithubAppValidationCode,
    message: string,
  ) {
    super(message);
    this.name = "GithubAppValidationError";
  }
}

export type GithubAppValidationCode =
  | "installation_missing"
  | "installation_inactive"
  | "repository_not_accessible"
  | "environment_unmapped"
  | "environment_mismatch"
  | "package_already_mapped"
  | "unsupported_ecosystem"
  | "invalid_input";

// ── Config readers ───────────────────────────────────────────────────────────

export interface GithubAppConfig {
  appId: string;
  appSlug: string;
  privateKeyPem: string;
  webhookSecret: string;
  stateSecret: string;
}

export function readGithubAppConfig(env: GithubAppEnv): GithubAppConfig {
  const appId = env.GITHUB_APP_ID?.trim();
  const appSlug = env.GITHUB_APP_SLUG?.trim();
  const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY?.trim();
  const webhookSecret = env.GITHUB_APP_WEBHOOK_SECRET?.trim();
  const stateSecret = env.GITHUB_APP_STATE_SECRET?.trim() || env.BETTER_AUTH_SECRET;
  if (!appId) throw new GithubAppConfigError("GITHUB_APP_ID is required");
  if (!appSlug) throw new GithubAppConfigError("GITHUB_APP_SLUG is required");
  if (!privateKeyPem) throw new GithubAppConfigError("GITHUB_APP_PRIVATE_KEY is required");
  if (!webhookSecret) throw new GithubAppConfigError("GITHUB_APP_WEBHOOK_SECRET is required");
  if (!stateSecret || stateSecret.length < 32) {
    throw new GithubAppConfigError(
      "GITHUB_APP_STATE_SECRET (or BETTER_AUTH_SECRET fallback) must be at least 32 characters",
    );
  }
  return { appId, appSlug, privateKeyPem, webhookSecret, stateSecret };
}

export function isGithubAppConfigured(env: GithubAppEnv): boolean {
  try {
    readGithubAppConfig(env);
    return true;
  } catch {
    return false;
  }
}

// ── HMAC-signed OAuth state token ────────────────────────────────────────────

export interface OAuthStateClaims {
  organizationId: string;
  userId: string;
  nonce: string;
  expiresAt: number;
}

const STATE_TTL_MS = 15 * 60 * 1000;
const STATE_VERSION = "v1";

export async function signOAuthState(
  secret: string,
  claims: Omit<OAuthStateClaims, "nonce" | "expiresAt">,
): Promise<string> {
  const payload: OAuthStateClaims = {
    organizationId: claims.organizationId,
    userId: claims.userId,
    nonce: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
    expiresAt: Date.now() + STATE_TTL_MS,
  };
  const body = `${STATE_VERSION}.${base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))}`;
  const signature = await hmacSha256(secret, body);
  return `${body}.${base64UrlEncode(signature)}`;
}

export async function verifyOAuthState(
  secret: string,
  token: string,
): Promise<OAuthStateClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [version, payload, signature] = parts;
  if (version !== STATE_VERSION) return null;
  const expected = await hmacSha256(secret, `${version}.${payload}`);
  const provided = base64UrlDecode(signature);
  if (!timingSafeEqual(expected, provided)) return null;
  let claims: OAuthStateClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== "object") return null;
  if (typeof claims.organizationId !== "string" || !claims.organizationId) return null;
  if (typeof claims.userId !== "string" || !claims.userId) return null;
  if (typeof claims.nonce !== "string" || !claims.nonce) return null;
  if (typeof claims.expiresAt !== "number" || !Number.isFinite(claims.expiresAt)) return null;
  if (claims.expiresAt < Date.now()) return null;
  return claims;
}

export function buildInstallUrl(config: GithubAppConfig, state: string): string {
  return `https://github.com/apps/${encodeURIComponent(config.appSlug)}/installations/new?state=${encodeURIComponent(state)}`;
}

// ── GitHub App JWT + installation access token ───────────────────────────────

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

export interface GithubInstallationMetadata {
  installationId: string;
  accountLogin: string;
  accountType: "User" | "Organization";
  targetType: string;
  suspended: boolean;
}

export async function fetchInstallationMetadata(
  config: GithubAppConfig,
  installationId: string,
): Promise<GithubInstallationMetadata> {
  const jwt = await generateGithubAppJwt(config);
  const response = await fetch(`https://api.github.com/app/installations/${installationId}`, {
    headers: githubAppHeaders(jwt),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GithubAppValidationError(
      "installation_missing",
      `GitHub installation ${installationId} could not be fetched (${response.status}): ${text.slice(0, 200)}`,
    );
  }
  const data = (await response.json()) as {
    id?: number | string;
    account?: { login?: string; type?: string } | null;
    target_type?: string;
    suspended_at?: string | null;
  };
  const idValue =
    typeof data.id === "number" ? String(data.id) : typeof data.id === "string" ? data.id : null;
  if (!idValue)
    throw new GithubAppValidationError("installation_missing", "missing installation id");
  const login = typeof data.account?.login === "string" ? data.account.login : "";
  const accountType =
    data.account?.type === "Organization" || data.account?.type === "User"
      ? data.account.type
      : "Organization";
  return {
    installationId: idValue,
    accountLogin: login,
    accountType,
    targetType: typeof data.target_type === "string" ? data.target_type : accountType,
    suspended: Boolean(data.suspended_at),
  };
}

export async function getInstallationAccessToken(
  config: GithubAppConfig,
  installationId: string,
): Promise<string> {
  const jwt = await generateGithubAppJwt(config);
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: githubAppHeaders(jwt),
    },
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GithubAppValidationError(
      "installation_inactive",
      `installation access token request failed (${response.status}): ${text.slice(0, 200)}`,
    );
  }
  const data = (await response.json()) as { token?: string };
  if (!data.token) {
    throw new GithubAppValidationError(
      "installation_inactive",
      "installation access token response missing token",
    );
  }
  return data.token;
}

export interface GithubRepositoryRef {
  id: number;
  fullName: string;
  defaultBranch?: string;
}

export async function fetchRepository(
  config: GithubAppConfig,
  installationId: string,
  fullName: string,
): Promise<GithubRepositoryRef> {
  const token = await getInstallationAccessToken(config, installationId);
  const response = await fetch(`https://api.github.com/repos/${fullName}`, {
    headers: githubInstallationHeaders(token),
  });
  if (response.status === 404) {
    throw new GithubAppValidationError(
      "repository_not_accessible",
      `repository ${fullName} is not accessible to installation ${installationId}`,
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GithubAppValidationError(
      "repository_not_accessible",
      `repository ${fullName} lookup failed (${response.status}): ${text.slice(0, 200)}`,
    );
  }
  const data = (await response.json()) as {
    id?: number;
    full_name?: string;
    default_branch?: string;
  };
  if (typeof data.id !== "number" || typeof data.full_name !== "string") {
    throw new GithubAppValidationError(
      "repository_not_accessible",
      "repository response missing id or full_name",
    );
  }
  return { id: data.id, fullName: data.full_name, defaultBranch: data.default_branch };
}

// ── DB-backed service ────────────────────────────────────────────────────────

export interface InstallationRecord {
  id: string;
  organizationId: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  targetType: string;
  status: InstallationStatus;
  installedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReleaseTargetRecord {
  id: string;
  organizationId: string;
  installationRowId: string;
  ecosystem: SupportedEcosystem;
  packageName: string;
  repositoryId: number;
  repositoryFullName: string;
  workflowFilename: string | null;
  environment: string;
  pypiTrustedPublisherEnvironment: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertInstallationInput {
  organizationId: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  targetType: string;
  status: InstallationStatus;
  createdByUserId: string | null;
}

export async function upsertInstallation(
  db: AppDb,
  input: UpsertInstallationInput,
): Promise<InstallationRecord> {
  const now = new Date();
  const accountLogin = input.accountLogin.slice(0, ACCOUNT_LOGIN_MAX);
  const [existing] = await db
    .select()
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.installationId, input.installationId))
    .limit(1);

  if (existing) {
    if (existing.organizationId !== input.organizationId) {
      throw new GithubAppValidationError(
        "installation_missing",
        `installation ${input.installationId} is already linked to a different organization`,
      );
    }
    await db
      .update(githubAppInstallations)
      .set({
        accountLogin,
        accountType: input.accountType,
        targetType: input.targetType,
        status: input.status,
        suspendedAt: input.status === "suspended" ? now : null,
        uninstalledAt: input.status === "uninstalled" ? now : null,
        updatedAt: now,
      })
      .where(eq(githubAppInstallations.id, existing.id));
    return readInstallationRow({
      ...existing,
      accountLogin,
      accountType: input.accountType,
      targetType: input.targetType,
      status: input.status,
      updatedAt: now,
    });
  }

  const id = crypto.randomUUID();
  await db.insert(githubAppInstallations).values({
    id,
    organizationId: input.organizationId,
    installationId: input.installationId,
    accountLogin,
    accountType: input.accountType,
    targetType: input.targetType,
    status: input.status,
    createdByUserId: input.createdByUserId,
    installedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return {
    id,
    organizationId: input.organizationId,
    installationId: input.installationId,
    accountLogin,
    accountType: input.accountType,
    targetType: input.targetType,
    status: input.status,
    installedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

export async function listInstallationsForOrganization(
  db: AppDb,
  organizationId: string,
): Promise<InstallationRecord[]> {
  const rows = await db
    .select()
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.organizationId, organizationId));
  return rows.map(readInstallationRow);
}

export async function getInstallationByExternalId(
  db: AppDb,
  installationId: string,
): Promise<InstallationRecord | null> {
  const [row] = await db
    .select()
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.installationId, installationId))
    .limit(1);
  return row ? readInstallationRow(row) : null;
}

export async function getInstallationForOrganization(
  db: AppDb,
  organizationId: string,
  installationRowId: string,
): Promise<InstallationRecord | null> {
  const [row] = await db
    .select()
    .from(githubAppInstallations)
    .where(
      and(
        eq(githubAppInstallations.id, installationRowId),
        eq(githubAppInstallations.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row ? readInstallationRow(row) : null;
}

export async function markInstallationStatus(
  db: AppDb,
  installationId: string,
  status: InstallationStatus,
): Promise<void> {
  const now = new Date();
  await db
    .update(githubAppInstallations)
    .set({
      status,
      suspendedAt: status === "suspended" ? now : null,
      uninstalledAt: status === "uninstalled" ? now : null,
      updatedAt: now,
    })
    .where(eq(githubAppInstallations.installationId, installationId));
}

export interface CreateReleaseTargetInput {
  organizationId: string;
  installationRowId: string;
  ecosystem: SupportedEcosystem;
  packageName: string;
  repositoryId: number;
  repositoryFullName: string;
  workflowFilename?: string | null;
  environment: string;
  pypiTrustedPublisherEnvironment: string;
  createdByUserId: string | null;
}

export async function createReleaseTarget(
  db: AppDb,
  input: CreateReleaseTargetInput,
): Promise<ReleaseTargetRecord> {
  validateReleaseTargetShape(input);
  const installation = await getInstallationForOrganization(
    db,
    input.organizationId,
    input.installationRowId,
  );
  if (!installation) {
    throw new GithubAppValidationError(
      "installation_missing",
      "no GitHub App installation matches this organization",
    );
  }
  if (installation.status !== "active") {
    throw new GithubAppValidationError(
      "installation_inactive",
      `installation ${installation.installationId} is ${installation.status}`,
    );
  }

  const id = crypto.randomUUID();
  const now = new Date();
  try {
    await db.insert(githubReleaseTargets).values({
      id,
      organizationId: input.organizationId,
      installationRowId: input.installationRowId,
      ecosystem: input.ecosystem,
      packageName: input.packageName,
      repositoryId: input.repositoryId,
      repositoryFullName: input.repositoryFullName,
      workflowFilename: input.workflowFilename?.trim() || null,
      environment: input.environment,
      pypiTrustedPublisherEnvironment: input.pypiTrustedPublisherEnvironment,
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if (isUniquePackageConflict(err)) {
      throw new GithubAppValidationError(
        "package_already_mapped",
        `a release target already exists for ${input.ecosystem}/${input.packageName} in this organization`,
      );
    }
    throw err;
  }
  return {
    id,
    organizationId: input.organizationId,
    installationRowId: input.installationRowId,
    ecosystem: input.ecosystem,
    packageName: input.packageName,
    repositoryId: input.repositoryId,
    repositoryFullName: input.repositoryFullName,
    workflowFilename: input.workflowFilename?.trim() || null,
    environment: input.environment,
    pypiTrustedPublisherEnvironment: input.pypiTrustedPublisherEnvironment,
    createdAt: now,
    updatedAt: now,
  };
}

export async function listReleaseTargetsForOrganization(
  db: AppDb,
  organizationId: string,
): Promise<ReleaseTargetRecord[]> {
  const rows = await db
    .select()
    .from(githubReleaseTargets)
    .where(eq(githubReleaseTargets.organizationId, organizationId));
  return rows.map(readReleaseTargetRow);
}

export async function deleteReleaseTarget(
  db: AppDb,
  organizationId: string,
  id: string,
): Promise<boolean> {
  const result = await db
    .delete(githubReleaseTargets)
    .where(
      and(eq(githubReleaseTargets.id, id), eq(githubReleaseTargets.organizationId, organizationId)),
    )
    .returning({ id: githubReleaseTargets.id });
  return result.length > 0;
}

// ── Webhook resolution ───────────────────────────────────────────────────────

export interface ResolveDeploymentProtectionInput {
  installationId: string;
  repositoryId: number;
  environment: string;
}

export interface ResolvedDeploymentProtectionTarget {
  installation: InstallationRecord;
  releaseTarget: ReleaseTargetRecord;
}

/**
 * Given a `deployment_protection_rule` webhook payload, find the organization +
 * release-target it belongs to. Returns null when no mapping exists — the caller
 * decides whether that's a soft-fail (ignore unknown installs) or an error.
 */
export async function resolveDeploymentProtectionTarget(
  db: AppDb,
  input: ResolveDeploymentProtectionInput,
): Promise<ResolvedDeploymentProtectionTarget | null> {
  const installation = await getInstallationByExternalId(db, input.installationId);
  if (!installation) return null;
  if (installation.status !== "active") return null;
  const rows = await db
    .select()
    .from(githubReleaseTargets)
    .where(
      and(
        eq(githubReleaseTargets.organizationId, installation.organizationId),
        eq(githubReleaseTargets.repositoryId, input.repositoryId),
        eq(githubReleaseTargets.environment, input.environment),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { installation, releaseTarget: readReleaseTargetRow(row) };
}

// ── Input validation ─────────────────────────────────────────────────────────

const PACKAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,213}$/;
const REPO_FULL_NAME_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const ENVIRONMENT_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;
const WORKFLOW_FILENAME_RE = /^[A-Za-z0-9._-]+\.ya?ml$/;

export function validateReleaseTargetShape(input: CreateReleaseTargetInput) {
  if (!SUPPORTED_ECOSYSTEMS.includes(input.ecosystem)) {
    throw new GithubAppValidationError(
      "unsupported_ecosystem",
      `unsupported ecosystem: ${input.ecosystem}`,
    );
  }
  if (!input.packageName || input.packageName.length > PACKAGE_NAME_MAX) {
    throw new GithubAppValidationError("invalid_input", "packageName is required");
  }
  if (!PACKAGE_NAME_RE.test(input.packageName)) {
    throw new GithubAppValidationError("invalid_input", "packageName has invalid characters");
  }
  if (!Number.isInteger(input.repositoryId) || input.repositoryId <= 0) {
    throw new GithubAppValidationError("invalid_input", "repositoryId must be a positive integer");
  }
  if (
    !input.repositoryFullName ||
    input.repositoryFullName.length > REPO_FULL_NAME_MAX ||
    !REPO_FULL_NAME_RE.test(input.repositoryFullName)
  ) {
    throw new GithubAppValidationError(
      "invalid_input",
      "repositoryFullName must be in owner/repo form",
    );
  }
  if (!input.environment || input.environment.length > ENVIRONMENT_MAX) {
    throw new GithubAppValidationError("environment_unmapped", "environment is required");
  }
  if (!ENVIRONMENT_RE.test(input.environment)) {
    throw new GithubAppValidationError("invalid_input", "environment has invalid characters");
  }
  if (
    !input.pypiTrustedPublisherEnvironment ||
    input.pypiTrustedPublisherEnvironment.length > ENVIRONMENT_MAX
  ) {
    throw new GithubAppValidationError(
      "environment_unmapped",
      "pypiTrustedPublisherEnvironment is required",
    );
  }
  if (input.environment !== input.pypiTrustedPublisherEnvironment) {
    throw new GithubAppValidationError(
      "environment_mismatch",
      "environment must match the PyPI Trusted Publisher environment so the gate runs against the same job",
    );
  }
  if (input.workflowFilename) {
    if (input.workflowFilename.length > WORKFLOW_FILENAME_MAX) {
      throw new GithubAppValidationError("invalid_input", "workflowFilename is too long");
    }
    if (!WORKFLOW_FILENAME_RE.test(input.workflowFilename)) {
      throw new GithubAppValidationError(
        "invalid_input",
        "workflowFilename must look like 'release.yml'",
      );
    }
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function readInstallationRow(row: {
  id: string;
  organizationId: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  targetType: string;
  status: string;
  installedAt: Date | string | number;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
}): InstallationRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    installationId: row.installationId,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    targetType: row.targetType,
    status: normalizeInstallationStatus(row.status),
    installedAt: new Date(row.installedAt),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function readReleaseTargetRow(row: {
  id: string;
  organizationId: string;
  installationRowId: string;
  ecosystem: string;
  packageName: string;
  repositoryId: number;
  repositoryFullName: string;
  workflowFilename: string | null;
  environment: string;
  pypiTrustedPublisherEnvironment: string;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
}): ReleaseTargetRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    installationRowId: row.installationRowId,
    ecosystem: row.ecosystem as SupportedEcosystem,
    packageName: row.packageName,
    repositoryId: row.repositoryId,
    repositoryFullName: row.repositoryFullName,
    workflowFilename: row.workflowFilename,
    environment: row.environment,
    pypiTrustedPublisherEnvironment: row.pypiTrustedPublisherEnvironment,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function isUniquePackageConflict(err: unknown): boolean {
  const messages: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error) {
      messages.push(current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      messages.push(String(current));
      current = null;
    }
  }
  const combined = messages.join(" | ");
  if (!/UNIQUE/i.test(combined)) return false;
  return (
    combined.includes("github_release_targets_org_pkg_unique_idx") ||
    (combined.includes("github_release_targets.organization_id") &&
      combined.includes("github_release_targets.package_name"))
  );
}

function normalizeInstallationStatus(value: string): InstallationStatus {
  if (value === "suspended" || value === "uninstalled" || value === "active") return value;
  return "active";
}

function githubAppHeaders(jwt: string) {
  return {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "drydock-app",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function githubInstallationHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "drydock-app",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.replace(/\\n/g, "\n");
  let base64 = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  base64 = base64.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = base64.length % 4;
  if (remainder === 2) base64 += "==";
  else if (remainder === 3) base64 += "=";
  const binary = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    binary,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(signature);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlString(str: string): string {
  return base64UrlEncode(new TextEncoder().encode(str));
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
