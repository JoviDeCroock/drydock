import { and, eq } from "drizzle-orm";
import { createDb } from "../../db/client";
import { organizationMembers, user } from "../../db/schema";
import {
  createPublisherSetupJob,
  deletePublisherSetupJobPayloads,
  getPublisherSetupJob,
  getOwnedPublisherSetupJob,
  publisherSetupPayloadKey,
  updatePublisherSetupJob,
  type PublisherSetupJobRow,
  type PublisherSetupPayloadName,
} from "../../db/publisher-setup-jobs";
import { emailVerificationAvailable } from "../auth";
import { roleCanManageIntegrations } from "../auth/roles";
import { durationMsSince, emitOperationalEvent } from "../platform/observability";
import { listInstallationsForOrganization } from "./persistence";
import {
  createSetupClient,
  PublisherSetupError,
  readSetupWorkflow,
  setupDefaultHead,
} from "./setup-api";
import { readGithubAppConfig } from "./config";
import { describeSetupDraftFailure, setupDraftFailureResponse } from "./setup-draft-errors";
import type {
  PublisherSetupDraftJob,
  PublisherSetupDraftRequest,
  PublisherSetupJudgeAssessment,
  PublisherSetupJobStage,
} from "./setup-types";

interface SetupSource {
  repositoryId: number;
  repositoryFullName: string;
  defaultBranch: string;
  originalSha: string;
  content: string;
}
interface SetupCandidate {
  content: string;
  summary: string;
}
type StepName = Exclude<PublisherSetupJobStage, "queued">;
export type PublisherSetupStepRunner = (
  stage: StepName,
  operation: () => Promise<void>,
  retryModel: boolean,
) => Promise<void>;

export class PublisherSetupRetryError extends Error {
  constructor(public failureCode: string) {
    super(failureCode);
    this.name = "PublisherSetupRetryError";
  }
}

function publicJob(row: PublisherSetupJobRow): PublisherSetupDraftJob {
  return {
    id: row.id,
    status: row.status,
    stage: row.stage,
    request: row.requestJson,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    failure: row.status === "failed" ? row.failureJson : null,
    judge: null,
    result: null,
  };
}

async function readPayload<T>(
  env: Cloudflare.Env,
  job: PublisherSetupJobRow,
  name: PublisherSetupPayloadName,
): Promise<T | null> {
  const object = await env.ARTIFACTS.get(publisherSetupPayloadKey(job, name));
  if (!object || object.size > (name === "result" ? 400_000 : 220_000)) return null;
  try {
    return JSON.parse(await object.text()) as T;
  } catch {
    return null;
  }
}

async function failJob(
  env: Cloudflare.Env,
  job: PublisherSetupJobRow,
  code: string,
  message: string,
): Promise<void> {
  await updatePublisherSetupJob(createDb(env.DB), job.id, {
    status: "failed",
    failureJson: { code, message },
  });
}

async function installationForJob(env: Cloudflare.Env, job: PublisherSetupJobRow) {
  const installations = await listInstallationsForOrganization(
    createDb(env.DB),
    job.organizationId,
  );
  const installation = installations.find(
    (value) => value.id === job.installationRowId && value.status === "active",
  );
  if (!installation)
    throw new PublisherSetupError(
      "setup_access_changed",
      "The GitHub App installation is no longer active for this organization.",
      403,
    );
  return installation;
}

async function activeJob(env: Cloudflare.Env, id: string): Promise<PublisherSetupJobRow | null> {
  const db = createDb(env.DB);
  const job = await getPublisherSetupJob(db, id);
  if (!job || job.status === "failed" || job.status === "ready") return null;
  const [member] = await db
    .select({ role: organizationMembers.role, emailVerified: user.emailVerified })
    .from(organizationMembers)
    .innerJoin(user, eq(user.id, organizationMembers.userId))
    .where(
      and(
        eq(organizationMembers.organizationId, job.organizationId),
        eq(organizationMembers.userId, job.createdByUserId),
      ),
    )
    .limit(1);
  let installationActive = false;
  try {
    await installationForJob(env, job);
    installationActive = true;
  } catch {
    /* Access revocation is terminal for an in-flight job. */
  }
  if (
    !member ||
    !roleCanManageIntegrations(member.role) ||
    (emailVerificationAvailable(env) && !member.emailVerified) ||
    !installationActive
  ) {
    await failJob(
      env,
      job,
      "setup_access_changed",
      "Publisher setup stopped because account, organization, or installation access changed.",
    );
    await deletePublisherSetupJobPayloads(env.ARTIFACTS, job);
    return null;
  }
  const enabled = env.FLAGS
    ? await env.FLAGS.getBooleanValue("ai-review", true, {
        targetingKey: job.organizationId,
        organizationId: job.organizationId,
      }).catch(() => false)
    : false;
  if (!enabled || !env.AI) {
    await failJob(
      env,
      job,
      "setup_ai_unavailable",
      "AI workflow drafting is disabled or unavailable for this organization.",
    );
    return null;
  }
  return job;
}

