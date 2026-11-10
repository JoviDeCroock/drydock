import {
  base64UrlDecode,
  base64UrlEncode,
  hmacSha256,
  timingSafeEqual,
} from "../platform/crypto-utils";
import { reliableFetch } from "../platform/reliable-fetch";
import { GithubAppValidationError, type GithubAppConfig } from "./config";
import { githubHeaders } from "./client";

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
  const response = await reliableFetch("https://github.com/login/oauth/access_token", {
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

export interface InstallationAccountRef {
  accountType: "Organization" | "User";
  accountLogin: string;
  accountId: number;
}

export interface VerifiedInstallationOwner {
  githubUserId: number;
  githubLogin: string;
}

/**
 * Proves the user behind `userAccessToken` administers the account the App is
 * installed on: an active org owner (`role: admin`), or the user account
 * itself. Seeing the installation in `GET /user/installations` is not enough;
 * GitHub lists it for anyone with access to one of its repositories.
 *
 * The org lookup is a user-to-server call, so GitHub requires the App's
 * Members (read) organization permission on that installation; without it the
 * lookup is refused and linking fails closed.
 */
export async function verifyUserOwnsInstallationAccount(
  userAccessToken: string,
  account: InstallationAccountRef,
): Promise<VerifiedInstallationOwner> {
  const notOwner = new GithubAppValidationError(
    "installation_owner_required",
    `you must be an owner of ${account.accountLogin} on GitHub to link this installation`,
  );
  const url =
    account.accountType === "Organization"
      ? `https://api.github.com/user/memberships/orgs/${encodeURIComponent(account.accountLogin)}`
      : "https://api.github.com/user";
  const response = await reliableFetch(url, { headers: githubHeaders(userAccessToken) });
  // 404 from the membership lookup means "not a member" (or a hidden one).
  if (response.status === 404 && account.accountType === "Organization") {
    await response.body?.cancel();
    throw notOwner;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new GithubAppValidationError(
      "installation_owner_unverified",
      account.accountType === "Organization"
        ? `GitHub did not confirm who owns ${account.accountLogin} (${response.status}); the Drydock GitHub App needs the Members (read) organization permission, and an organization with SAML single sign-on needs an authorized GitHub session`
        : `GitHub did not confirm who owns ${account.accountLogin} (${response.status})`,
    );
  }
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const user = account.accountType === "Organization" ? asRecord(data?.user) : asRecord(data);
  const githubUserId = user?.id;
  const githubLogin = user?.login;
  if (typeof githubUserId !== "number" || typeof githubLogin !== "string" || !githubLogin) {
    throw new GithubAppValidationError(
      "installation_owner_unverified",
      `GitHub returned an unexpected identity while checking who owns ${account.accountLogin}`,
    );
  }
  if (account.accountType === "User") {
    if (githubUserId !== account.accountId) throw notOwner;
    return { githubUserId, githubLogin };
  }
  const organization = asRecord(data?.organization);
  if (
    organization?.id !== account.accountId ||
    data?.state !== "active" ||
    data?.role !== "admin"
  ) {
    throw notOwner;
  }
  return { githubUserId, githubLogin };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
