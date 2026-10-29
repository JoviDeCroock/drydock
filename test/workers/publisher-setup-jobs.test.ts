import { env, introspectWorkflowInstance } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { githubAppRoutes } from "../../server/routes/github-app";
import { upsertInstallation } from "../../server/lib/github-app/persistence";
import {
  createPublisherSetupJob,
  getPublisherSetupJob,
  publisherSetupPayloadKey,
  prunePublisherSetupJobs,
  deletePublisherSetupJobsForUser,
} from "../../server/db/publisher-setup-jobs";
import {
  readPublisherSetupDraftJob,
  runPublisherSetupDraftJob,
} from "../../server/lib/github-app/setup-jobs";
import { deleteOrganization } from "../../server/db/organizations";
import { publisherSetupJobs, organizationMembers, scanEvents } from "../../server/db/schema";
import type { Bindings } from "../../server/types";
import type { PublisherSetupDraftJob } from "../../server/lib/github-app/setup-types";
import { buildTestApp, call } from "./helpers/app";
import { seedUser } from "./helpers/seed";
import { configurePublisherSetupWorkflowTest } from "./helpers/publisher-setup-workflow-entry";
import {
  SETUP_BASE_SHA,
  SETUP_BLOB_SHA,
  SETUP_DRAFT_REQUEST,
  SETUP_ORIGINAL_WORKFLOW,
  SETUP_PROPOSED_WORKFLOW,
} from "../helpers/publisher-setup-fixtures";

