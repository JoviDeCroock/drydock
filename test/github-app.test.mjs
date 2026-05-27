import { describe, expect, test } from "vitest";
import {
  GithubAppConfigError,
  GithubAppValidationError,
  buildInstallUrl,
  isGithubAppConfigured,
  readGithubAppConfig,
  signOAuthState,
  validateReleaseTargetShape,
  verifyOAuthState,
} from "../server/lib/github-app.ts";

const VALID_ENV = {
  GITHUB_APP_ID: "12345",
  GITHUB_APP_SLUG: "drydock-test",
  GITHUB_APP_PRIVATE_KEY: "----- placeholder -----",
  GITHUB_APP_WEBHOOK_SECRET: "webhook-secret-value-1234567890",
  GITHUB_APP_STATE_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_SECRET: "fallback-secret-with-enough-entropy-aaaaaaaa",
};

const VALID_RELEASE_TARGET = {
  organizationId: "org_1",
  installationRowId: "inst_1",
  ecosystem: "pypi",
  packageName: "example-package",
  repositoryId: 42,
  repositoryFullName: "octo/example",
  workflowFilename: null,
  environment: "pypi-release",
  pypiTrustedPublisherEnvironment: "pypi-release",
  createdByUserId: null,
};

describe("github app config", () => {
  test("isGithubAppConfigured is true only when every env var is present", () => {
    expect(isGithubAppConfigured(VALID_ENV)).toBe(true);
    expect(isGithubAppConfigured({ ...VALID_ENV, GITHUB_APP_ID: "" })).toBe(false);
    expect(isGithubAppConfigured({ ...VALID_ENV, GITHUB_APP_SLUG: undefined })).toBe(false);
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
  });
});

describe("release target validation", () => {
  test("accepts a well-formed target", () => {
    expect(() => validateReleaseTargetShape(VALID_RELEASE_TARGET)).not.toThrow();
  });

  test("flags an environment that does not match the trusted publisher environment", () => {
    try {
      validateReleaseTargetShape({
        ...VALID_RELEASE_TARGET,
        pypiTrustedPublisherEnvironment: "different",
      });
      throw new Error("expected validation to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GithubAppValidationError);
      expect(err.code).toBe("environment_mismatch");
    }
  });

  test("flags a missing environment as unmapped", () => {
    try {
      validateReleaseTargetShape({
        ...VALID_RELEASE_TARGET,
        environment: "",
        pypiTrustedPublisherEnvironment: "",
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

  test("rejects bad workflow filenames", () => {
    try {
      validateReleaseTargetShape({ ...VALID_RELEASE_TARGET, workflowFilename: "release.json" });
      throw new Error("expected validation to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GithubAppValidationError);
      expect(err.code).toBe("invalid_input");
    }
  });

  test("accepts a workflow filename when it ends with .yml or .yaml", () => {
    expect(() =>
      validateReleaseTargetShape({ ...VALID_RELEASE_TARGET, workflowFilename: "release.yml" }),
    ).not.toThrow();
    expect(() =>
      validateReleaseTargetShape({ ...VALID_RELEASE_TARGET, workflowFilename: "release.yaml" }),
    ).not.toThrow();
  });
});
