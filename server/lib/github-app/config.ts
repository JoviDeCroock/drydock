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

// Ecosystems a release target may pin. Mirrors the registry's `gate`
// capability; kept as a literal here because this module is the request-shape
// boundary and must not import the adapters it validates against.
export const SUPPORTED_ECOSYSTEMS = ["pypi", "npm", "vscode", "atpm"] as const;
export type SupportedEcosystem = (typeof SUPPORTED_ECOSYSTEMS)[number];

/**
 * Ecosystems whose gate reads its release candidate from a publishing account
 * rather than from the workflow's uploads, and which therefore require
 * `publisher_ref` on a release target. atpm is the case: `npm stage publish`
 * writes the candidate into the publisher's own AT Protocol repository.
 *
 * A literal for the same reason `SUPPORTED_ECOSYSTEMS` is one — this module is
 * the request-shape boundary and sits underneath the GitHub API client that the
 * atpm gate adapter imports, so reading the registry from here would form a
 * cycle. `test/workers/atpm-gate.test.ts` pins both lists against the registry
 * so the two cannot drift apart silently.
 */
export const PUBLISHER_SOURCED_ECOSYSTEMS = ["atpm"] as const;

const INSTALLATION_STATUSES = ["active", "suspended", "uninstalled"] as const;
export type InstallationStatus = (typeof INSTALLATION_STATUSES)[number];

// GitHub places a 64KB limit on installation_target/account_login; we cap shorter to
// keep state/state-payloads bounded.
export const ACCOUNT_LOGIN_MAX = 100;
export const REPO_FULL_NAME_MAX = 140;
export const ENVIRONMENT_MAX = 255;

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