let privateKey = "";
const PACKAGE_CONTEXT =
  '{"name":"context-only-fixture","scripts":{"build":"compile reviewed package","prepublishOnly":"npm run build"}}';
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  privateKey = `-----BEGIN PRIVATE KEY-----\n${btoa(binary)
    .match(/.{1,64}/g)
    ?.join("\n")}\n-----END PRIVATE KEY-----`;
});
afterEach(() => {
  configurePublisherSetupWorkflowTest({});
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fixture(
  options: {
    judgeRejects?: boolean;
    transientDraft?: boolean;
    permanentDraft?: boolean;
    writePermissionsMissing?: boolean;
    staleBeforePr?: boolean;
    uncertainPr?: boolean;
    revokeBeforePr?: boolean;
    invalidDraft?: boolean;
    incompleteContext?: boolean;
    unsupportedScript?: "flags" | "directory" | "missing";
  } = {},
) {
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
  const request = {
    ...SETUP_DRAFT_REQUEST,
    installationRowId: installation.id,
    createPullRequest: true as const,
  };
  let draftCalls = 0;
  let judgeCalls = 0;
  let tokenCalls = 0;
  let pullRequestsCreated = 0;
  let headCalls = 0;
  let prBranch = "";
  let originalWorkflow = options.incompleteContext
    ? `${SETUP_ORIGINAL_WORKFLOW}      - uses: changesets/action@v1\n`
    : SETUP_ORIGINAL_WORKFLOW;
  if (options.unsupportedScript)
    originalWorkflow += `      - uses: changesets/action@v1\n        with:\n          publish: node ${options.unsupportedScript === "flags" ? "--enable-source-maps " : ""}.github/scripts/stage-packages.mjs\n${options.unsupportedScript === "directory" ? "      - working-directory: packages/a\n        run: node .github/scripts/stage-packages.mjs\n" : ""}`;
  const packageContext = options.incompleteContext
    ? JSON.stringify({ name: "context-only-fixture", workspaces: ["packages/**"] })
    : PACKAGE_CONTEXT;
  const binding: Partial<Bindings> = {
    PUBLISHER_SETUP_WORKFLOW: undefined,
    GITHUB_APP_ID: "123",
    GITHUB_APP_SLUG: "drydock-test",
    GITHUB_APP_CLIENT_ID: "client",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_WEBHOOK_SECRET: "webhook-secret",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_STATE_SECRET: "publisher-workflow-state-secret-with-32-chars",
    BETTER_AUTH_SECRET: "publisher-workflow-state-secret-with-32-chars",
    FLAGS: { getBooleanValue: async () => true } as unknown as Flagship,
    AI: {
      run: vi.fn(async (_model: string, input: unknown) => {
        expect(JSON.stringify(input)).toContain("context-only-fixture");
        const data = input as {
          response_format?: { json_schema?: { properties?: { verdict?: unknown } } };
        };
        const judging = Boolean(data.response_format?.json_schema?.properties?.verdict);
        if (judging) judgeCalls++;
        else draftCalls++;
        if (!judging && (options.permanentDraft || (options.transientDraft && draftCalls === 1)))
          throw Object.assign(new Error("PRIVATE_WORKFLOW credential=must-not-enter-history"), {
            code: 3040,
          });
        const content = judging
          ? JSON.stringify({
              verdict: options.judgeRejects ? "changes_requested" : "pass",
              summary: options.judgeRejects
                ? "The release behavior needs another look."
                : "The reviewed archive is published by the protected job.",
              issues: options.judgeRejects ? ["Review the publication conditions."] : [],
            })
          : data.response_format
            ? JSON.stringify({
                content: SETUP_PROPOSED_WORKFLOW,
                summary: "Separate packaging and publication.",
              })
            : options.invalidDraft
              ? "name: invalid"
              : SETUP_PROPOSED_WORKFLOW;
        return {
          choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        };
      }),
    } as unknown as Bindings["AI"],
  };
  const testEnv = { ...env, ...binding } as Bindings;
  configurePublisherSetupWorkflowTest(binding);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/access_tokens")) {
        tokenCalls++;
        const body = JSON.parse(String(init?.body));
        expect(body.permissions).toEqual({
          contents: "write",
          pull_requests: "write",
          workflows: "write",
        });
        expect(body.repositories).toEqual(["release"]);
        if (options.writePermissionsMissing) return Response.json({}, { status: 403 });
        if (options.revokeBeforePr && tokenCalls === 2)
          await owner.db
            .update(organizationMembers)
            .set({ role: "member" })
            .where(eq(organizationMembers.userId, owner.userId));
        return Response.json({ token: "private-installation-token" });
      }
      if (url.pathname === "/repos/octo/release")
        return Response.json({ id: 42, full_name: "octo/release", default_branch: "main" });
      if (url.pathname === `/repos/octo/release/git/trees/${SETUP_BASE_SHA}`)
        return Response.json({
          tree: [
            { path: "package.json", type: "blob", mode: "100644", sha: SETUP_BLOB_SHA },
            ...(options.unsupportedScript && options.unsupportedScript !== "missing"
              ? [{ path: ".github", type: "tree", mode: "040000", sha: "c".repeat(40) }]
              : []),
          ],
          truncated: false,
        });
      if (url.pathname === `/repos/octo/release/git/trees/${"c".repeat(40)}`)
        return Response.json({
          tree: [{ path: "scripts", type: "tree", mode: "040000", sha: "d".repeat(40) }],
          truncated: false,
        });
      if (url.pathname === `/repos/octo/release/git/trees/${"d".repeat(40)}`)
        return Response.json({
          tree: [{ path: "stage-packages.mjs", type: "blob", mode: "100644", sha: SETUP_BLOB_SHA }],
          truncated: false,
        });
      if (url.pathname === "/repos/octo/release/contents/.github/scripts/stage-packages.mjs") {
        expect(url.searchParams.get("ref")).toBe(SETUP_BASE_SHA);
        const content = "throw new Error('inert fixture source');";
        return Response.json({
          type: "file",
          path: ".github/scripts/stage-packages.mjs",
          sha: SETUP_BLOB_SHA,
          encoding: "base64",
          size: content.length,
          content: btoa(content),
        });
      }
      if (url.pathname === "/repos/octo/release/contents/package.json") {
        expect(url.searchParams.get("ref")).toBe(SETUP_BASE_SHA);
        return Response.json({
          type: "file",
          path: "package.json",
          sha: SETUP_BLOB_SHA,
          encoding: "base64",
          size: packageContext.length,
          content: btoa(packageContext),
        });
      }
      if (url.pathname.includes("/git/ref/heads/")) {
        if (!url.pathname.endsWith("/main")) return Response.json({}, { status: 404 });
        headCalls++;
        return Response.json({
          object: { sha: options.staleBeforePr && headCalls > 1 ? "b".repeat(40) : SETUP_BASE_SHA },
        });
      }
      if (url.pathname.endsWith("/pulls")) {
        if (init?.method === "POST") {
          pullRequestsCreated++;
          const body = JSON.parse(String(init.body));
          expect(body.draft).toBe(true);
          prBranch = body.head;
          if (options.uncertainPr && pullRequestsCreated === 1)
            return Response.json({}, { status: 502 });
          return Response.json({ number: 81 });
        }
        return Response.json(
          pullRequestsCreated
            ? [
                {
                  number: 81,
                  head: { ref: prBranch, repo: { id: 42 } },
                  base: { ref: "main", repo: { id: 42 } },
                },
              ]
            : [],
        );
      }
      if (url.pathname.endsWith("/git/refs")) return Response.json({});
      if (url.pathname.includes("/contents/.github/workflows/release.yml"))
        if (init?.method === "PUT") return Response.json({});
        else
          return Response.json({
            type: "file",
            path: request.workflowPath,
            sha: SETUP_BLOB_SHA,
            size: originalWorkflow.length,
            encoding: "base64",
            content: btoa(originalWorkflow),
          });
      throw new Error("Unexpected transport request");
    }),
  );
  const app = buildTestApp((app) => app.route("/api/v1/github-app", githubAppRoutes), {
    userId: owner.userId,
    emailVerified: true,
  });
  return {
    owner,
    request,
    app,
    binding,
    testEnv,
    counts: () => ({ draftCalls, judgeCalls }),
    prCount: () => pullRequestsCreated,
  };
}

