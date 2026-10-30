import { env, introspectWorkflowInstance } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { githubAppRoutes } from "../../server/routes/github-app";
import { upsertInstallation } from "../../server/lib/github-app/persistence";
import {
  createPublisherSetupJob,
  getPublisherSetupJob,
  updatePublisherSetupJob,
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
import { SETUP_DRAFT_MAX_TURNS } from "../../server/lib/github-app/setup-agent";
import { sha256Hex } from "../../server/lib/platform/crypto-utils";
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
    blocked?: boolean;
    noProgress?: boolean;
    multiFile?: boolean;
    tamperAfterTree?: boolean;
    investigationHandoff?: boolean;
    killBeforePr?: boolean;
    expireAndKillAfterFirstWrite?: boolean;
    revokeAfterFirstWrite?: boolean;
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
  let writeTokens = 0;
  let pullRequestsCreated = 0;
  let headCalls = 0;
  let prBranch = "";
  let prBody = "";
  let revokedTokens = 0;
  let aiReviewEnabled = true;
  let branchHead: string | null = null;
  const gitWrites: string[] = [];
  const helperPath = ".github/scripts/release-helper.js";
  const helperContent = "// Private proposed repository source; never executed by Drydock.\n";
  const proposed = options.multiFile
    ? SETUP_PROPOSED_WORKFLOW.replace(
        "      - run: npm pack",
        `      - run: node ${helperPath}\n      - run: npm pack`,
      )
    : SETUP_PROPOSED_WORKFLOW;
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
    FLAGS: { getBooleanValue: async () => aiReviewEnabled } as unknown as Flagship,
    AI: {
      run: vi.fn(async (_model: string, input: unknown) => {
        const data = input as {
          tools?: { function?: { name?: string } }[];
          messages?: { role: string; content?: unknown }[];
        };
        const judging = Boolean(
          data.tools?.some((entry) => entry.function?.name === "finish_review"),
        );
        const finishingInvestigation = Boolean(
          data.tools?.some((entry) => entry.function?.name === "finish_investigation"),
        );
        if (options.investigationHandoff && judging)
          for (const marker of [
            "INERT_INVESTIGATOR_HISTORY",
            "INERT_INVESTIGATOR_CONTEXT",
            "INERT_ADVISORY_PLAN",
          ])
            expect(JSON.stringify(data.messages)).not.toContain(marker);
        if (judging) judgeCalls++;
        else draftCalls++;
        if (!judging && (options.permanentDraft || (options.transientDraft && draftCalls === 1)))
          throw Object.assign(new Error("PRIVATE_WORKFLOW credential=must-not-enter-history"), {
            code: 3040,
          });
        if (options.noProgress)
          return {
            choices: [
              {
                message: { role: "assistant", content: "Still considering the release." },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          };
        const results = data.messages?.filter((message) => message.role === "tool") ?? [];
        const turn = results.length + 1;
        const last = results.at(-1)?.content;
        const previous =
          typeof last === "string" ? (JSON.parse(last) as { revision?: string }) : {};
        let name: string;
        let args: Record<string, unknown>;
        if (!judging) {
          if (finishingInvestigation) {
            expect(data.tools?.map((entry) => entry.function?.name).sort()).toEqual([
              "finish_investigation",
              "report_blocker",
            ]);
            name = "finish_investigation";
            args = {
              plan: "INERT_ADVISORY_PLAN: preserve the observed build and split archive preparation from publication.",
              evidencePaths: [request.workflowPath],
            };
          } else if (options.investigationHandoff && draftCalls <= 12) {
            name = "read_file";
            args = { path: request.workflowPath };
          } else if (options.blocked) {
            name = "report_blocker";
            args = { reason: "Inspect the custom release inputs before continuing." };
          } else if (turn === 1) {
            name = "list_directory";
            args = { path: "" };
          } else if (turn === 2) {
            name = "read_file";
            args = { path: "package.json" };
          } else if (turn === 3) {
            name = "read_file";
            args = { path: request.workflowPath };
          } else if (turn === 4) {
            name = "stage_file";
            args = {
              path: request.workflowPath,
              expectedRevision: previous.revision,
              content: proposed,
            };
          } else if (options.multiFile && turn === 5) {
            name = "read_file";
            args = { path: helperPath };
          } else if (options.multiFile && turn === 6) {
            name = "stage_file";
            args = {
              path: helperPath,
              expectedRevision: previous.revision,
              content: helperContent,
            };
          } else {
            name = "submit_changes";
            args = { summary: "Prepare the release candidate before protected publishing." };
          }
        } else {
          if (turn === 1) {
            name = "inspect_changes";
            args = { path: request.workflowPath, maxChars: 12000 };
          } else if (options.multiFile && turn === 2) {
            name = "inspect_changes";
            args = { path: helperPath, maxChars: 12000 };
          } else if (turn === (options.multiFile ? 3 : 2)) {
            name = "read_file";
            args = { path: "package.json" };
          } else {
            name = "finish_review";
            args = {
              verdict: options.judgeRejects ? "changes_requested" : "pass",
              summary: "The archive publication path was independently inspected.",
              issues: options.judgeRejects ? ["Review the publication conditions."] : [],
            };
          }
        }
        return {
          choices: [
            {
              message: {
                role: "assistant",
                content:
                  options.investigationHandoff && !judging && draftCalls <= 12
                    ? "INERT_INVESTIGATOR_HISTORY"
                    : null,
                ...(options.investigationHandoff && !judging && draftCalls <= 12
                  ? { reasoning_content: "INERT_INVESTIGATOR_CONTEXT" }
                  : {}),
                tool_calls: [
                  {
                    id: `${judging ? "judge" : "draft"}-${turn}`,
                    type: "function",
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
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
      if (init?.method && url.pathname.startsWith("/repos/octo/release/")) {
        gitWrites.push(url.pathname.slice("/repos/octo/release".length));
        if (options.expireAndKillAfterFirstWrite && gitWrites.length === 1) {
          aiReviewEnabled = false;
          await owner.db
            .update(publisherSetupJobs)
            .set({ createdAt: new Date(Date.now() - 25 * 60_000) })
            .where(eq(publisherSetupJobs.organizationId, owner.organizationId));
        }
        if (options.revokeAfterFirstWrite && gitWrites.length === 1)
          await owner.db
            .update(organizationMembers)
            .set({ role: "member" })
            .where(eq(organizationMembers.userId, owner.userId));
      }
      if (url.pathname === "/installation/token" && init?.method === "DELETE") {
        expect(new Headers(init.headers).get("authorization")).toBe(
          "Bearer private-installation-token",
        );
        revokedTokens++;
        return new Response(null, { status: 204 });
      }
      if (/^\/app\/installations\/[^/]+$/.test(url.pathname))
        return Response.json({
          permissions: {
            contents: "write",
            pull_requests: "write",
            workflows: options.writePermissionsMissing ? "read" : "write",
          },
        });
      if (url.pathname.endsWith("/access_tokens")) {
        const body = JSON.parse(String(init?.body));
        expect(body.repositories).toEqual(["release"]);
        if (body.permissions.contents === "write") {
          writeTokens++;
          expect(body.permissions).toEqual({
            contents: "write",
            pull_requests: "write",
            workflows: "write",
          });
          if (options.killBeforePr) aiReviewEnabled = false;
          if (options.revokeBeforePr && writeTokens === 1)
            await owner.db
              .update(organizationMembers)
              .set({ role: "member" })
              .where(eq(organizationMembers.userId, owner.userId));
        } else expect(body.permissions).toEqual({ contents: "read" });
        return Response.json({ token: "private-installation-token" });
      }
      if (url.pathname === "/repos/octo/release")
        return Response.json({ id: 42, full_name: "octo/release", default_branch: "main" });
      if (url.pathname.includes("/git/commits/")) {
        const revision = url.pathname.split("/").at(-1);
        return Response.json({
          sha: revision,
          tree: { sha: revision === "e".repeat(40) ? "f".repeat(40) : SETUP_BASE_SHA },
        });
      }
      if (url.pathname.endsWith("/git/trees") && init?.method === "POST") {
        if (options.tamperAfterTree) {
          const [job] = await owner.db
            .select()
            .from(publisherSetupJobs)
            .where(eq(publisherSetupJobs.organizationId, owner.organizationId));
          if (!job) throw new Error("Missing fixture job");
          const key = publisherSetupPayloadKey(job, "judge");
          const assessment = await env.ARTIFACTS.get(key);
          const body = JSON.parse(await assessment!.text());
          await env.ARTIFACTS.put(key, JSON.stringify({ ...body, digest: "f".repeat(64) }));
        }
        return Response.json({ sha: "f".repeat(40) });
      }
      if (url.pathname.endsWith("/git/commits") && init?.method === "POST")
        return Response.json({ sha: "e".repeat(40) });
      if (url.pathname.includes("/git/trees/")) {
        const sha = url.pathname.split("/").at(-1);
        const tree =
          sha === SETUP_BASE_SHA || sha === "f".repeat(40)
            ? [
                { path: "package.json", type: "blob", mode: "100644", sha: SETUP_BLOB_SHA },
                {
                  path: ".github",
                  type: "tree",
                  mode: "040000",
                  sha: sha === SETUP_BASE_SHA ? "c".repeat(40) : "1".repeat(40),
                },
              ]
            : sha === "c".repeat(40) || sha === "1".repeat(40)
              ? [
                  {
                    path: "workflows",
                    type: "tree",
                    mode: "040000",
                    sha: sha === "c".repeat(40) ? "d".repeat(40) : "2".repeat(40),
                  },
                  ...(sha === "1".repeat(40)
                    ? [{ path: "scripts", type: "tree", mode: "040000", sha: "3".repeat(40) }]
                    : []),
                ]
              : sha === "d".repeat(40) || sha === "2".repeat(40)
                ? [
                    {
                      path: "release.yml",
                      type: "blob",
                      mode: "100644",
                      sha: sha === "d".repeat(40) ? SETUP_BLOB_SHA : "4".repeat(40),
                    },
                  ]
                : [
                    {
                      path: "release-helper.js",
                      type: "blob",
                      mode: "100644",
                      sha: "5".repeat(40),
                    },
                  ];
        return Response.json({ tree, truncated: false });
      }
      if (url.pathname.includes("/git/blobs/"))
        return Response.json({
          sha: SETUP_BLOB_SHA,
          encoding: "base64",
          size: PACKAGE_CONTEXT.length,
          content: btoa(PACKAGE_CONTEXT),
        });
      if (url.pathname.includes("/git/ref/heads/")) {
        if (!url.pathname.endsWith("/main"))
          return branchHead
            ? Response.json({ object: { sha: branchHead } })
            : Response.json({}, { status: 404 });
        headCalls++;
        return Response.json({
          object: { sha: options.staleBeforePr && headCalls > 1 ? "9".repeat(40) : SETUP_BASE_SHA },
        });
      }
      if (url.pathname.endsWith("/pulls")) {
        if (init?.method === "POST") {
          pullRequestsCreated++;
          const body = JSON.parse(String(init.body));
          expect(body.draft).toBe(true);
          prBranch = body.head;
          prBody = body.body;
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
      if (
        url.pathname.endsWith("/git/refs") ||
        (url.pathname.includes("/git/refs/heads/") && init?.method === "PATCH")
      ) {
        branchHead = JSON.parse(String(init?.body)).sha;
        return Response.json({});
      }
      if (url.pathname.includes("/compare/"))
        return Response.json({
          files: [
            { filename: request.workflowPath },
            ...(options.multiFile ? [{ filename: helperPath }] : []),
          ],
        });
      if (url.pathname.includes("/contents/")) {
        if (init?.method === "PUT") {
          branchHead = "e".repeat(40);
          return Response.json({});
        }
        const path = decodeURIComponent(url.pathname.split("/contents/")[1] ?? "");
        const current = url.searchParams.get("ref") === "e".repeat(40);
        const content =
          path === helperPath ? helperContent : current ? proposed : SETUP_ORIGINAL_WORKFLOW;
        return Response.json({
          type: "file",
          path,
          sha: path === helperPath ? "5".repeat(40) : current ? "4".repeat(40) : SETUP_BLOB_SHA,
          encoding: "base64",
          size: content.length,
          content: btoa(content),
        });
      }
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
    writeTokenCount: () => writeTokens,
    revokedTokenCount: () => revokedTokens,
    pullRequestBody: () => prBody,
    helperPath,
    helperContent,
    gitWrites,
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
    { options: { staleBeforePr: true }, code: "proposal_stale", draftCalls: 5, judgeCalls: 3 },
    {
      options: { revokeBeforePr: true },
      code: "setup_access_changed",
      draftCalls: 5,
      judgeCalls: 3,
    },
    { options: { blocked: true }, code: "setup_agent_blocked", draftCalls: 1, judgeCalls: 0 },
    { options: { killBeforePr: true }, code: "setup_ai_unavailable", draftCalls: 5, judgeCalls: 3 },
  ])("setup failure $code never opens a PR", async ({ options, code, draftCalls, judgeCalls }) => {
    const {
      owner,
      request,
      testEnv,
      counts,
      prCount,
      gitWrites,
      writeTokenCount,
      revokedTokenCount,
    } = await fixture(options);
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
    expect(gitWrites).toEqual([]);
    expect(revokedTokenCount()).toBe(writeTokenCount());
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
  test("only pull request creation mints a write token, revoked once the PR exists", async () => {
    const {
      owner,
      request,
      testEnv,
      prCount,
      writeTokenCount,
      revokedTokenCount,
      pullRequestBody,
    } = await fixture();
    const job = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      request,
    );
    await runPublisherSetupDraftJob(testEnv, job.id, async (_stage, operation) => operation());
    expect((await getPublisherSetupJob(owner.db, job.id))?.status).toBe("ready");
    expect(prCount()).toBe(1);
    expect(writeTokenCount()).toBe(1);
    expect(revokedTokenCount()).toBe(1);
    expect(pullRequestBody()).toContain(`Create the \`${request.environment}\` GitHub Environment`);
  });
  test("once PR writes start, the time wall and killswitch cannot fail the job or its result", async () => {
    const { owner, request, testEnv, prCount, gitWrites, revokedTokenCount } = await fixture({
      expireAndKillAfterFirstWrite: true,
    });
    const job = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      request,
    );
    await runPublisherSetupDraftJob(testEnv, job.id, async (_stage, operation) => operation());
    expect(gitWrites.length).toBeGreaterThan(1);
    expect(prCount()).toBe(1);
    expect(revokedTokenCount()).toBe(1);
    const finished = await readPublisherSetupDraftJob(
      testEnv,
      job.id,
      owner.organizationId,
      owner.userId,
    );
    expect(finished).toMatchObject({ status: "ready", failure: null });
    expect(finished?.result?.pullRequest.number).toBe(81);
  });
  test("access revoked after the first PR write stops the remaining writes", async () => {
    const { owner, request, testEnv, prCount, gitWrites, revokedTokenCount } = await fixture({
      revokeAfterFirstWrite: true,
    });
    const job = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      request,
    );
    await runPublisherSetupDraftJob(testEnv, job.id, async (_stage, operation) => operation());
    expect(gitWrites).toHaveLength(1);
    expect(prCount()).toBe(0);
    expect(revokedTokenCount()).toBe(1);
    expect((await getPublisherSetupJob(owner.db, job.id))?.failureJson?.code).toBe(
      "setup_access_changed",
    );
  });
  test("an organization can have at most two drafts in progress", async () => {
    const { owner, app, request, binding } = await fixture();
    const create = vi.fn(async (_options: unknown) => ({}));
    const envOverride = {
      ...binding,
      PUBLISHER_SETUP_WORKFLOW: { create } as unknown as Bindings["PUBLISHER_SETUP_WORKFLOW"],
    };
    const draft = () =>
      call(app, "POST", "/api/v1/github-app/setup/draft", { body: request, envOverride });
    const stale = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      request,
    );
    await owner.db
      .update(publisherSetupJobs)
      .set({ status: "running", createdAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(publisherSetupJobs.id, stale.id));
    const first = await draft();
    expect(first.status).toBe(202);
    expect((await draft()).status).toBe(202);
    const refused = await draft();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "setup_jobs_busy" });
    expect(create).toHaveBeenCalledTimes(2);
    expect(
      await owner.db
        .select()
        .from(publisherSetupJobs)
        .where(eq(publisherSetupJobs.organizationId, owner.organizationId)),
    ).toHaveLength(3);
    const { job } = (await first.json()) as { job: PublisherSetupDraftJob };
    await updatePublisherSetupJob(owner.db, job.id, {
      status: "failed",
      failureJson: { code: "setup_cancelled", message: "Cancelled." },
    });
    expect((await draft()).status).toBe(202);
  });
  test("cancel is creator scoped and stops a pending job before model work or GitHub writes", async () => {
    const { owner, request, app, binding, testEnv, counts, prCount } = await fixture();
    const job = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      request,
    );
    await env.ARTIFACTS.put(publisherSetupPayloadKey(job, "source"), SETUP_ORIGINAL_WORKFLOW);
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
    const path = `/api/v1/github-app/setup/draft-jobs/${job.id}/cancel`;
    expect(
      (
        await call(otherApp, "POST", path, {
          activeOrganizationId: owner.organizationId,
          envOverride: binding,
        })
      ).status,
    ).toBe(404);
    expect((await getPublisherSetupJob(owner.db, job.id))?.status).toBe("queued");
    const cancelled = await call(app, "POST", path, { envOverride: binding });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({
      job: { status: "failed", failure: { code: "setup_cancelled" }, result: null },
    });
    expect(await env.ARTIFACTS.get(publisherSetupPayloadKey(job, "source"))).toBeNull();
    await runPublisherSetupDraftJob(testEnv, job.id, async (_stage, operation) => operation());
    expect(counts()).toEqual({ draftCalls: 0, judgeCalls: 0 });
    expect(prCount()).toBe(0);
  });
  test("once pull request creation starts, cancel leaves the job running", async () => {
    const { owner, request, app, binding } = await fixture();
    const job = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      request,
    );
    await updatePublisherSetupJob(owner.db, job.id, { status: "running", stage: "create_pr" });
    const response = await call(
      app,
      "POST",
      `/api/v1/github-app/setup/draft-jobs/${job.id}/cancel`,
      { envOverride: binding },
    );
    expect(await response.json()).toMatchObject({
      job: { status: "running", stage: "create_pr" },
    });
    expect((await getPublisherSetupJob(owner.db, job.id))?.status).toBe("running");
  });
  test("cancelling a finished job keeps its pull request result", async () => {
    const { owner, request, app, binding, testEnv } = await fixture();
    const job = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      request,
    );
    await runPublisherSetupDraftJob(testEnv, job.id, async (_stage, operation) => operation());
    const response = await call(
      app,
      "POST",
      `/api/v1/github-app/setup/draft-jobs/${job.id}/cancel`,
      { envOverride: binding },
    );
    expect(await response.json()).toMatchObject({
      job: { status: "ready", result: { pullRequest: { number: expect.any(Number) } } },
    });
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
    expect(finished?.result?.originalContent).toBe(SETUP_ORIGINAL_WORKFLOW);
  });
  test("blocked feedback stays private while D1 keeps only its static failure", async () => {
    const { owner, request, testEnv, counts, prCount } = await fixture({ blocked: true });
    const row = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      request,
    );
    await runPublisherSetupDraftJob(testEnv, row.id, async (_name, operation) => operation());
    const stored = await getPublisherSetupJob(owner.db, row.id);
    expect(stored?.failureJson?.code).toBe("setup_agent_blocked");
    expect(JSON.stringify(stored?.failureJson)).not.toContain("Inspect the custom release inputs");
    const result = await readPublisherSetupDraftJob(
      testEnv,
      row.id,
      owner.organizationId,
      owner.userId,
    );
    expect(result?.feedback).toEqual(["Inspect the custom release inputs before continuing."]);
    expect(counts()).toEqual({ draftCalls: 1, judgeCalls: 0 });
    expect(prCount()).toBe(0);
  });
  test("an unproductive agent stops at its bounded turn count without opening a PR", async () => {
    const { owner, request, testEnv, counts, prCount } = await fixture({ noProgress: true });
    const row = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      request,
    );
    await runPublisherSetupDraftJob(testEnv, row.id, async (_name, operation) => operation());
    expect((await getPublisherSetupJob(owner.db, row.id))?.failureJson?.code).toBe(
      "setup_agent_turn_limit",
    );
    expect(counts()).toEqual({ draftCalls: SETUP_DRAFT_MAX_TURNS, judgeCalls: 0 });
    expect(prCount()).toBe(0);
  });
  test("the cumulative wall-clock limit survives an absent first-turn checkpoint", async () => {
    const { owner, request, testEnv, counts } = await fixture();
    const row = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      request,
    );
    await owner.db
      .update(publisherSetupJobs)
      .set({ createdAt: new Date(Date.now() - 21 * 60_000) })
      .where(eq(publisherSetupJobs.id, row.id));
    const checkpoint = vi.fn(async (_name: string, operation: () => Promise<boolean>) =>
      operation(),
    );
    await runPublisherSetupDraftJob(testEnv, row.id, checkpoint);
    expect((await getPublisherSetupJob(owner.db, row.id))?.failureJson?.code).toBe(
      "setup_agent_budget_exceeded",
    );
    expect(checkpoint).not.toHaveBeenCalled();
    expect(counts()).toEqual({ draftCalls: 0, judgeCalls: 0 });
  });
  test("the first draft turn reports and persists the D1 creation clock after source-read time", async () => {
    const { owner, request, testEnv } = await fixture({ blocked: true });
    const row = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      request,
    );
    await owner.db
      .update(publisherSetupJobs)
      .set({ createdAt: new Date(Date.now() - 2 * 60_000) })
      .where(eq(publisherSetupJobs.id, row.id));
    const stored = await getPublisherSetupJob(owner.db, row.id);
    await runPublisherSetupDraftJob(testEnv, row.id, async (_name, operation) => operation());
    const agent = await env.ARTIFACTS.get(publisherSetupPayloadKey(row, "draft-agent"));
    const state = JSON.parse(await agent!.text()) as { progress: { startedAt: number } };
    expect(state.progress.startedAt).toBe(stored!.createdAt.getTime());
    const calls = vi.mocked(testEnv.AI.run).mock.calls as unknown as [
      string,
      { messages: { role: string; content: string }[] },
    ][];
    const guidance = calls[0]?.[1].messages.at(-1);
    expect(guidance?.role).toBe("user");
    const remaining = Number(/"remainingSeconds":(\d+)/.exec(guidance?.content ?? "")?.[1]);
    // Drafting gets 12 of the 20 minutes (judge and PR creation are reserved); two have passed.
    expect(remaining).toBeLessThanOrEqual(10 * 60);
    expect(remaining).toBeGreaterThan(9 * 60);
  });
  test("each Git mutation rechecks the independent assessment digest", async () => {
    const { owner, request, testEnv, prCount, gitWrites } = await fixture({
      multiFile: true,
      tamperAfterTree: true,
    });
    const row = await createPublisherSetupJob(
      owner.db,
      owner.organizationId,
      owner.userId,
      request,
    );
    await runPublisherSetupDraftJob(testEnv, row.id, async (_name, operation) => operation());
    expect((await getPublisherSetupJob(owner.db, row.id))?.failureJson?.code).toBe(
      "setup_judge_mismatch",
    );
    expect(gitWrites).toEqual(["/git/trees"]);
    expect(prCount()).toBe(0);
  });
  test.each([
    {
      judgeRejects: false,
      transientDraft: false,
      permanentDraft: false,
      uncertainPr: false,
      multiFile: false,
    },
    {
      judgeRejects: true,
      transientDraft: false,
      permanentDraft: false,
      uncertainPr: false,
      multiFile: false,
    },
    {
      judgeRejects: false,
      transientDraft: true,
      permanentDraft: false,
      uncertainPr: false,
      multiFile: false,
    },
    {
      judgeRejects: false,
      transientDraft: false,
      permanentDraft: true,
      uncertainPr: false,
      multiFile: false,
    },
    {
      judgeRejects: false,
      transientDraft: false,
      permanentDraft: false,
      uncertainPr: true,
      multiFile: false,
    },
    {
      judgeRejects: false,
      transientDraft: false,
      permanentDraft: false,
      uncertainPr: true,
      multiFile: true,
    },
  ])("real Workflow checkpoints keep source private for %j", async (options) => {
    const judgeRejects = options.judgeRejects;
    const { app, owner, request, binding, counts, prCount, testEnv, helperPath, helperContent } =
      await fixture(options);
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
      expect(counts()).toEqual({
        draftCalls: options.multiFile ? 7 : options.transientDraft ? 6 : 5,
        judgeCalls: options.multiFile ? 4 : 3,
      });
      const calls = vi.mocked(testEnv.AI.run).mock.calls as unknown as [
        string,
        { tools: { function: { name: string } }[] },
        { extraHeaders: Record<string, string> },
      ][];
      const draftHeaders = calls
        .filter(([, input]) => !input.tools.some((tool) => tool.function.name === "finish_review"))
        .map(([, , options]) => options.extraHeaders["x-session-affinity"]);
      const judgeHeaders = calls
        .filter(([, input]) => input.tools.some((tool) => tool.function.name === "finish_review"))
        .map(([, , options]) => options.extraHeaders["x-session-affinity"]);
      expect(new Set(draftHeaders).size).toBe(1);
      expect(new Set(judgeHeaders).size).toBe(1);
      expect(draftHeaders[0]).toMatch(/^[a-f0-9]{64}$/);
      expect(judgeHeaders[0]).toMatch(/^[a-f0-9]{64}$/);
      expect(draftHeaders[0]).not.toBe(judgeHeaders[0]);
      for (const [, , options] of calls) {
        expect(options.extraHeaders).toMatchObject({
          "cf-aig-skip-cache": "true",
          "cf-aig-collect-log-payload": "false",
          "cf-aig-max-attempts": "1",
        });
        expect(JSON.stringify(options.extraHeaders)).not.toContain(job.id);
        expect(JSON.stringify(options.extraHeaders)).not.toContain(request.repositoryFullName);
        expect(JSON.stringify(options.extraHeaders)).not.toContain(owner.userId);
      }
      for (const name of ["fetch_source", "draft-01", "validate", "judge-01"] as const)
        expect(await state.instance.waitForStepResult({ name })).toEqual({
          jobId: job.id,
          done: name !== "draft-01" && name !== "judge-01",
        });
      expect(await state.instance.getOutput()).toEqual({ jobId: job.id });
      const draftState = await env.ARTIFACTS.get(
        publisherSetupPayloadKey(
          { id: job.id, organizationId: owner.organizationId },
          "draft-agent",
        ),
      );
      const draftAgent = JSON.parse((await draftState?.text()) ?? "null") as {
        cacheSessionId: string;
        progress: { startedAt: number; inputTokens: number; turns: number };
      };
      expect(JSON.stringify(draftAgent)).toContain("context-only-fixture");
      const judgeState = await env.ARTIFACTS.get(
        publisherSetupPayloadKey(
          { id: job.id, organizationId: owner.organizationId },
          "judge-agent",
        ),
      );
      const judgeAgent = JSON.parse((await judgeState?.text()) ?? "null") as typeof draftAgent;
      const cacheScope = await sha256Hex(`publisher-setup:${job.id}`);
      expect(draftAgent.cacheSessionId).toBe(cacheScope);
      expect(judgeAgent.cacheSessionId).toBe(cacheScope);
      expect(judgeAgent.progress.startedAt).toBe(draftAgent.progress.startedAt);
      expect(draftAgent.progress.inputTokens).toBe(draftAgent.progress.turns * 10);
      expect(judgeAgent.progress.inputTokens).toBe(
        draftAgent.progress.inputTokens + judgeAgent.progress.turns * 10,
      );
      expect(JSON.stringify(judgeAgent)).toContain("context-only-fixture");
      expect(JSON.stringify(finished)).not.toContain("context-only-fixture");
      expect(JSON.stringify(finished)).not.toContain(cacheScope);
      expect(JSON.stringify(finished)).not.toContain("cacheSessionId");
      const source = await env.ARTIFACTS.get(
        publisherSetupPayloadKey({ id: job.id, organizationId: owner.organizationId }, "source"),
      );
      expect(await source?.text()).not.toContain("context-only-fixture");
      if (judgeRejects) {
        expect(finished?.result).toBeNull();
        expect(prCount()).toBe(0);
      } else {
        expect(finished?.result?.originalContent).toBe(SETUP_ORIGINAL_WORKFLOW);
        if (options.multiFile)
          expect(finished?.result?.proposal.supportingFiles).toEqual([
            { path: helperPath, content: helperContent, originalSha: null, originalContent: null },
          ]);
        expect(finished?.result?.pullRequest).toMatchObject({
          number: 81,
          url: "https://github.com/octo/release/pull/81",
        });
        expect(prCount()).toBe(1);
        expect(await state.instance.waitForStepResult({ name: "create_pr" })).toEqual({
          jobId: job.id,
          done: true,
        });
        if (options.uncertainPr) {
          const previousCallCount = calls.length;
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
          const repeatedCalls = calls.slice(previousCallCount);
          expect(repeatedCalls).toHaveLength(options.multiFile ? 11 : 8);
          for (const [, , options] of repeatedCalls)
            expect([draftHeaders[0], judgeHeaders[0]]).not.toContain(
              options.extraHeaders["x-session-affinity"],
            );
          const repeatAgent = await env.ARTIFACTS.get(
            publisherSetupPayloadKey(repeat, "draft-agent"),
          );
          expect(JSON.parse(await repeatAgent!.text()).cacheSessionId).toBe(
            await sha256Hex(`publisher-setup:${repeat.id}`),
          );
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
  test("real Workflow hands bounded investigation to fresh implementation context and an independent judge", async () => {
    const { app, owner, request, binding, counts, prCount } = await fixture({
      investigationHandoff: true,
    });
    const realBinding = workflowBinding();
    const state: { instance?: Awaited<ReturnType<typeof introspectWorkflowInstance>> } = {};
    try {
      const queued = await call(app, "POST", "/api/v1/github-app/setup/draft", {
        body: request,
        envOverride: {
          ...binding,
          PUBLISHER_SETUP_WORKFLOW: {
            create: async (options: { id: string; params: { jobId: string } }) => {
              state.instance = await introspectWorkflowInstance(realBinding, options.id);
              await state.instance.modify(async (modify) => {
                await modify.disableRetryDelays();
              });
              return realBinding.create(options);
            },
          } as unknown as Bindings["PUBLISHER_SETUP_WORKFLOW"],
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
      expect(finished?.status).toBe("ready");
      expect(finished?.result?.pullRequest.number).toBe(81);
      expect(counts()).toEqual({ draftCalls: 18, judgeCalls: 3 });
      expect(prCount()).toBe(1);
      const row = await getPublisherSetupJob(owner.db, job.id);
      const draftObject = await env.ARTIFACTS.get(
        publisherSetupPayloadKey(
          { id: job.id, organizationId: owner.organizationId },
          "draft-agent",
        ),
      );
      const draft = JSON.parse(await draftObject!.text()) as {
        messages: unknown[];
        handoff: { plan: { plan: string }; conversation: { role: string }[] };
        progress: { turns: number; inputTokens: number; outputTokens: number; startedAt: number };
      };
      expect(draft.handoff.plan.plan).toContain("INERT_ADVISORY_PLAN");
      expect(JSON.stringify(draft.handoff.conversation)).toContain("INERT_INVESTIGATOR_HISTORY");
      expect(JSON.stringify(draft.handoff.conversation)).toContain("INERT_INVESTIGATOR_CONTEXT");
      expect(draft.handoff.conversation.filter((message) => message.role === "tool")).toHaveLength(
        13,
      );
      expect(draft.progress).toEqual({
        turns: 18,
        inputTokens: 180,
        outputTokens: 180,
        startedAt: row!.createdAt.getTime(),
      });
      for (const marker of ["INERT_INVESTIGATOR_HISTORY", "INERT_INVESTIGATOR_CONTEXT"])
        expect(JSON.stringify(draft.messages)).not.toContain(marker);
      expect(JSON.stringify(draft.messages)).toContain("INERT_ADVISORY_PLAN");
      const judgeObject = await env.ARTIFACTS.get(
        publisherSetupPayloadKey(
          { id: job.id, organizationId: owner.organizationId },
          "judge-agent",
        ),
      );
      const judge = JSON.parse(await judgeObject!.text()) as {
        messages: unknown[];
        progress: { turns: number; inputTokens: number; outputTokens: number; startedAt: number };
        handoff?: unknown;
      };
      expect(judge).not.toHaveProperty("handoff");
      expect(judge.progress).toEqual({
        turns: 3,
        inputTokens: 210,
        outputTokens: 210,
        startedAt: row!.createdAt.getTime(),
      });
      for (const marker of [
        "INERT_INVESTIGATOR_HISTORY",
        "INERT_INVESTIGATOR_CONTEXT",
        "INERT_ADVISORY_PLAN",
      ])
        expect(JSON.stringify(judge.messages)).not.toContain(marker);
      for (let turn = 1; turn <= 18; turn++)
        expect(
          await state.instance.waitForStepResult({
            name: `draft-${String(turn).padStart(2, "0")}`,
          }),
        ).toEqual({ jobId: job.id, done: turn === 18 });
      for (let turn = 1; turn <= 3; turn++)
        expect(
          await state.instance.waitForStepResult({
            name: `judge-${String(turn).padStart(2, "0")}`,
          }),
        ).toEqual({ jobId: job.id, done: turn === 3 });
      for (const name of ["fetch_source", "validate", "create_pr"])
        expect(await state.instance.waitForStepResult({ name })).toEqual({
          jobId: job.id,
          done: true,
        });
      expect(await state.instance.getOutput()).toEqual({ jobId: job.id });
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
      let done: boolean;
      try {
        done = await operation();
      } catch (error) {
        if (!retryModel) throw error;
        done = await operation();
      }
      outputs.push({ jobId: job.id, done });
      return done;
    });
    expect(counts()).toEqual({ draftCalls: 6, judgeCalls: 3 });
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
    for (const payload of [
      "source",
      "candidate",
      "judge",
      "result",
      "draft-agent",
      "judge-agent",
    ] as const)
      expect(await realBucket.get(publisherSetupPayloadKey(job, payload))).toBeNull();
    expect(counts()).toEqual({ draftCalls: 5, judgeCalls: 0 });
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
