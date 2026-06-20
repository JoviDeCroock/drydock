import { base64UrlDecode, base64UrlEncode, hmacSha256, timingSafeEqual } from "../crypto-utils";
import { reliableFetch } from "../reliable-fetch";
import { GithubAppValidationError, type GithubAppConfig } from "./config";
import { githubUserHeaders, nextLink } from "./http";

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
    const response = await reliableFetch(url, {
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