async function writePayload(
  env: Cloudflare.Env,
  job: PublisherSetupJobRow,
  name: PublisherSetupPayloadName,
  value: unknown,
): Promise<boolean> {
  if (!(await activeJob(env, job.id))) return false;
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).byteLength > (name === "result" ? 400_000 : 220_000))
    throw new PublisherSetupError(
      "setup_result_too_large",
      "The private workflow draft exceeds its storage limit. Use a smaller workflow.",
      409,
    );
  await env.ARTIFACTS.put(publisherSetupPayloadKey(job, name), encoded, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { expiresAt: job.expiresAt.toISOString() },
  });
  if (!(await activeJob(env, job.id))) {
    await deletePublisherSetupJobPayloads(env.ARTIFACTS, job);
    return false;
  }
  return true;
}

export async function enqueuePublisherSetupDraft(
  env: Cloudflare.Env,
  organizationId: string,
  userId: string,
  request: PublisherSetupDraftRequest,
): Promise<PublisherSetupDraftJob> {
  if (!env.PUBLISHER_SETUP_WORKFLOW)
    throw new PublisherSetupError(
      "setup_workflow_unavailable",
      "Workflow drafting is not configured. Ask the operator to deploy the publisher setup Workflow binding.",
      503,
    );
  const db = createDb(env.DB);
  const job = await createPublisherSetupJob(db, organizationId, userId, request);
  try {
    await env.PUBLISHER_SETUP_WORKFLOW.create({ id: job.id, params: { jobId: job.id } });
  } catch {
    await failJob(
      env,
      job,
      "setup_workflow_unavailable",
      "The publisher setup Workflow could not start. Retry in a moment.",
    );
    emitOperationalEvent("warn", "github_app.setup_workflow.dispatch_failed", {
      reason: "workflow_unavailable",
    });
    throw new PublisherSetupError(
      "setup_workflow_unavailable",
      "The publisher setup Workflow could not start. Retry in a moment.",
      503,
    );
  }
  return publicJob(job);
}

export async function readPublisherSetupDraftJob(
  env: Cloudflare.Env,
  id: string,
  organizationId: string,
  userId: string,
): Promise<PublisherSetupDraftJob | null> {
  const db = createDb(env.DB);
  let row = await getOwnedPublisherSetupJob(db, id, organizationId, userId);
  if (!row) return null;
  if ((row.status === "queued" || row.status === "running") && env.PUBLISHER_SETUP_WORKFLOW) {
    let runtimeStatus: string | undefined;
    try {
      const instance = await env.PUBLISHER_SETUP_WORKFLOW.get(row.id);
      runtimeStatus = (await instance.status()).status;
    } catch {
      /* A status lookup outage is not evidence that the Workflow stopped. */
    }
    if (["errored", "terminated", "complete"].includes(runtimeStatus ?? "")) {
      const failed = await updatePublisherSetupJob(db, row.id, {
        status: "failed",
        failureJson: {
          code: "setup_workflow_failed",
          message: "The workflow draft stopped before completing. Start a fresh draft.",
        },
      });
      if (failed) await deletePublisherSetupJobPayloads(env.ARTIFACTS, row);
      // Completion can persist a ready result between the initial read and this check.
      row = await getOwnedPublisherSetupJob(db, id, organizationId, userId);
      if (!row) return null;
    }
  }
  const result = publicJob(row);
  if (row.status === "ready" || row.status === "failed")
    result.judge = await readPayload<PublisherSetupJudgeAssessment>(env, row, "judge");
  if (row.status === "ready") {
    result.result = await readPayload<NonNullable<PublisherSetupDraftJob["result"]>>(
      env,
      row,
      "result",
    );
    if (!result.result || !result.judge || result.judge.verdict !== "pass") {
      result.status = "failed";
      result.result = null;
      result.failure = {
        code: "setup_result_unavailable",
        message: "The private draft result is unavailable. Start a fresh draft.",
      };
    }
  }
  return result;
}

