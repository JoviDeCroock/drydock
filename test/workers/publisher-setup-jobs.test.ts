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
import { publisherSetupJobs, organizationMembers } from "../../server/db/schema";
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
  options: { judgeRejects?: boolean; transientDraft?: boolean; permanentDraft?: boolean } = {},
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
  const request = { ...SETUP_DRAFT_REQUEST, installationRowId: installation.id };
  let draftCalls = 0;
  let judgeCalls = 0;
  const binding: Partial<Bindings> = {
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
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/access_tokens"))
        return Response.json({ token: "private-installation-token" });
      if (url.pathname === "/repos/octo/release")
        return Response.json({ id: 42, full_name: "octo/release", default_branch: "main" });
      if (url.pathname.includes("/git/ref/heads/"))
        return Response.json({ object: { sha: SETUP_BASE_SHA } });
      if (url.pathname.includes("/contents/.github/workflows/release.yml"))
        return Response.json({
          type: "file",
          path: request.workflowPath,
          sha: SETUP_BLOB_SHA,
          size: SETUP_ORIGINAL_WORKFLOW.length,
          encoding: "base64",
          content: btoa(SETUP_ORIGINAL_WORKFLOW),
        });
      throw new Error("Unexpected transport request");
    }),
  );
  const app = buildTestApp((app) => app.route("/api/v1/github-app", githubAppRoutes), {
    userId: owner.userId,
    emailVerified: true,
  });
  return { owner, request, app, binding, testEnv, counts: () => ({ draftCalls, judgeCalls }) };
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
    { judgeRejects: false, transientDraft: false, permanentDraft: false },
    { judgeRejects: true, transientDraft: false, permanentDraft: false },
    { judgeRejects: false, transientDraft: true, permanentDraft: false },
    { judgeRejects: false, transientDraft: false, permanentDraft: true },
  ])("real Workflow checkpoints keep source private for %j", async (options) => {
    const judgeRejects = options.judgeRejects;
    const { app, owner, request, binding, counts } = await fixture(options);
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
      if (judgeRejects) expect(finished?.result).toBeNull();
      else {
        expect(finished?.result?.originalContent).toBe(SETUP_ORIGINAL_WORKFLOW);
        expect(finished?.result?.proposalToken).toBeTruthy();
        expect(await state.instance.waitForStepResult({ name: "ready" })).toEqual({
          jobId: job.id,
        });
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
