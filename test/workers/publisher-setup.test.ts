import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { githubAppRoutes } from "../../server/routes/github-app";
import { upsertInstallation } from "../../server/lib/github-app/persistence";
import { signSetupProposal } from "../../server/lib/github-app/setup-draft";
import * as schema from "../../server/db/schema";
import type { Bindings } from "../../server/types";
import { buildTestApp, call } from "./helpers/app";
import { seedCompletedScan, seedUser, seedWorkflowGate } from "./helpers/seed";
import { exhaustedRateLimitBindings } from "./rate-limit-doubles";
import {
  SETUP_BASE_SHA,
  SETUP_DRAFT_REQUEST,
  SETUP_ORIGINAL_WORKFLOW,
  setupProposal,
} from "../helpers/publisher-setup-fixtures";

let privateKeyPem = "";
beforeAll(async () => {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary)
    .match(/.{1,64}/g)
    ?.join("\n")}\n-----END PRIVATE KEY-----`;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const STATE_SECRET = "publisher-setup-state-secret-at-least-32-characters";
function setupEnv(overrides: Partial<Bindings> = {}): Partial<Bindings> {
  return {
    GITHUB_APP_ID: "123",
    GITHUB_APP_SLUG: "drydock-test",
    GITHUB_APP_CLIENT_ID: "client-id",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_PRIVATE_KEY: privateKeyPem,
    GITHUB_APP_WEBHOOK_SECRET: "webhook-secret-value",
    GITHUB_APP_STATE_SECRET: STATE_SECRET,
    BETTER_AUTH_SECRET: STATE_SECRET,
    ...overrides,
  };
}
function mockGithub(
  repositoryId = 42,
  options: {
    missingEnvironment?: boolean;
    environmentStatus?: number;
    protectionAppId?: number;
    createPullRequest?: boolean;
  } = {},
) {
  const calls: Request[] = [];
  let setupBranch = "";
  let pullRequestOpened = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/access_tokens"))
        return Response.json({ token: "scoped-installation-token" });
      if (url.pathname === "/repos/octo/release")
        return Response.json({
          id: repositoryId,
          full_name: "octo/release",
          default_branch: "main",
        });
      if (options.createPullRequest && url.pathname === "/repos/octo/release/pulls") {
        if (request.method === "GET")
          return Response.json(
            pullRequestOpened
              ? [
                  {
                    number: 12,
                    head: { ref: setupBranch, repo: { id: repositoryId } },
                    base: { ref: "main", repo: { id: repositoryId } },
                  },
                ]
              : [],
          );
        pullRequestOpened = true;
        return Response.json({ number: 12 });
      }
      if (options.createPullRequest && url.pathname === "/repos/octo/release/git/refs") {
        const body = (await request.json()) as { ref: string };
        setupBranch = body.ref.slice("refs/heads/".length);
        return Response.json({});
      }
      if (
        options.createPullRequest &&
        url.pathname.startsWith("/repos/octo/release/git/ref/heads/drydock")
      )
        return new Response("missing", { status: 404 });
      if (
        options.createPullRequest &&
        request.method === "PUT" &&
        url.pathname === "/repos/octo/release/contents/.github/workflows/release.yml"
      )
        return Response.json({});
      if (url.pathname === "/repos/octo/release/git/ref/heads/main")
        return Response.json({ object: { sha: SETUP_BASE_SHA } });
      if (url.pathname === "/repos/octo/release/contents/.github/workflows")
        return Response.json([{ type: "file", path: ".github/workflows/release.yml" }]);
      if (url.pathname === "/repos/octo/release/contents/.github/workflows/release.yml")
        return Response.json({
          type: "file",
          path: ".github/workflows/release.yml",
          sha: "b".repeat(40),
          size: SETUP_ORIGINAL_WORKFLOW.length,
          encoding: "base64",
          content: btoa(SETUP_ORIGINAL_WORKFLOW),
        });
      if (url.pathname.endsWith("/deployment_protection_rules"))
        return Response.json({
          total_count: 1,
          custom_deployment_protection_rules: [
            { enabled: true, app: { id: options.protectionAppId ?? 123, slug: "drydock-test" } },
          ],
        });
      if (url.pathname.includes("/environments/"))
        return options.missingEnvironment
          ? new Response("missing", { status: 404 })
          : options.environmentStatus
            ? new Response("private-upstream-detail", { status: options.environmentStatus })
            : Response.json({ name: "production", can_admins_bypass: false });
      throw new Error("Unexpected GitHub operation");
    }),
  );
  return calls;
}
async function fixture() {
  const owner = await seedUser();
  const installation = await upsertInstallation(owner.db, {
    organizationId: owner.organizationId,
    installationId: String(Math.floor(Math.random() * 1e9)),
    accountLogin: "octo",
    accountType: "Organization",
    targetType: "Organization",
    status: "active",
    createdByUserId: owner.userId,
  });
  const app = buildTestApp((app) => app.route("/api/v1/github-app", githubAppRoutes), {
    userId: owner.userId,
    emailVerified: true,
  });
  return {
    owner,
    installation,
    app,
    scope: { installationRowId: installation.id, repositoryFullName: "octo/release" },
  };
}

describe("publisher setup HTTP boundaries", () => {
  test("requires a session before inspecting source", async () => {
    const app = buildTestApp((app) => app.route("/api/v1/github-app", githubAppRoutes), null);
    expect(
      (
        await call(app, "POST", "/api/v1/github-app/setup/inspect", {
          body: SETUP_DRAFT_REQUEST,
          envOverride: setupEnv(),
        })
      ).status,
    ).toBe(401);
  });
  test("refuses another organization's installation before contacting GitHub", async () => {
    const { app } = await fixture();
    const other = await fixture();
    const calls = mockGithub();
    const result = await call(app, "POST", "/api/v1/github-app/setup/inspect", {
      body: other.scope,
      envOverride: setupEnv(),
    });
    expect(result.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
  test("plain members cannot inspect or mutate release setup", async () => {
    const { owner, installation } = await fixture();
    const member = await seedUser();
    await owner.db.insert(schema.organizationMembers).values({
      id: crypto.randomUUID(),
      organizationId: owner.organizationId,
      userId: member.userId,
      role: "member",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const app = buildTestApp((app) => app.route("/api/v1/github-app", githubAppRoutes), {
      userId: member.userId,
      emailVerified: true,
    });
    const calls = mockGithub();
    const result = await call(app, "POST", "/api/v1/github-app/setup/inspect", {
      body: { installationRowId: installation.id, repositoryFullName: "octo/release" },
      activeOrganizationId: owner.organizationId,
      envOverride: setupEnv(),
    });
    expect(result.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
  test("returns bounded workflows pinned to the default branch SHA without writing", async () => {
    const { app, scope } = await fixture();
    const calls = mockGithub();
    const result = await call(app, "POST", "/api/v1/github-app/setup/inspect", {
      body: scope,
      envOverride: setupEnv(),
    });
    expect(result.status).toBe(200);
    expect(
      ((await result.json()) as { inspection: { baseSha: string; workflows: unknown[] } })
        .inspection,
    ).toMatchObject({
      baseSha: SETUP_BASE_SHA,
      workflows: [{ path: ".github/workflows/release.yml", content: SETUP_ORIGINAL_WORKFLOW }],
    });
    expect(
      calls
        .filter((request) => request.method !== "GET")
        .every((request) => request.url.endsWith("/access_tokens")),
    ).toBe(true);
  });
  test("rate limits setup before contacting GitHub", async () => {
    const { app, scope } = await fixture();
    const calls = mockGithub();
    const limited = exhaustedRateLimitBindings();
    expect(
      (
        await call(app, "POST", "/api/v1/github-app/setup/inspect", {
          body: scope,
          envOverride: setupEnv(limited.overrides),
        })
      ).status,
    ).toBe(429);
    expect(calls).toHaveLength(0);
  });
  test("the organization AI killswitch prevents drafting and source transfer", async () => {
    const { app, scope } = await fixture();
    const calls = mockGithub();
    const result = await call(app, "POST", "/api/v1/github-app/setup/draft", {
      body: { ...SETUP_DRAFT_REQUEST, ...scope, createPullRequest: true },
      envOverride: setupEnv({
        FLAGS: { getBooleanValue: async () => false } as unknown as Flagship,
      }),
    });
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ code: "setup_ai_unavailable" });
    expect(calls).toHaveLength(0);
  });
  test("rejects unsigned, changed, expired, or foreign-user proposals before GitHub writes", async () => {
    const { app, scope, owner } = await fixture();
    const calls = mockGithub();
    const proposal = setupProposal(scope);
    const foreignToken = await signSetupProposal(
      STATE_SECRET,
      proposal,
      owner.organizationId,
      "someone-else",
    );
    const result = await call(app, "POST", "/api/v1/github-app/setup/pull-request", {
      body: { proposal, proposalToken: foreignToken },
      envOverride: setupEnv(),
    });
    expect(result.status).toBe(409);
    expect(calls).toHaveLength(0);
  });
  test("valid signed proposals create a draft PR and audit once across retries", async () => {
    const { app, scope, owner } = await fixture();
    mockGithub(42, { createPullRequest: true });
    const proposal = setupProposal(scope);
    const proposalToken = await signSetupProposal(
      STATE_SECRET,
      proposal,
      owner.organizationId,
      owner.userId,
    );
    const options = { body: { proposal, proposalToken }, envOverride: setupEnv() };
    const created = await call(app, "POST", "/api/v1/github-app/setup/pull-request", options);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      pullRequest: { number: 12, url: "https://github.com/octo/release/pull/12" },
    });
    const recovered = await call(app, "POST", "/api/v1/github-app/setup/pull-request", options);
    expect(recovered.status).toBe(200);
    const events = await owner.db
      .select()
      .from(schema.scanEvents)
      .where(
        and(
          eq(schema.scanEvents.organizationId, owner.organizationId),
          eq(schema.scanEvents.type, "github_app_setup.pr_created"),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0].metadataJson).toEqual({
      repositoryFullName: "octo/release",
      environment: "production",
      pullRequestNumber: 12,
    });
    expect(JSON.stringify(events)).not.toContain(proposalToken);
    expect(JSON.stringify(events)).not.toContain(proposal.content);
  });
  test("unverified email cannot inspect private workflows", async () => {
    const { owner, scope } = await fixture();
    const app = buildTestApp((app) => app.route("/api/v1/github-app", githubAppRoutes), {
      userId: owner.userId,
      emailVerified: false,
    });
    const calls = mockGithub();
    const response = await call(app, "POST", "/api/v1/github-app/setup/inspect", {
      body: scope,
      envOverride: setupEnv({
        SEND_EMAIL: {} as Bindings["SEND_EMAIL"],
        BETTER_AUTH_URL: "https://drydock.test",
      }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "email_verification_required" });
    expect(calls).toHaveLength(0);
  });
  test("status reports a missing environment only for GitHub 404", async () => {
    const { app, scope } = await fixture();
    mockGithub(42, { missingEnvironment: true });
    const result = await call(app, "POST", "/api/v1/github-app/setup/status", {
      body: { ...scope, environment: " Production ", ecosystem: "npm" },
      envOverride: setupEnv(),
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      status: {
        environment: "production",
        environmentExists: false,
        protectionEnabled: false,
        firstReview: null,
      },
    });
  });
  test("status does not turn missing GitHub access into missing protection", async () => {
    const { app, scope } = await fixture();
    mockGithub(42, { environmentStatus: 403 });
    const result = await call(app, "POST", "/api/v1/github-app/setup/status", {
      body: { ...scope, environment: "production", ecosystem: "npm" },
      envOverride: setupEnv(),
    });
    expect(result.status).toBe(403);
    const text = await result.text();
    expect(text).not.toContain("private-upstream-detail");
    expect(text).not.toContain('"environmentExists":false');
  });
  test("an unrelated protection app does not satisfy the Drydock check", async () => {
    const { app, scope } = await fixture();
    mockGithub(42, { protectionAppId: 999 });
    const result = await call(app, "POST", "/api/v1/github-app/setup/status", {
      body: { ...scope, environment: "production", ecosystem: "npm" },
      envOverride: setupEnv(),
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ status: { protectionEnabled: false } });
  });
  test("published-pair reviews never complete publisher setup", async () => {
    const { app, owner, scope } = await fixture();
    await seedCompletedScan(owner, { job: { source: "published" } });
    mockGithub();
    const result = await call(app, "POST", "/api/v1/github-app/setup/status", {
      body: { ...scope, environment: "production", ecosystem: "npm" },
      envOverride: setupEnv(),
    });
    expect(await result.json()).toMatchObject({
      status: { firstReview: null, protectionEnabled: true },
    });
  });
  test("distinguishes observed gates from completed reviews and scopes them to the selected environment", async () => {
    const owner = await seedUser();
    const gateId = await seedWorkflowGate(owner, { decision: null });
    const [gate] = await owner.db
      .select()
      .from(schema.githubWorkflowGates)
      .where(eq(schema.githubWorkflowGates.id, gateId));
    const [installation] = await owner.db
      .select()
      .from(schema.githubAppInstallations)
      .where(eq(schema.githubAppInstallations.id, gate.installationRowId));
    const app = buildTestApp((app) => app.route("/api/v1/github-app", githubAppRoutes), {
      userId: owner.userId,
      emailVerified: true,
    });
    mockGithub(gate.repositoryId);
    const conflict = await call(app, "POST", "/api/v1/github-app/setup/status", {
      body: {
        installationRowId: installation.id,
        repositoryFullName: "octo/release",
        environment: "production",
        ecosystem: "npm",
      },
      envOverride: setupEnv(),
    });
    expect(await conflict.json()).toMatchObject({
      status: {
        targetMapped: false,
        firstReview: null,
        checks: expect.arrayContaining([
          expect.objectContaining({
            status: "pending",
            detail: expect.stringContaining("remove the existing mapping"),
          }),
        ]),
      },
    });
    await owner.db
      .update(schema.githubReleaseTargets)
      .set({ artifactName: "npm-release-candidates" })
      .where(eq(schema.githubReleaseTargets.id, gate.releaseTargetId));
    const scope = {
      installationRowId: installation.id,
      repositoryFullName: "octo/release",
      environment: "production",
      ecosystem: "npm",
    };
    mockGithub(gate.repositoryId);
    const pending = await call(app, "POST", "/api/v1/github-app/setup/status", {
      body: scope,
      envOverride: setupEnv(),
    });
    expect(await pending.json()).toMatchObject({
      status: { targetMapped: true, firstReview: { gateId, scanStatus: null, completedAt: null } },
    });
    const completedAt = new Date("2026-10-20T12:00:00Z");
    const scanId = await seedCompletedScan(owner, {
      job: { source: "workflow_gate" },
      jobColumns: { gateId, completedAt },
    });
    await owner.db.update(schema.scans).set({ completedAt }).where(eq(schema.scans.id, scanId));
    await owner.db
      .update(schema.githubWorkflowGates)
      .set({ scanId })
      .where(
        and(
          eq(schema.githubWorkflowGates.id, gateId),
          eq(schema.githubWorkflowGates.organizationId, owner.organizationId),
        ),
      );
    const completed = await call(app, "POST", "/api/v1/github-app/setup/status", {
      body: scope,
      envOverride: setupEnv(),
    });
    expect(await completed.json()).toMatchObject({
      status: {
        firstReview: {
          gateId,
          scanId,
          scanStatus: "complete",
          completedAt: completedAt.toISOString(),
        },
      },
    });
    const unrelated = await call(app, "POST", "/api/v1/github-app/setup/status", {
      body: { ...scope, environment: "other" },
      envOverride: setupEnv(),
    });
    expect(await unrelated.json()).toMatchObject({
      status: { targetMapped: false, firstReview: null },
    });
  });
});