async function runStage(env: Cloudflare.Env, id: string, stage: StepName): Promise<void> {
  const job = await activeJob(env, id);
  if (!job) return;
  if (
    !(await updatePublisherSetupJob(createDb(env.DB), id, {
      status: "running",
      stage,
      failureJson: null,
    }))
  )
    return;
  if (stage === "fetch_source") {
    const installation = await installationForJob(env, job);
    const client = await createSetupClient(
      readGithubAppConfig(env),
      installation.installationId,
      job.requestJson.repositoryFullName,
    );
    if ((await setupDefaultHead(client)) !== job.requestJson.baseSha)
      throw new PublisherSetupError(
        "proposal_stale",
        "The default branch changed. Inspect the repository and create a fresh draft.",
        409,
      );
    const workflow = await readSetupWorkflow(
      client,
      job.requestJson.workflowPath,
      job.requestJson.baseSha,
    );
    await writePayload(env, job, "source", {
      repositoryId: client.repository.id,
      repositoryFullName: client.repository.fullName,
      defaultBranch: client.repository.defaultBranch,
      originalSha: workflow.sha,
      content: workflow.content,
    } satisfies SetupSource);
    return;
  }
  const source = await readPayload<SetupSource>(env, job, "source");
  if (!source)
    throw new PublisherSetupError(
      "setup_result_unavailable",
      "The private workflow source is unavailable. Start a fresh draft.",
      409,
    );
  if (stage === "draft") {
    const { generateSetupCandidate } = await import("./setup-draft");
    const candidate = await generateSetupCandidate(env, job.requestJson, source.content);
    await writePayload(env, job, "candidate", candidate);
    return;
  }
  const candidate = await readPayload<SetupCandidate>(env, job, "candidate");
  if (!candidate)
    throw new PublisherSetupError(
      "setup_result_unavailable",
      "The private workflow draft is unavailable. Start a fresh draft.",
      409,
    );
  const { validateSetupDraft } = await import("./setup-draft");
  if (stage === "validate") {
    validateSetupDraft(source.content, candidate.content, job.requestJson);
    return;
  }
  if (stage === "judge") {
    const { judgeSetupDraft } = await import("./setup-judge");
    const judge = await judgeSetupDraft(env, job.requestJson, source.content, candidate);
    if (!(await writePayload(env, job, "judge", judge))) return;
    if (judge.verdict !== "pass")
      await failJob(
        env,
        job,
        "setup_judge_changes_requested",
        "The independent workflow review requested changes. Read the assessment and start a fresh draft.",
      );
    return;
  }
  const judge = await readPayload<PublisherSetupJudgeAssessment>(env, job, "judge");
  if (!judge || judge.verdict !== "pass")
    throw new PublisherSetupError(
      "setup_judge_changes_requested",
      "The workflow draft has not passed independent review.",
      409,
    );
  validateSetupDraft(source.content, candidate.content, job.requestJson);
  if (!(await activeJob(env, id))) return;
  const { signSetupProposal, setupManualSteps } = await import("./setup-draft");
  const proposal = {
    ...job.requestJson,
    repositoryFullName: source.repositoryFullName,
    repositoryId: source.repositoryId,
    defaultBranch: source.defaultBranch,
    originalSha: source.originalSha,
    ...candidate,
    manualSteps: setupManualSteps(job.requestJson),
    expiresAt: Date.now() + 20 * 60_000,
  };
  const proposalToken = await signSetupProposal(
    readGithubAppConfig(env).stateSecret,
    proposal,
    job.organizationId,
    job.createdByUserId,
  );
  if (
    await writePayload(env, job, "result", {
      proposal,
      proposalToken,
      originalContent: source.content,
    })
  )
    if (
      !(await updatePublisherSetupJob(createDb(env.DB), id, {
        status: "ready",
        stage: "ready",
        failureJson: null,
      }))
    )
      await deletePublisherSetupJobPayloads(env.ARTIFACTS, job);
}

export async function runPublisherSetupDraftJob(
  env: Cloudflare.Env,
  jobId: string,
  runStep: PublisherSetupStepRunner,
): Promise<void> {
  for (const stage of ["fetch_source", "draft", "validate", "judge", "ready"] as const) {
    if (!(await activeJob(env, jobId))) return;
    try {
      await runStep(
        stage,
        async () => {
          const started = Date.now();
          try {
            await runStage(env, jobId, stage);
          } catch (error) {
            const job = await getPublisherSetupJob(createDb(env.DB), jobId);
            if (!job) return;
            if (error instanceof PublisherSetupError) {
              await failJob(env, job, error.code, error.message);
              return;
            }
            const failure = describeSetupDraftFailure(error);
            const response = setupDraftFailureResponse(failure.category);
            emitOperationalEvent("warn", "github_app.setup_draft.failed", {
              model: "@cf/zai-org/glm-5.3-flash",
              durationMs: durationMsSince(started),
              stage,
              ...failure,
            });
            const retryable =
              (stage === "draft" || stage === "judge") &&
              ["rate_limited", "capacity", "provider_unavailable", "timeout"].includes(
                failure.category,
              );
            await updatePublisherSetupJob(createDb(env.DB), jobId, {
              failureJson: { code: response.code, message: response.error },
              ...(retryable ? {} : { status: "failed" }),
            });
            if (retryable) throw new PublisherSetupRetryError(response.code);
          }
        },
        stage === "draft" || stage === "judge",
      );
    } catch {
      const job = await getPublisherSetupJob(createDb(env.DB), jobId);
      if (job)
        await failJob(
          env,
          job,
          job.failureJson?.code ?? "setup_workflow_failed",
          job.failureJson?.message ?? "The workflow draft could not complete. Start a fresh draft.",
        );
      return;
    }
  }
}
