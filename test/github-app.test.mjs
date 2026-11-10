import { afterEach, describe, expect, test, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { fetchRepository } from "../server/lib/github-app/api";
import {
  GithubAppConfigError,
  GithubAppValidationError,
  isGithubAppConfigured,
  readGithubAppConfig,
} from "../server/lib/github-app/config";
import { generateGithubAppJwt } from "../server/lib/github-app/jwt";
import {
  buildInstallUrl,
  exchangeGithubUserCode,
  signOAuthState,
  verifyOAuthState,
  verifyUserOwnsInstallationAccount,
} from "../server/lib/github-app/oauth";
import { validateReleaseTargetShape } from "../server/lib/github-app/validation";

const originalFetch = globalThis.fetch;

const VALID_ENV = {
  GITHUB_APP_ID: "12345",
  GITHUB_APP_SLUG: "drydock-test",
  GITHUB_APP_CLIENT_ID: "client-id",
  GITHUB_APP_CLIENT_SECRET: "client-secret",
  GITHUB_APP_PRIVATE_KEY: "----- placeholder -----",
  GITHUB_APP_WEBHOOK_SECRET: "webhook-secret-value-1234567890",
  GITHUB_APP_STATE_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_SECRET: "fallback-secret-with-enough-entropy-aaaaaaaa",
};

const VALID_RELEASE_TARGET = {
  organizationId: "org_1",
  installationRowId: "inst_1",
  ecosystem: "pypi",
  repositoryId: 42,
  repositoryFullName: "octo/example",
  environment: "pypi-release",
  createdByUserId: null,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("github app config", () => {
  test("isGithubAppConfigured is true only when every env var is present", () => {
    expect(isGithubAppConfigured(VALID_ENV)).toBe(true);
    expect(isGithubAppConfigured({ ...VALID_ENV, GITHUB_APP_ID: "" })).toBe(false);
    expect(isGithubAppConfigured({ ...VALID_ENV, GITHUB_APP_SLUG: undefined })).toBe(false);
    expect(isGithubAppConfigured({ ...VALID_ENV, GITHUB_APP_CLIENT_ID: undefined })).toBe(false);
    expect(isGithubAppConfigured({ ...VALID_ENV, GITHUB_APP_CLIENT_SECRET: undefined })).toBe(
      false,
    );
    expect(isGithubAppConfigured({ ...VALID_ENV, GITHUB_APP_PRIVATE_KEY: undefined })).toBe(false);
    expect(isGithubAppConfigured({ ...VALID_ENV, GITHUB_APP_WEBHOOK_SECRET: undefined })).toBe(
      false,
    );
  });

  test("readGithubAppConfig falls back to BETTER_AUTH_SECRET for state signing", () => {
    const config = readGithubAppConfig({
      ...VALID_ENV,
      GITHUB_APP_STATE_SECRET: undefined,
    });
    expect(config.stateSecret).toBe(VALID_ENV.BETTER_AUTH_SECRET);
  });

  test("readGithubAppConfig refuses short state secrets", () => {
    expect(() =>
      readGithubAppConfig({
        ...VALID_ENV,
        GITHUB_APP_STATE_SECRET: "short",
        BETTER_AUTH_SECRET: "short",
      }),
    ).toThrow(GithubAppConfigError);
  });

  test("buildInstallUrl encodes the slug and state", () => {
    const config = readGithubAppConfig(VALID_ENV);
    const url = buildInstallUrl(config, "state value with spaces");
    expect(url).toBe(
      "https://github.com/apps/drydock-test/installations/new?state=state%20value%20with%20spaces",
    );
  });

  test("generateGithubAppJwt accepts GitHub App PKCS#1 private keys", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" });
    const config = readGithubAppConfig({ ...VALID_ENV, GITHUB_APP_PRIVATE_KEY: privateKeyPem });
    const jwt = await generateGithubAppJwt(config);
    expect(jwt.split(".")).toHaveLength(3);
  });
});

describe("github user authorization", () => {
  test("exchanges the callback code with the GitHub App client credentials", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      expect(init.method).toBe("POST");
      expect(init.body.toString()).toContain("client_id=client-id");
      expect(init.body.toString()).toContain("client_secret=client-secret");
      expect(init.body.toString()).toContain("code=callback-code");
      return Response.json({ access_token: "user-token" });
    });
    globalThis.fetch = fetchMock;

    await expect(
      exchangeGithubUserCode(readGithubAppConfig(VALID_ENV), "callback-code"),
    ).resolves.toBe("user-token");
  });
});

