import { and, eq } from "drizzle-orm";
import type { AppDb } from "../db";
import { githubAppInstallations, githubReleaseTargets } from "../db/schema";

export interface GithubAppEnv {
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
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
  | "installation_not_authorized"
  | "repository_not_accessible"
  | "environment_unmapped"
  | "environment_mismatch"
  | "package_already_mapped"
  | "environment_already_mapped"
  | "unsupported_ecosystem"
  | "invalid_input";

// ── Config readers ───────────────────────────────────────────────────────────

export interface GithubAppConfig {
  appId: string;
  appSlug: string;
  clientId: string;
  clientSecret: string;
  privateKeyPem: string;
  webhookSecret: string;
  stateSecret: string;
}

export function readGithubAppConfig(env: GithubAppEnv): GithubAppConfig {
  const appId = env.GITHUB_APP_ID?.trim();
  const appSlug = env.GITHUB_APP_SLUG?.trim();
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY?.trim();
  const webhookSecret = env.GITHUB_APP_WEBHOOK_SECRET?.trim();
  const stateSecret = env.GITHUB_APP_STATE_SECRET?.trim() || env.BETTER_AUTH_SECRET;
  if (!appId) throw new GithubAppConfigError("GITHUB_APP_ID is required");
  if (!appSlug) throw new GithubAppConfigError("GITHUB_APP_SLUG is required");
  if (!clientId) throw new GithubAppConfigError("GITHUB_APP_CLIENT_ID is required");
  if (!clientSecret) throw new GithubAppConfigError("GITHUB_APP_CLIENT_SECRET is required");
  if (!privateKeyPem) throw new GithubAppConfigError("GITHUB_APP_PRIVATE_KEY is required");
  if (!webhookSecret) throw new GithubAppConfigError("GITHUB_APP_WEBHOOK_SECRET is required");
  if (!stateSecret || stateSecret.length < 32) {
    throw new GithubAppConfigError(
      "GITHUB_APP_STATE_SECRET (or BETTER_AUTH_SECRET fallback) must be at least 32 characters",
    );
  }
  return { appId, appSlug, clientId, clientSecret, privateKeyPem, webhookSecret, stateSecret };
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
  let provided: Uint8Array;
  try {
    provided = base64UrlDecode(signature);
  } catch {
    return null;
  }
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

// ── GitHub App user authorization ────────────────────────────────────────────

export async function exchangeGithubUserCode(
  config: GithubAppConfig,
  code: string,
): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "drydock-app",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GithubAppValidationError(
      "invalid_input",
      `GitHub OAuth code exchange failed (${response.status}): ${text.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (data.error || !data.access_token) {
    throw new GithubAppValidationError(
      "invalid_input",
      data.error_description || data.error || "GitHub OAuth code exchange did not return a token",
    );
  }
  return data.access_token;
}

export interface GithubUserInstallationRef {
  id: string;
  accountLogin: string;
  accountType: string;
}

export async function listUserAccessibleInstallations(
  userAccessToken: string,
): Promise<GithubUserInstallationRef[]> {
  const installations: GithubUserInstallationRef[] = [];
  let url = "https://api.github.com/user/installations?per_page=100";

  for (let page = 0; page < 10 && url; page += 1) {
    const response = await fetch(url, {
      headers: githubUserHeaders(userAccessToken),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new GithubAppValidationError(
        "invalid_input",
        `GitHub user installation lookup failed (${response.status}): ${text.slice(0, 200)}`,
      );
    }
    const data = (await response.json()) as {
      installations?: {
        id?: number | string;
        account?: { login?: string; type?: string } | null;
      }[];
    };
    for (const installation of data.installations ?? []) {
      const id =
        typeof installation.id === "number"
          ? String(installation.id)
          : typeof installation.id === "string"
            ? installation.id
            : "";
      if (!id) continue;
      installations.push({
        id,
        accountLogin:
          typeof installation.account?.login === "string" ? installation.account.login : "",
        accountType:
          typeof installation.account?.type === "string" ? installation.account.type : "",
      });
    }
    url = nextLink(response.headers.get("link"));
  }

  return installations;
}

export async function verifyUserCanAccessInstallation(
  config: GithubAppConfig,
  input: { code: string; installationId: string },
): Promise<void> {
  const userAccessToken = await exchangeGithubUserCode(config, input.code);
  const installations = await listUserAccessibleInstallations(userAccessToken);
  const authorized = installations.some((installation) => installation.id === input.installationId);
  if (!authorized) {
    throw new GithubAppValidationError(
      "installation_not_authorized",
      "GitHub user authorization does not include this installation",
    );
  }
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
  const repository = parseRepositoryFullName(fullName);
  if (!repository) {
    throw new GithubAppValidationError(
      "invalid_input",
      "repositoryFullName must be in owner/repo form",
    );
  }
  const token = await getInstallationAccessToken(config, installationId);
  const repositoryPath = `${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  const response = await fetch(`https://api.github.com/repos/${repositoryPath}`, {
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

export async function listInstallationRepositories(
  config: GithubAppConfig,
  installationId: string,
): Promise<GithubRepositoryRef[]> {
  const token = await getInstallationAccessToken(config, installationId);
  const repositories: GithubRepositoryRef[] = [];
  let url = "https://api.github.com/installation/repositories?per_page=100";

  for (let page = 0; page < 10 && url; page += 1) {
    const response = await fetch(url, { headers: githubInstallationHeaders(token) });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new GithubAppValidationError(
        "repository_not_accessible",
        `installation repositories lookup failed (${response.status}): ${text.slice(0, 200)}`,
      );
    }
    const data = (await response.json()) as {
      repositories?: {
        id?: number;
        full_name?: string;
        default_branch?: string;
      }[];
    };
    for (const repo of data.repositories ?? []) {
      if (typeof repo.id !== "number" || typeof repo.full_name !== "string") continue;
      repositories.push({
        id: repo.id,
        fullName: repo.full_name,
        defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : undefined,
      });
    }
    url = nextLink(response.headers.get("link"));
  }

  repositories.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return repositories;
}

export interface GithubEnvironmentRef {
  name: string;
}

export async function listRepositoryEnvironments(
  config: GithubAppConfig,
  installationId: string,
  fullName: string,
): Promise<GithubEnvironmentRef[]> {
  const repository = parseRepositoryFullName(fullName);
  if (!repository) {
    throw new GithubAppValidationError(
      "invalid_input",
      "repositoryFullName must be in owner/repo form",
    );
  }
  const token = await getInstallationAccessToken(config, installationId);
  const repositoryPath = `${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  const environments: GithubEnvironmentRef[] = [];
  let url = `https://api.github.com/repos/${repositoryPath}/environments?per_page=100`;

  for (let page = 0; page < 10 && url; page += 1) {
    const response = await fetch(url, { headers: githubInstallationHeaders(token) });
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
        `environments lookup for ${fullName} failed (${response.status}): ${text.slice(0, 200)}`,
      );
    }
    const data = (await response.json()) as {
      environments?: { name?: string }[];
    };
    for (const environment of data.environments ?? []) {
      if (typeof environment.name === "string" && environment.name) {
        environments.push({ name: environment.name });
      }
    }
    url = nextLink(response.headers.get("link"));
  }

  return environments;
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
  const packageName = normalizePackageName(input.ecosystem, input.packageName);
  const environment = normalizeGithubEnvironmentName(input.environment);
  const pypiTrustedPublisherEnvironment = normalizeGithubEnvironmentName(
    input.pypiTrustedPublisherEnvironment,
  );
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
      packageName,
      repositoryId: input.repositoryId,
      repositoryFullName: input.repositoryFullName,
      workflowFilename: input.workflowFilename?.trim() || null,
      environment,
      pypiTrustedPublisherEnvironment,
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if (isUniquePackageConflict(err)) {
      throw new GithubAppValidationError(
        "package_already_mapped",
        `a release target already exists for ${input.ecosystem}/${packageName} in this organization`,
      );
    }
    if (isUniqueEnvironmentConflict(err)) {
      throw new GithubAppValidationError(
        "environment_already_mapped",
        `a release target already exists for ${input.repositoryFullName} environment ${environment} in this organization`,
      );
    }
    throw err;
  }
  return {
    id,
    organizationId: input.organizationId,
    installationRowId: input.installationRowId,
    ecosystem: input.ecosystem,
    packageName,
    repositoryId: input.repositoryId,
    repositoryFullName: input.repositoryFullName,
    workflowFilename: input.workflowFilename?.trim() || null,
    environment,
    pypiTrustedPublisherEnvironment,
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
  const environment = normalizeGithubEnvironmentName(input.environment);
  if (!environment) return null;
  const rows = await db
    .select()
    .from(githubReleaseTargets)
    .where(
      and(
        eq(githubReleaseTargets.organizationId, installation.organizationId),
        eq(githubReleaseTargets.installationRowId, installation.id),
        eq(githubReleaseTargets.repositoryId, input.repositoryId),
        eq(githubReleaseTargets.environment, environment),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { installation, releaseTarget: readReleaseTargetRow(row) };
}

// ── Input validation ─────────────────────────────────────────────────────────

const PACKAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,213}$/;
const REPO_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;
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
    !parseRepositoryFullName(input.repositoryFullName)
  ) {
    throw new GithubAppValidationError(
      "invalid_input",
      "repositoryFullName must be in owner/repo form",
    );
  }
  const environment = normalizeGithubEnvironmentName(input.environment);
  const pypiTrustedPublisherEnvironment = normalizeGithubEnvironmentName(
    input.pypiTrustedPublisherEnvironment,
  );
  if (!environment || environment.length > ENVIRONMENT_MAX) {
    throw new GithubAppValidationError("environment_unmapped", "environment is required");
  }
  if (!ENVIRONMENT_RE.test(environment)) {
    throw new GithubAppValidationError("invalid_input", "environment has invalid characters");
  }
  if (
    !pypiTrustedPublisherEnvironment ||
    pypiTrustedPublisherEnvironment.length > ENVIRONMENT_MAX
  ) {
    throw new GithubAppValidationError(
      "environment_unmapped",
      "pypiTrustedPublisherEnvironment is required",
    );
  }
  if (!ENVIRONMENT_RE.test(pypiTrustedPublisherEnvironment)) {
    throw new GithubAppValidationError(
      "invalid_input",
      "pypiTrustedPublisherEnvironment has invalid characters",
    );
  }
  if (environment !== pypiTrustedPublisherEnvironment) {
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
  return isUniqueConflict(
    err,
    "github_release_targets_org_pkg_unique_idx",
    "github_release_targets.package_name",
  );
}

function isUniqueEnvironmentConflict(err: unknown): boolean {
  return isUniqueConflict(
    err,
    "github_release_targets_org_repo_env_unique_idx",
    "github_release_targets.environment",
  );
}

function isUniqueConflict(err: unknown, indexName: string, columnName: string): boolean {
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
    combined.includes(indexName) ||
    (combined.includes("github_release_targets.organization_id") && combined.includes(columnName))
  );
}

function normalizeInstallationStatus(value: string): InstallationStatus {
  if (value === "suspended" || value === "uninstalled" || value === "active") return value;
  return "active";
}

function normalizePackageName(ecosystem: SupportedEcosystem, packageName: string): string {
  if (ecosystem === "pypi") return packageName.toLowerCase().replace(/[-_.]+/g, "-");
  return packageName;
}

function normalizeGithubEnvironmentName(environment: string): string {
  return environment.trim().toLowerCase();
}

function parseRepositoryFullName(fullName: string): { owner: string; name: string } | null {
  if (!fullName || fullName.length > REPO_FULL_NAME_MAX) return null;
  const parts = fullName.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!owner || !name || owner === "." || owner === ".." || name === "." || name === "..") {
    return null;
  }
  if (!REPO_OWNER_RE.test(owner) || !REPO_NAME_RE.test(name)) return null;
  return { owner, name };
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

function githubUserHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "drydock-app",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function nextLink(linkHeader: string | null): string {
  if (!linkHeader) return "";
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match?.[1]) return match[1];
  }
  return "";
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