function workflowBinding() {
  const binding = env.PUBLISHER_SETUP_WORKFLOW;
  if (!binding) throw new Error("Workflow test binding is missing");
  return binding;
}

describe("publisher setup durable jobs", () => {
  test("queues immediately and returns only metadata; polling is creator and organization scoped", async () => {
    const { app, owner, request, binding } = await fixture();
    const create = vi.fn(async (_options: unknown) => ({}));
    const queued = await call(app, "POST", "/api/v1/github-app/setup/draft", {
      body: request,
      envOverride: {
        ...binding,
        PUBLISHER_SETUP_WORKFLOW: { create } as unknown as Bindings["PUBLISHER_SETUP_WORKFLOW"],
      },
    });
    expect(queued.status).toBe(202);
    const { job } = (await queued.json()) as { job: PublisherSetupDraftJob };
    expect(job).toMatchObject({
      status: "queued",
      stage: "queued",
      request,
      result: null,
      judge: null,
    });
    expect(create).toHaveBeenCalledWith({ id: job.id, params: { jobId: job.id } });
    expect(JSON.stringify(job)).not.toContain(SETUP_ORIGINAL_WORKFLOW);
    expect(
      (
        await call(app, "GET", `/api/v1/github-app/setup/draft-jobs/${job.id}`, {
          envOverride: binding,
        })
      ).status,
    ).toBe(200);
    const other = await seedUser();
    await owner.db.insert(organizationMembers).values({
      id: crypto.randomUUID(),
      organizationId: owner.organizationId,
      userId: other.userId,
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const otherApp = buildTestApp((app) => app.route("/api/v1/github-app", githubAppRoutes), {
      userId: other.userId,
      emailVerified: true,
    });
    expect(
      (
        await call(otherApp, "GET", `/api/v1/github-app/setup/draft-jobs/${job.id}`, {
          activeOrganizationId: owner.organizationId,
          envOverride: binding,
        })
      ).status,
    ).toBe(404);
  });
  test("requires the Workflow binding without running an inline fallback", async () => {
    const { app, request, binding } = await fixture();
    const result = await call(app, "POST", "/api/v1/github-app/setup/draft", {
      body: request,
      envOverride: { ...binding, PUBLISHER_SETUP_WORKFLOW: undefined },
    });
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ code: "setup_workflow_unavailable" });
  });
  test("draft creation requires explicit PR authorization and legacy queued jobs cannot write", async () => {
    const { owner, request, app, binding, testEnv, counts, prCount } = await fixture();
    const { createPullRequest: _authorization, ...legacyRequest } = request;
    const response = await call(app, "POST", "/api/v1/github-app/setup/draft", {
      body: legacyRequest,
      envOverride: binding,
    });
    expect(response.status).toBe(400);
    const job = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      legacyRequest,
    );
    await runPublisherSetupDraftJob(testEnv, job.id, async (_stage, operation) => operation());
    expect((await getPublisherSetupJob(owner.db, job.id))?.failureJson?.code).toBe(
      "setup_authorization_required",
    );
    expect(counts()).toEqual({ draftCalls: 0, judgeCalls: 0 });
    expect(prCount()).toBe(0);
  });
  test.each([
    {
      options: { writePermissionsMissing: true },
      code: "setup_permissions_required",
      draftCalls: 0,
      judgeCalls: 0,
    },
    { options: { staleBeforePr: true }, code: "proposal_stale", draftCalls: 1, judgeCalls: 1 },
    {
      options: { revokeBeforePr: true },
      code: "setup_access_changed",
      draftCalls: 1,
      judgeCalls: 1,
    },
    {
      options: { invalidDraft: true },
      code: "workflow_invalid",
      draftCalls: 1,
      judgeCalls: 0,
    },
    {
      options: { incompleteContext: true },
      code: "setup_context_incomplete",
      draftCalls: 0,
      judgeCalls: 0,
    },
    {
      options: { unsupportedScript: "flags" as const },
      code: "setup_context_incomplete",
      draftCalls: 0,
      judgeCalls: 0,
    },
    {
      options: { unsupportedScript: "directory" as const },
      code: "setup_context_incomplete",
      draftCalls: 0,
      judgeCalls: 0,
    },
    {
      options: { unsupportedScript: "missing" as const },
      code: "setup_context_incomplete",
      draftCalls: 0,
      judgeCalls: 0,
    },
  ])("setup failure $code never opens a PR", async ({ options, code, draftCalls, judgeCalls }) => {
    const { owner, request, testEnv, counts, prCount } = await fixture(options);
    const job = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      request,
    );
    await runPublisherSetupDraftJob(testEnv, job.id, async (_stage, operation) => operation());
    expect((await getPublisherSetupJob(owner.db, job.id))?.failureJson?.code).toBe(code);
    expect(counts()).toEqual({ draftCalls, judgeCalls });
    expect(prCount()).toBe(0);
    expect(
      await owner.db
        .select()
        .from(scanEvents)
        .where(
          and(
            eq(scanEvents.type, "github_app_setup.pr_created"),
            eq(scanEvents.organizationId, owner.organizationId),
          ),
        ),
    ).toHaveLength(0);
  });
  test.each(["errored", "terminated", "complete"])(
    "polling reconciles a terminal %s runtime without exposing its private error",
    async (status) => {
      const { owner, request, testEnv } = await fixture();
      const job = await createPublisherSetupJob(
        owner.db,
        owner.organizationId,
        owner.userId,
        request,
      );
      await env.ARTIFACTS.put(publisherSetupPayloadKey(job, "source"), SETUP_ORIGINAL_WORKFLOW);
      const finished = await readPublisherSetupDraftJob(
        {
          ...testEnv,
          PUBLISHER_SETUP_WORKFLOW: {
            get: async () => ({
              status: async () => ({
                status,
                error: { message: "PRIVATE_WORKFLOW credential=must-not-leak" },
              }),
            }),
          } as unknown as Bindings["PUBLISHER_SETUP_WORKFLOW"],
        },
        job.id,
        owner.organizationId,
        owner.userId,
      );
      expect(finished).toMatchObject({
        status: "failed",
        failure: { code: "setup_workflow_failed" },
        result: null,
      });
      expect(JSON.stringify(finished)).not.toContain("PRIVATE_WORKFLOW");
      expect(JSON.stringify(finished)).not.toContain(SETUP_ORIGINAL_WORKFLOW);
      expect((await getPublisherSetupJob(owner.db, job.id))?.status).toBe("failed");
      expect(await env.ARTIFACTS.get(publisherSetupPayloadKey(job, "source"))).toBeNull();
    },
  );
  test("a runtime-status outage leaves a pending job unchanged", async () => {
    const { owner, request, testEnv } = await fixture();
    const job = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      request,
    );
    const pending = await readPublisherSetupDraftJob(
      {
        ...testEnv,
        PUBLISHER_SETUP_WORKFLOW: {
          get: async () => {
            throw new Error("PRIVATE_WORKFLOW credential=must-not-leak");
          },
        } as unknown as Bindings["PUBLISHER_SETUP_WORKFLOW"],
      },
      job.id,
      owner.organizationId,
      owner.userId,
    );
    expect(pending).toMatchObject({ status: "queued", failure: null, result: null });
    expect(JSON.stringify(pending)).not.toContain("PRIVATE_WORKFLOW");
  });
  test("runtime reconciliation preserves a ready result committed during polling", async () => {
    const { owner, request, testEnv } = await fixture();
    const job = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      request,
    );
    const finished = await readPublisherSetupDraftJob(
      {
        ...testEnv,
        PUBLISHER_SETUP_WORKFLOW: {
          get: async () => ({
            status: async () => {
              await runPublisherSetupDraftJob(testEnv, job.id, async (_stage, operation) =>
                operation(),
              );
              return { status: "complete" };
            },
          }),
        } as unknown as Bindings["PUBLISHER_SETUP_WORKFLOW"],
      },
      job.id,
      owner.organizationId,
      owner.userId,
    );
    expect(finished?.status).toBe("ready");
    expect(finished?.result?.proposalToken).toBeTruthy();
    expect(finished?.result?.originalContent).toBe(SETUP_ORIGINAL_WORKFLOW);
  });
  test.each([
    { judgeRejects: false, transientDraft: false, permanentDraft: false, uncertainPr: false },
    { judgeRejects: true, transientDraft: false, permanentDraft: false, uncertainPr: false },
    { judgeRejects: false, transientDraft: true, permanentDraft: false, uncertainPr: false },
    { judgeRejects: false, transientDraft: false, permanentDraft: true, uncertainPr: false },
    { judgeRejects: false, transientDraft: false, permanentDraft: false, uncertainPr: true },
  ])("real Workflow checkpoints keep source private for %j", async (options) => {
    const judgeRejects = options.judgeRejects;
    const { app, owner, request, binding, counts, prCount, testEnv } = await fixture(options);
    const state: { instance?: Awaited<ReturnType<typeof introspectWorkflowInstance>> } = {};
    const realBinding = workflowBinding();
    const create = async (options: { id: string; params: { jobId: string } }) => {
      state.instance = await introspectWorkflowInstance(realBinding, options.id);
      await state.instance.modify(async (modify) => {
        await modify.disableRetryDelays();
      });
      return realBinding.create(options);
    };
    try {
      const queued = await call(app, "POST", "/api/v1/github-app/setup/draft", {
        body: request,
        envOverride: {
          ...binding,
          PUBLISHER_SETUP_WORKFLOW: { create } as unknown as Bindings["PUBLISHER_SETUP_WORKFLOW"],
        },
      });
      expect(queued.status).toBe(202);
      const { job } = (await queued.json()) as { job: PublisherSetupDraftJob };
      if (!state.instance) throw new Error("Workflow was not started");
      await state.instance.waitForStatus("complete");
      const finished = await readPublisherSetupDraftJob(
        { ...env, ...binding } as Bindings,
        job.id,
        owner.organizationId,
        owner.userId,
      );
      if (options.permanentDraft) {
        expect(finished?.status).toBe("failed");
        expect(finished?.failure?.code).toBe("setup_ai_temporarily_unavailable");
        expect(counts()).toEqual({ draftCalls: 2, judgeCalls: 0 });
        expect(finished?.result).toBeNull();
        expect(prCount()).toBe(0);
        const runtimeStatus = await (await realBinding.get(job.id)).status();
        expect(runtimeStatus.status).toBe("complete");
        expect(runtimeStatus.output).toEqual({ jobId: job.id });
        expect(JSON.stringify(runtimeStatus)).not.toContain("PRIVATE_WORKFLOW");
        expect(JSON.stringify(runtimeStatus)).not.toContain(SETUP_ORIGINAL_WORKFLOW);
        return;
      }
      expect(finished?.status).toBe(judgeRejects ? "failed" : "ready");
      expect(finished?.judge?.verdict).toBe(judgeRejects ? "changes_requested" : "pass");
      expect(counts()).toEqual({ draftCalls: options.transientDraft ? 2 : 1, judgeCalls: 1 });
      for (const name of ["fetch_source", "draft", "validate", "judge"] as const)
        expect(await state.instance.waitForStepResult({ name })).toEqual({ jobId: job.id });
      expect(await state.instance.getOutput()).toEqual({ jobId: job.id });
      expect(JSON.stringify(finished)).not.toContain("context-only-fixture");
      const source = await env.ARTIFACTS.get(
        publisherSetupPayloadKey({ id: job.id, organizationId: owner.organizationId }, "source"),
      );
      expect(await source?.text()).toContain("context-only-fixture");
      if (judgeRejects) {
        expect(finished?.result).toBeNull();
        expect(prCount()).toBe(0);
      } else {
        expect(finished?.result?.originalContent).toBe(SETUP_ORIGINAL_WORKFLOW);
        expect(finished?.result?.proposalToken).toBeTruthy();
        expect(finished?.result?.pullRequest).toMatchObject({
          number: 81,
          url: "https://github.com/octo/release/pull/81",
        });
        expect(prCount()).toBe(1);
        expect(await state.instance.waitForStepResult({ name: "create_pr" })).toEqual({
          jobId: job.id,
        });
        if (options.uncertainPr) {
          const repeat = await createPublisherSetupJob(
            owner.db,
            owner.organizationId,
            owner.userId,
            request,
          );
          await runPublisherSetupDraftJob(testEnv, repeat.id, async (_stage, operation) =>
            operation(),
          );
          expect((await getPublisherSetupJob(owner.db, repeat.id))?.status).toBe("ready");
          expect(prCount()).toBe(1);
        }
        const audit = await owner.db
          .select()
          .from(scanEvents)
          .where(
            and(
              eq(scanEvents.type, "github_app_setup.pr_created"),
              eq(scanEvents.organizationId, owner.organizationId),
            ),
          );
        expect(audit).toHaveLength(1);
        expect(audit[0]?.metadataJson).toEqual({
          repositoryFullName: "octo/release",
          environment: request.environment,
          pullRequestNumber: 81,
        });
        expect(JSON.stringify(audit)).not.toContain(SETUP_PROPOSED_WORKFLOW);
      }
    } finally {
      await state.instance?.dispose();
    }
  });
  test("transient model failure gets one bounded retry; durable results contain only the opaque job id", async () => {
    const { owner, request, testEnv, counts } = await fixture({ transientDraft: true });
    const job = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      request,
    );
    const outputs: unknown[] = [];
    await runPublisherSetupDraftJob(testEnv, job.id, async (_stage, operation, retryModel) => {
      try {
        await operation();
      } catch (error) {
        if (!retryModel) throw error;
        await operation();
      }
      outputs.push({ jobId: job.id });
    });
    expect(counts()).toEqual({ draftCalls: 2, judgeCalls: 1 });
    expect((await getPublisherSetupJob(owner.db, job.id))?.status).toBe("ready");
    expect(JSON.stringify(outputs)).not.toContain("PRIVATE_WORKFLOW");
  });
  test("killswitch and membership changes stop a queued job before model work", async () => {
    const { owner, request, testEnv, counts } = await fixture();
    const job = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      request,
    );
    await owner.db
      .update(organizationMembers)
      .set({ role: "member" })
      .where(
        and(
          eq(organizationMembers.organizationId, owner.organizationId),
          eq(organizationMembers.userId, owner.userId),
        ),
      );
    await runPublisherSetupDraftJob(testEnv, job.id, async (_stage, operation) => operation());
    expect(counts()).toEqual({ draftCalls: 0, judgeCalls: 0 });
    expect((await getPublisherSetupJob(owner.db, job.id))?.failureJson?.code).toBe(
      "setup_access_changed",
    );
  });
  test("organization deletion removes job metadata and every private payload", async () => {
    const { owner, request } = await fixture();
    const job = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      request,
    );
    await env.ARTIFACTS.put(publisherSetupPayloadKey(job, "source"), SETUP_ORIGINAL_WORKFLOW);
    await deleteOrganization(owner.db, owner.organizationId, env.ARTIFACTS);
    expect(await getPublisherSetupJob(owner.db, job.id)).toBeNull();
    expect(await env.ARTIFACTS.get(publisherSetupPayloadKey(job, "source"))).toBeNull();
  });
  test("a late model-result write cannot restore a user-deleted job or leave private payloads", async () => {
    const { owner, request, testEnv, counts } = await fixture();
    const job = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      request,
    );
    const realBucket = env.ARTIFACTS;
    const bucket = new Proxy(realBucket, {
      get(target, key) {
        if (key === "put")
          return async (path: string, value: string, options: R2PutOptions) => {
            if (path.endsWith("/candidate.json"))
              await deletePublisherSetupJobsForUser(owner.db, realBucket, owner.userId);
            return target.put(path, value, options);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await runPublisherSetupDraftJob(
      { ...testEnv, ARTIFACTS: bucket },
      job.id,
      async (_stage, operation) => operation(),
    );
    expect(await getPublisherSetupJob(owner.db, job.id)).toBeNull();
    for (const payload of ["source", "candidate", "judge", "result"] as const)
      expect(await realBucket.get(publisherSetupPayloadKey(job, payload))).toBeNull();
    expect(counts()).toEqual({ draftCalls: 1, judgeCalls: 0 });
  });
  test("expiry and user cleanup remove private payloads with metadata", async () => {
    const { owner, request, testEnv } = await fixture();
    const job = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      request,
    );
    await env.ARTIFACTS.put(publisherSetupPayloadKey(job, "source"), SETUP_ORIGINAL_WORKFLOW);
    await owner.db
      .update(publisherSetupJobs)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(publisherSetupJobs.id, job.id));
    expect(
      await readPublisherSetupDraftJob(testEnv, job.id, owner.organizationId, owner.userId),
    ).toBeNull();
    expect(await prunePublisherSetupJobs(owner.db, env.ARTIFACTS)).toBe(1);
    expect(await env.ARTIFACTS.get(publisherSetupPayloadKey(job, "source"))).toBeNull();
    const second = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      request,
    );
    await env.ARTIFACTS.put(
      publisherSetupPayloadKey(second, "candidate"),
      "private generated source",
    );
    await deletePublisherSetupJobsForUser(owner.db, env.ARTIFACTS, owner.userId);
    expect(await env.ARTIFACTS.get(publisherSetupPayloadKey(second, "candidate"))).toBeNull();
    expect(await getPublisherSetupJob(owner.db, second.id)).toBeNull();
  });
});
