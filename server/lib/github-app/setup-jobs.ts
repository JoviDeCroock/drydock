import { and, eq } from "drizzle-orm";
import { createDb } from "../../db/client";
import { recordScanEvent } from "../../db/events";
import { organizationMembers, user } from "../../db/schema";
import {
  cancelPublisherSetupJob,
  countActivePublisherSetupJobs,
  createPublisherSetupJob,
  deletePublisherSetupJob,
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
import { sha256Hex } from "../platform/crypto-utils";
import { listInstallationsForOrganization } from "./persistence";
import {
  createSetupClient,
  requireSetupWritePermissions,
  createSetupPullRequest,
  PublisherSetupError,
  readSetupWorkflow,
  setupDefaultHead,
} from "./setup-api";
import { readGithubAppConfig } from "./config";
import { describeSetupDraftFailure, setupDraftFailureResponse } from "./setup-draft-errors";
import { AI_MODEL } from "../ai-review";
import {
  SETUP_DRAFT_MAX_TURNS,
  SETUP_JUDGE_MAX_TURNS,
  type DurableSetupAgentState,
} from "./setup-agent";
import { validateSetupAgentChanges } from "./setup-agent-validation";
import type {
  PublisherSetupDraftJob,
  PublisherSetupDraftRequest,
  PublisherSetupJudgeAssessment,
  PublisherSetupJobStage,
} from "./setup-types";

const SETUP_JOB_WALL_MS = 20 * 60_000;
// Each job may spend up to 1.5M input tokens; the hourly rate limit alone allows 20 at once.
const MAX_ACTIVE_JOBS_PER_ORGANIZATION = 2;

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
  supportingFiles: NonNullable<PublisherSetupDraftJob["result"]>["proposal"]["supportingFiles"];
  digest: string;
}
type StepName = Exclude<PublisherSetupJobStage, "queued" | "ready">;
export type PublisherSetupStepRunner = (
  checkpoint: StepName | `draft-${string}` | `judge-${string}`,
  operation: () => Promise<boolean>,
  retrySafeOperation: boolean,
) => Promise<boolean>;

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

function payloadByteLimit(name: PublisherSetupPayloadName): number {
  return name === "source" ? 400_000 : name === "judge" ? 220_000 : 4_194_304;
}