describe("installation account ownership", () => {
  const ORG = { accountType: "Organization", accountLogin: "acme", accountId: 77 };
  const USER = { accountType: "User", accountLogin: "octocat", accountId: 9 };

  function membership(overrides = {}) {
    return {
      state: "active",
      role: "admin",
      organization: { id: 77, login: "acme" },
      user: { id: 5, login: "owner" },
      ...overrides,
    };
  }

  function respondWith(response) {
    const fetchMock = vi.fn(async () => response);
    globalThis.fetch = fetchMock;
    return fetchMock;
  }

  test("asks GitHub for the token holder's own membership in the installation's organization", async () => {
    const fetchMock = respondWith(Response.json(membership()));

    await expect(verifyUserOwnsInstallationAccount("user-token", ORG)).resolves.toEqual({
      githubUserId: 5,
      githubLogin: "owner",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.github.com/user/memberships/orgs/acme");
    expect(init.headers.Authorization).toBe("Bearer user-token");
    expect(init.method ?? "GET").toBe("GET");
  });

  test.each([
    ["a plain member", { role: "member" }],
    ["a billing manager", { role: "billing_manager" }],
    ["an admin whose invitation is pending", { state: "pending" }],
    ["an admin of a different organization", { organization: { id: 78, login: "acme" } }],
    ["a response without the organization", { organization: undefined }],
  ])("refuses %s", async (_label, overrides) => {
    respondWith(Response.json(membership(overrides)));

    await expect(verifyUserOwnsInstallationAccount("user-token", ORG)).rejects.toMatchObject({
      code: "installation_owner_required",
      message: "you must be an owner of acme on GitHub to link this installation",
    });
  });

  test("refuses users GitHub reports are not members, such as outside collaborators", async () => {
    respondWith(new Response('{"message":"Not Found"}', { status: 404 }));

    await expect(verifyUserOwnsInstallationAccount("user-token", ORG)).rejects.toMatchObject({
      code: "installation_owner_required",
    });
  });

  test.each([403, 401, 422])(
    "fails closed without echoing GitHub's body when the lookup returns %i",
    async (status) => {
      respondWith(new Response('{"message":"raw GitHub detail"}', { status }));

      const error = await verifyUserOwnsInstallationAccount("user-token", ORG).catch((err) => err);
      expect(error).toBeInstanceOf(GithubAppValidationError);
      expect(error.code).toBe("installation_owner_unverified");
      expect(error.message).toContain("Members (read)");
      expect(error.message).not.toContain("raw GitHub detail");
    },
  );

  test("fails closed on a membership without a user identity", async () => {
    respondWith(Response.json(membership({ user: null })));

    await expect(verifyUserOwnsInstallationAccount("user-token", ORG)).rejects.toMatchObject({
      code: "installation_owner_unverified",
    });
  });

  test("accepts the user account's own GitHub user, compared by id", async () => {
    const fetchMock = respondWith(Response.json({ id: 9, login: "octocat" }));

    await expect(verifyUserOwnsInstallationAccount("user-token", USER)).resolves.toEqual({
      githubUserId: 9,
      githubLogin: "octocat",
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.github.com/user");
  });

  test("refuses another GitHub user even when the login matches", async () => {
    respondWith(Response.json({ id: 10, login: "octocat" }));

    await expect(verifyUserOwnsInstallationAccount("user-token", USER)).rejects.toMatchObject({
      code: "installation_owner_required",
    });
  });

  test("fails closed when GitHub does not return the user", async () => {
    respondWith(new Response("", { status: 404 }));

    await expect(verifyUserOwnsInstallationAccount("user-token", USER)).rejects.toMatchObject({
      code: "installation_owner_unverified",
    });
  });
});

describe("oauth state token", () => {
  const SECRET = "test-state-secret-with-enough-entropy-aaaa";

  test("round-trips claims", async () => {
    const token = await signOAuthState(SECRET, { organizationId: "org_1", userId: "user_1" });
    const claims = await verifyOAuthState(SECRET, token);
    expect(claims).not.toBeNull();
    expect(claims?.organizationId).toBe("org_1");
    expect(claims?.userId).toBe("user_1");
    expect(typeof claims?.nonce).toBe("string");
    expect(claims?.expiresAt).toBeGreaterThan(Date.now());
  });

  test("rejects tokens signed with a different secret", async () => {
    const token = await signOAuthState(SECRET, { organizationId: "org_1", userId: "user_1" });
    expect(await verifyOAuthState("a-different-secret-with-enough-entropy", token)).toBeNull();
  });

  test("rejects tampered payloads", async () => {
    const token = await signOAuthState(SECRET, { organizationId: "org_1", userId: "user_1" });
    const [version, _payload, signature] = token.split(".");
    const fakePayload = btoa(JSON.stringify({ organizationId: "evil", userId: "user_1" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    expect(await verifyOAuthState(SECRET, `${version}.${fakePayload}.${signature}`)).toBeNull();
  });

  test("rejects garbage tokens", async () => {
    expect(await verifyOAuthState(SECRET, "")).toBeNull();
    expect(await verifyOAuthState(SECRET, "nope")).toBeNull();
    expect(await verifyOAuthState(SECRET, "v0.aaaa.bbbb")).toBeNull();
    expect(await verifyOAuthState(SECRET, "v1.@@@@.@@@@")).toBeNull();
  });
});

describe("release target validation", () => {
  test("accepts a well-formed target", () => {
    expect(() => validateReleaseTargetShape(VALID_RELEASE_TARGET)).not.toThrow();
  });

  test("flags a missing environment as unmapped", () => {
    try {
      validateReleaseTargetShape({
        ...VALID_RELEASE_TARGET,
        environment: "",
      });
      throw new Error("expected validation to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GithubAppValidationError);
      expect(err.code).toBe("environment_unmapped");
    }
  });

  test("rejects unsupported ecosystems", () => {
    try {
      validateReleaseTargetShape({ ...VALID_RELEASE_TARGET, ecosystem: "rubygems" });
      throw new Error("expected validation to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GithubAppValidationError);
      expect(err.code).toBe("unsupported_ecosystem");
    }
  });

  test("rejects malformed repository identifiers", () => {
    const malformed = [
      { repositoryFullName: "just-one-segment" },
      { repositoryFullName: "owner/" },
      { repositoryFullName: "owner/repo/extra" },
      { repositoryFullName: "owner/repo!" },
      { repositoryFullName: "../installation" },
      { repositoryFullName: "owner/.." },
      { repositoryId: 0 },
      { repositoryId: -5 },
    ];
    for (const override of malformed) {
      try {
        validateReleaseTargetShape({ ...VALID_RELEASE_TARGET, ...override });
        throw new Error(`expected validation to throw for ${JSON.stringify(override)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(GithubAppValidationError);
        expect(err.code).toBe("invalid_input");
      }
    }
  });

  test("fetchRepository rejects malformed repo names before issuing GitHub requests", async () => {
    await expect(
      fetchRepository(readGithubAppConfig(VALID_ENV), "123", "../installation"),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("treats GitHub environment names as case-insensitive", () => {
    expect(() =>
      validateReleaseTargetShape({
        ...VALID_RELEASE_TARGET,
        environment: "PyPI-Release",
      }),
    ).not.toThrow();
  });

  test("accepts GitHub environment names with punctuation up to 255 characters", () => {
    const longEnvironment = "release/" + "a".repeat(247);
    expect(longEnvironment).toHaveLength(255);
    expect(() =>
      validateReleaseTargetShape({
        ...VALID_RELEASE_TARGET,
        environment: "release/env: prod #1",
      }),
    ).not.toThrow();
    expect(() =>
      validateReleaseTargetShape({
        ...VALID_RELEASE_TARGET,
        environment: longEnvironment,
      }),
    ).not.toThrow();
  });

  test("rejects overlong and control-character environment names", () => {
    try {
      const tooLong = "a".repeat(256);
      validateReleaseTargetShape({
        ...VALID_RELEASE_TARGET,
        environment: tooLong,
      });
      throw new Error("expected validation to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GithubAppValidationError);
      expect(err.code).toBe("environment_unmapped");
    }

    try {
      validateReleaseTargetShape({
        ...VALID_RELEASE_TARGET,
        environment: "release\nprod",
      });
      throw new Error("expected validation to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GithubAppValidationError);
      expect(err.code).toBe("invalid_input");
    }
  });
});