async function readPayload<T>(
  env: Cloudflare.Env,
  job: PublisherSetupJobRow,
  name: PublisherSetupPayloadName,
): Promise<T | null> {
  const object = await env.ARTIFACTS.get(publisherSetupPayloadKey(job, name));
  if (!object || object.size > payloadByteLimit(name)) return null;
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

/**
 * Returns the job while it may continue, failing it when its time, authorization or access
 * has lapsed. Once PR creation starts, a branch or PR may already exist (also from an
 * earlier attempt), so the time wall no longer applies (the step has its own deadline) and
 * the killswitch only gates the first write (`beforePrWrite`); failing later would report a
 * real PR as failed and invite a duplicate. Revoked access still stops every write.
 */
async function activeJob(
  env: Cloudflare.Env,
  id: string,
  beforePrWrite = false,
): Promise<PublisherSetupJobRow | null> {
  const db = createDb(env.DB);
  const job = await getPublisherSetupJob(db, id);
  if (!job || job.status === "failed" || job.status === "ready") return null;
  const creatingPr = job.stage === "create_pr";
  if (!creatingPr && Date.now() - job.createdAt.getTime() > SETUP_JOB_WALL_MS) {
    await failJob(
      env,
      job,
      "setup_agent_budget_exceeded",
      "The setup agent reached its twenty-minute limit. Start a fresh setup or configure this release manually.",
    );
    return null;
  }
  if (job.requestJson.createPullRequest !== true) {
    await failJob(
      env,
      job,
      "setup_authorization_required",
      "Start a fresh setup to authorize creation of the draft pull request.",
    );
    return null;
  }
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
  if (creatingPr && !beforePrWrite) return job;
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
  if (new TextEncoder().encode(encoded).byteLength > payloadByteLimit(name))
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
  // Counting after the insert fails closed when requests race: both may be refused, never both admitted.
  // Jobs older than the wall plus the PR step's retries are dead or finishing, so they never lock an organization out.
  if (
    (await countActivePublisherSetupJobs(
      db,
      organizationId,
      new Date(Date.now() - SETUP_JOB_WALL_MS - 10 * 60_000),
    )) > MAX_ACTIVE_JOBS_PER_ORGANIZATION
  ) {
    await deletePublisherSetupJob(db, job.id);
    throw new PublisherSetupError(
      "setup_jobs_busy",
      "Two workflow drafts are already being prepared for this organization. Wait for one to finish or cancel it, then retry.",
      409,
    );
  }
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
  if (row.status === "failed" && row.failureJson?.code === "setup_agent_blocked") {
    const draft = await readPayload<DurableSetupAgentState>(env, row, "draft-agent");
    const judge = await readPayload<DurableSetupAgentState>(env, row, "judge-agent");
    const reason = judge?.blocked?.reason ?? draft?.blocked?.reason;
    if (reason) result.feedback = [reason];
  }
  if (row.status === "ready" || row.status === "failed")
    result.judge = await readPayload<PublisherSetupJudgeAssessment>(env, row, "judge");
  if (row.status === "ready") {
    result.result = await readPayload<NonNullable<PublisherSetupDraftJob["result"]>>(
      env,
      row,
      "result",
    );
    if (!result.result?.pullRequest || !result.judge || result.judge.verdict !== "pass") {
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

/**
 * Stops a creator's pending job; checks before each GitHub write make the stop binding.
 * Once PR creation has started the job is left to finish, and its current status is returned.
 */
export async function cancelPublisherSetupDraftJob(
  env: Cloudflare.Env,
  id: string,
  organizationId: string,
  userId: string,
): Promise<PublisherSetupDraftJob | null> {
  const db = createDb(env.DB);
  const row = await getOwnedPublisherSetupJob(db, id, organizationId, userId);
  if (!row) return null;
  if (await cancelPublisherSetupJob(db, id)) {
    await deletePublisherSetupJobPayloads(env.ARTIFACTS, row);
    try {
      await (await env.PUBLISHER_SETUP_WORKFLOW?.get(id))?.terminate();
    } catch {
      /* The failed status already stops every later stage; termination only saves model work. */
    }
  }
  return readPublisherSetupDraftJob(env, id, organizationId, userId);
}

async function runStage(env: Cloudflare.Env, id: string, stage: StepName): Promise<boolean> {
  const job = await activeJob(env, id);
  if (!job) return true;
  // A retried PR attempt may follow branch or PR writes from the attempt before it.
  let prWritesMayExist = job.stage === "create_pr";
  if (
    !(await updatePublisherSetupJob(createDb(env.DB), id, {
      status: "running",
      stage,
      failureJson: null,
    }))
  )
    return true;
  if (stage === "fetch_source") {
    const installation = await installationForJob(env, job);
    const config = readGithubAppConfig(env);
    await requireSetupWritePermissions(config, installation.installationId);
    const client = await createSetupClient(
      config,
      installation.installationId,
      job.requestJson.repositoryFullName,
      false,
      true,
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
    return true;
  }
  const source = await readPayload<SetupSource>(env, job, "source");
  if (!source)
    throw new PublisherSetupError(
      "setup_result_unavailable",
      "The private workflow source is unavailable. Start a fresh draft.",
      409,
    );
  const { createSetupAgentState, runSetupAgentTurn, extractSetupAgentCandidate } =
    await import("./setup-agent");
  if (stage === "draft" || stage === "judge") {
    const slot = stage === "draft" ? "draft-agent" : "judge-agent";
    let state = await readPayload<DurableSetupAgentState>(env, job, slot);
    if (!state) {
      const draftState =
        stage === "judge"
          ? await readPayload<DurableSetupAgentState>(env, job, "draft-agent")
          : undefined;
      if (stage === "judge" && !draftState?.submitted)
        throw new PublisherSetupError(
          "setup_result_unavailable",
          "The submitted proposal is unavailable. Start a fresh setup.",
          409,
        );
      state = await createSetupAgentState(
        job.requestJson,
        { path: job.requestJson.workflowPath, sha: source.originalSha, content: source.content },
        stage,
        draftState ?? undefined,
      );
    }
    if (stage === "draft")
      state.progress.startedAt = Math.min(state.progress.startedAt, job.createdAt.getTime());
    if (!state.blocked && !(stage === "draft" ? state.submitted : state.assessment)) {
      const installation = await installationForJob(env, job);
      const client = await createSetupClient(
        readGithubAppConfig(env),
        installation.installationId,
        job.requestJson.repositoryFullName,
        false,
        true,
      );
      if (!(await activeJob(env, id))) return true;
      state.cacheSessionId = await sha256Hex(`publisher-setup:${job.id}`);
      state = await runSetupAgentTurn(env, state, client);
      if (!(await writePayload(env, job, slot, state))) return true;
    }
    if (state.blocked) {
      await failJob(
        env,
        job,
        "setup_agent_blocked",
        "The setup agent needs more repository information or a manual decision. Read its feedback before starting a fresh setup.",
      );
      return true;
    }
    if (stage === "draft" && state.submitted) {
      const candidate = await extractSetupAgentCandidate(state);
      await writePayload(env, job, "candidate", candidate);
      return true;
    }
    if (stage === "judge" && state.assessment) {
      const candidate = await readPayload<SetupCandidate>(env, job, "candidate");
      if (!candidate || state.assessment.digest !== candidate.digest)
        throw new PublisherSetupError(
          "setup_judge_mismatch",
          "The review does not match the submitted files. Start a fresh setup.",
          409,
        );
      const assessment: PublisherSetupJudgeAssessment = { ...state.assessment, model: AI_MODEL };
      if (!(await writePayload(env, job, "judge", assessment))) return true;
      if (assessment.verdict !== "pass")
        await failJob(
          env,
          job,
          "setup_judge_changes_requested",
          "The independent review requested changes. Read the assessment and start a fresh setup.",
        );
      return true;
    }
    return false;
  }
  const draftState = await readPayload<DurableSetupAgentState>(env, job, "draft-agent");
  if (!draftState?.submitted)
    throw new PublisherSetupError(
      "setup_result_unavailable",
      "The submitted proposal is unavailable. Start a fresh setup.",
      409,
    );
  const candidate = await extractSetupAgentCandidate(draftState);
  if (!(await validateSetupAgentChanges(draftState)).valid)
    throw new PublisherSetupError(
      "draft_invalid",
      "The proposed files did not pass the static release checks. Start a fresh setup or configure this release manually.",
      409,
    );
  if (stage === "validate") return true;
  const judge = await readPayload<PublisherSetupJudgeAssessment>(env, job, "judge");
  if (
    !judge ||
    judge.verdict !== "pass" ||
    judge.digest !== candidate.digest ||
    draftState.submitted.digest !== candidate.digest
  )
    throw new PublisherSetupError(
      "setup_judge_changes_requested",
      "The workflow draft has not passed independent review.",
      409,
    );
  if (!(await activeJob(env, id, !prWritesMayExist))) return true;
  const { markdownCodeSpan, setupManualSteps } = await import("./setup-draft");
  const { createPullRequest: _authorization, ...request } = job.requestJson;
  const { digest: _reviewedDigest, ...proposalCandidate } = candidate;
  const proposal = {
    ...request,
    repositoryFullName: source.repositoryFullName,
    repositoryId: source.repositoryId,
    defaultBranch: source.defaultBranch,
    originalSha: source.originalSha,
    ...proposalCandidate,
    manualSteps: setupManualSteps(job.requestJson),
    expiresAt: Date.now() + 20 * 60_000,
  };
  const installation = await installationForJob(env, job);
  const client = await createSetupClient(
    readGithubAppConfig(env),
    installation.installationId,
    job.requestJson.repositoryFullName,
    true,
  );
  let created: Awaited<ReturnType<typeof createSetupPullRequest>>;
  try {
    if (!(await activeJob(env, id, !prWritesMayExist))) return true;
    created = await createSetupPullRequest(
      client,
      { ...proposal, manualSteps: setupManualSteps(job.requestJson, markdownCodeSpan) },
      async () => {
        if (!(await activeJob(env, id, !prWritesMayExist)))
          throw new PublisherSetupError(
            "setup_access_changed",
            "Publisher setup stopped because account, organization, or installation access changed.",
            403,
          );
        prWritesMayExist = true;
        const currentState = await readPayload<DurableSetupAgentState>(env, job, "draft-agent");
        const assessment = await readPayload<PublisherSetupJudgeAssessment>(env, job, "judge");
        if (
          !currentState?.submitted ||
          !assessment ||
          assessment.verdict !== "pass" ||
          assessment.digest !== currentState.submitted.digest ||
          !(await validateSetupAgentChanges(currentState)).valid
        )
          throw new PublisherSetupError(
            "setup_judge_mismatch",
            "The review no longer matches the submitted files. Start a fresh setup.",
            409,
          );
        const current = await extractSetupAgentCandidate(currentState);
        if (current.digest !== candidate.digest || current.digest !== assessment.digest)
          throw new PublisherSetupError(
            "setup_judge_mismatch",
            "The review no longer matches the submitted files. Start a fresh setup.",
            409,
          );
      },
    );
  } finally {
    await client.revokeToken();
  }
  const { created: _created, ...pullRequest } = created;
  await recordScanEvent(createDb(env.DB), {
    idempotencyKey: `publisher-setup:${job.organizationId}:${source.repositoryId}:${pullRequest.number}`,
    organizationId: job.organizationId,
    actorUserId: job.createdByUserId,
    type: "github_app_setup.pr_created",
    metadata: {
      repositoryFullName: source.repositoryFullName,
      environment: request.environment,
      pullRequestNumber: pullRequest.number,
    },
  });
  if (
    await writePayload(env, job, "result", {
      proposal,
      originalContent: source.content,
      pullRequest,
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
  return true;
}

export async function runPublisherSetupDraftJob(
  env: Cloudflare.Env,
  jobId: string,
  runStep: PublisherSetupStepRunner,
): Promise<void> {
  for (const stage of ["fetch_source", "draft", "validate", "judge", "create_pr"] as const) {
    const turns =
      stage === "draft" ? SETUP_DRAFT_MAX_TURNS : stage === "judge" ? SETUP_JUDGE_MAX_TURNS : 1;
    for (let turn = 1; turn <= turns; turn++) {
      if (!(await activeJob(env, jobId))) return;
      const checkpoint =
        stage === "draft" || stage === "judge"
          ? (`${stage}-${String(turn).padStart(2, "0")}` as const)
          : stage;
      let done: boolean;
      try {
        done = await runStep(
          checkpoint,
          async () => {
            const started = Date.now();
            try {
              return await runStage(env, jobId, stage);
            } catch (error) {
              const job = await getPublisherSetupJob(createDb(env.DB), jobId);
              if (!job) return true;
              if (
                stage === "create_pr" &&
                (!(error instanceof PublisherSetupError) || error.code === "github_unavailable")
              ) {
                await updatePublisherSetupJob(createDb(env.DB), jobId, {
                  failureJson: {
                    code: "setup_pull_request_unavailable",
                    message:
                      "GitHub did not confirm the setup pull request. Check the repository's pull requests and setup branches before starting a fresh setup.",
                  },
                });
                emitOperationalEvent("warn", "github_app.setup_pr.failed", {
                  reason: "github_unavailable",
                });
                throw new PublisherSetupRetryError("setup_pull_request_unavailable");
              }
              if (error instanceof PublisherSetupError) {
                await failJob(env, job, error.code, error.message);
                return true;
              }
              const failure = describeSetupDraftFailure(error);
              const response = setupDraftFailureResponse(failure.category);
              emitOperationalEvent("warn", "github_app.setup_draft.failed", {
                model: AI_MODEL,
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
              return true;
            }
          },
          stage === "draft" || stage === "judge" || stage === "create_pr",
        );
      } catch {
        const job = await getPublisherSetupJob(createDb(env.DB), jobId);
        if (job)
          await failJob(
            env,
            job,
            job.failureJson?.code ?? "setup_workflow_failed",
            job.failureJson?.message ??
              "The workflow draft could not complete. Start a fresh setup.",
          );
        return;
      }
      if (done) break;
      if (turn === turns) {
        const job = await getPublisherSetupJob(createDb(env.DB), jobId);
        if (job)
          await failJob(
            env,
            job,
            "setup_agent_turn_limit",
            "The setup agent reached its turn limit before completing. Start a fresh setup or configure this release manually.",
          );
        return;
      }
    }
  }
}
