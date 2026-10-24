import { createDb, type AppDb } from "../../db/client";
import {
  claimScanDetonation,
  completeScanDetonation,
  releaseScanDetonationClaim,
  getDetonationTarget,
  requestScanDetonation,
  type DetonationTarget,
} from "../../db/scan-detonations";
import { getStagedAdapter } from "../ecosystems";
import { isRecord } from "../platform/guards";
import {
  describeOperationalError,
  durationMsSince,
  emitOperationalEvent,
} from "../platform/observability";
import { classifyDetonation } from "./classify";
import { fetchGateReleaseFiles } from "./gate-artifacts";
import {
  distributionFilename,
  readPyPiProvenance,
  selectPyPiDetonationArtifacts,
  type PyPiProvenanceArtifact,
} from "./pypi";
import { parseHarnessReport, parsePrepareInstall } from "./report";
import type { DetonationRunOutput } from "./sandbox-do";
import type { StagedArchiveResult } from "../ecosystems/package-adapter";
import type {
  DetonationArtifact,
  DetonationErrorCode,
  DetonationResult,
  HarnessCoverage,
  PyPiDetonationFile,
} from "./types";

const DETONATION_FLAG = "detonation-sandbox";

/**
 * Larger tarballs are skipped rather than truncated: detonating part of a
 * package proves nothing. The cap also keeps the bytes inside a single RPC
 * message on their way to the container.
 */
const MAX_DETONATION_TARBALL_BYTES = 16 * 1024 * 1024;

export interface DetonationQueueMessage {
  kind: "detonation";
  organizationId: string;
  scanId: string;
  runId: string;
}

export function isDetonationMessage(message: unknown): message is DetonationQueueMessage {
  return isRecord(message) && message.kind === "detonation";
}

/**
 * Beta and default off. Without the container binding the flag is moot; a
 * flag-evaluation failure reads as off so it can never fail a scan.
 */
export async function detonationEnabled(
  env: Cloudflare.Env,
  organizationId: string,
): Promise<boolean> {
  if (!env.DETONATION_SANDBOX || !env.FLAGS) return false;
  try {
    return await env.FLAGS.getBooleanValue(DETONATION_FLAG, false, {
      targetingKey: organizationId,
      organizationId,
    });
  } catch {
    return false;
  }
}

/**
 * Record a queued run and dispatch it. Returns false when a live run already
 * holds the scan. Callers check `detonationEnabled` and scan ownership first.
 */
export async function requestDetonation(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext,
  db: AppDb,
  input: { scanId: string; organizationId: string; requestedByUserId: string | null },
): Promise<boolean> {
  const runId = crypto.randomUUID();
  const queued = await requestScanDetonation(db, { ...input, runId, now: new Date() });
  if (!queued) return false;
  const message: DetonationQueueMessage = {
    kind: "detonation",
    organizationId: input.organizationId,
    scanId: input.scanId,
    runId,
  };
  if (env.DETONATION_QUEUE) await env.DETONATION_QUEUE.send(message);
  else executionCtx.waitUntil(executeDetonationJob(env, executionCtx, message, db));
  return true;
}

/** Called after a staged scan completes; never throws into the scan job. */
export async function maybeRequestDetonationAfterScan(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext,
  db: AppDb,
  input: { scanId: string; organizationId: string; actorUserId: string },
): Promise<void> {
  try {
    if (!(await detonationEnabled(env, input.organizationId))) return;
    await requestDetonation(env, executionCtx, db, {
      scanId: input.scanId,
      organizationId: input.organizationId,
      requestedByUserId: null,
    });
  } catch (err) {
    emitOperationalEvent("warn", "detonation.request.failed", {
      scanId: input.scanId,
      organizationId: input.organizationId,
      error: describeOperationalError(err),
    });
  }
}

function parseJsonText(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readPinnedSha256(summaryJson: unknown): string | null {
  if (!isRecord(summaryJson) || !isRecord(summaryJson.stagedPublish)) return null;
  const sha = summaryJson.stagedPublish.artifactSha256;
  return typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha) ? sha : null;
}

function emptyResult(
  status: DetonationResult["status"],
  errorCode: DetonationErrorCode | null,
): DetonationResult {
  return {
    status,
    signals: [],
    coverage: null,
    steps: [],
    egress: [],
    truncated: false,
    errorCode,
  };
}

export const MAX_DETONATION_JOB_ATTEMPTS = 3;

/**
 * Runs one queued detonation. Returns "retry" only when no container could be
 * started (the instance cap was reached): nothing ran, so the claim is handed
 * back and the queue tries again later.
 */
export async function executeDetonationJob(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext,
  message: DetonationQueueMessage,
  db: AppDb = createDb(env.DB),
  options: { finalAttempt?: boolean } = { finalAttempt: true },
): Promise<"done" | "retry"> {
  const startedAtMs = Date.now();
  const { scanId, organizationId, runId } = message;
  const claimed = await claimScanDetonation(db, {
    scanId,
    organizationId,
    runId,
    now: new Date(),
  });
  // A superseded run id or a redelivered message: the row belongs to another run.
  if (!claimed) return "done";

  const finish = async (result: DetonationResult, artifactSha256: string | null) => {
    await completeScanDetonation(db, {
      scanId,
      organizationId,
      runId,
      status:
        result.status === "complete"
          ? "complete"
          : result.status === "skipped"
            ? "skipped"
            : "failed",
      result,
      errorCode: result.errorCode,
      artifactSha256,
      now: new Date(),
    });
    emitOperationalEvent(result.errorCode ? "warn" : "info", "detonation.job.completed", {
      scanId,
      organizationId,
      status: result.status,
      errorCode: result.errorCode,
      signalCount: result.signals.length,
      signalIds: result.signals.map((signal) => signal.id),
      syscallTracing: result.coverage?.syscallTracing ?? null,
      durationMs: durationMsSince(startedAtMs),
    });
  };

  try {
    const target = await getDetonationTarget(db, scanId, organizationId);
    if (!target) {
      await finish(emptyResult("skipped", "artifact_unavailable"), null);
      return "done";
    }
    const plan = planDetonation(target);
    if (plan.status === "refused") {
      await finish(plan.result, plan.sha256);
      return "done";
    }
    const { sha256, ecosystem } = plan;
    const namespace = env.DETONATION_SANDBOX;
    if (!namespace) {
      await finish(emptyResult("failed", "container_unavailable"), sha256);
      return "done";
    }

    const acquired =
      plan.kind === "pypi_gate"
        ? await acquirePyPiGateFiles(env, db, plan)
        : await acquireNpmStageTarball(env, executionCtx, db, plan);
    if (acquired.status === "refused") {
      await finish(acquired.result, sha256);
      return "done";
    }
    const { artifacts } = acquired;

    const sandbox = namespace.get(namespace.idFromName(`${scanId}:${runId}`));
    const output = await acquired.invoke(sandbox);
    if (
      output.errorCode === "container_unavailable" &&
      output.egress.length === 0 &&
      !options.finalAttempt
    ) {
      await releaseScanDetonationClaim(db, { scanId, organizationId, runId });
      return "retry";
    }
    const report = parseHarnessReport(parseJsonText(output.reportJson));
    const errorCode: DetonationErrorCode | null =
      output.errorCode ?? (report ? null : "harness_report_invalid");
    const installState =
      report?.coverage.dependencyInstall ?? parsePrepareInstall(parseJsonText(output.prepareJson));
    const coverage: HarnessCoverage | null =
      report?.coverage ??
      (installState
        ? {
            syscallTracing: false,
            runtimeHooks: false,
            dependencyInstall: installState,
            stepsSkipped: 0,
            exercise: "load" as const,
            browserTargeted: false,
          }
        : null);
    // The parent chose what ran; the harness's own claim about it is not used.
    if (coverage) {
      delete coverage.ecosystem;
      if (ecosystem === "pypi") coverage.ecosystem = "pypi";
    }

    await finish(
      {
        // Egress is recorded outside the container, so its signals stand even
        // when the harness failed to report.
        status: errorCode ? "failed" : "complete",
        signals: classifyDetonation(report, output.egress, output.canaryValues),
        coverage,
        steps: report?.steps ?? [],
        egress: output.egress,
        truncated: (report?.truncated ?? false) || output.egressTruncated,
        errorCode,
        ...(artifacts ? { artifacts } : {}),
      },
      sha256,
    );
    return "done";
  } catch (err) {
    emitOperationalEvent("error", "detonation.job.failed", {
      scanId,
      organizationId,
      error: describeOperationalError(err),
      durationMs: durationMsSince(startedAtMs),
    });
    await finish(emptyResult("failed", "container_unavailable"), null).catch(() => undefined);
    return "done";
  }
}

type SandboxStub = ReturnType<NonNullable<Cloudflare.Env["DETONATION_SANDBOX"]>["get"]>;

type RunPlan =
  | { status: "refused"; result: DetonationResult; sha256: string | null }
  | {
      status: "planned";
      kind: "npm_stage";
      ecosystem: "npm";
      sha256: string;
      target: Extract<DetonationTarget, { kind: "npm_stage" }>;
    }
  | {
      status: "planned";
      kind: "pypi_gate";
      ecosystem: "pypi";
      /** The wheel's digest when one runs, else the sdist's; persisted on the row. */
      sha256: string;
      target: Extract<DetonationTarget, { kind: "pypi_gate" }>;
      files: PyPiProvenanceArtifact[];
    };

type Acquired =
  | { status: "refused"; result: DetonationResult }
  | {
      status: "ready";
      artifacts: DetonationArtifact[] | null;
      invoke: (sandbox: SandboxStub) => Promise<DetonationRunOutput>;
    };

/** Which reviewed bytes a run would execute, decided from the scan's own record. */
function planDetonation(target: DetonationTarget): RunPlan {
  if (target.kind === "npm_stage") {
    const sha256 = readPinnedSha256(target.summaryJson);
    return sha256
      ? { status: "planned", kind: "npm_stage", ecosystem: "npm", sha256, target }
      : { status: "refused", result: emptyResult("skipped", "artifact_unavailable"), sha256: null };
  }
  const provenance = readPyPiProvenance(target.summaryJson);
  if (!provenance) {
    return {
      status: "refused",
      result: emptyResult("skipped", "artifact_unavailable"),
      sha256: null,
    };
  }
  const { wheel, sdist } = selectPyPiDetonationArtifacts(provenance);
  const primary = wheel ?? sdist;
  if (!primary) {
    return {
      status: "refused",
      result: emptyResult("skipped", "platform_unsupported"),
      sha256: null,
    };
  }
  return {
    status: "planned",
    kind: "pypi_gate",
    ecosystem: "pypi",
    sha256: primary.sha256,
    target,
    files: [wheel, sdist].filter((file): file is PyPiProvenanceArtifact => file !== null),
  };
}

function refusedFor(status: "too_large" | "digest_mismatch" | "unavailable"): Acquired {
  const code: DetonationErrorCode =
    status === "too_large"
      ? "artifact_too_large"
      : status === "digest_mismatch"
        ? "artifact_digest_mismatch"
        : "artifact_unavailable";
  return {
    status: "refused",
    result: emptyResult(status === "too_large" ? "skipped" : "failed", code),
  };
}

async function acquireNpmStageTarball(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext,
  db: AppDb,
  plan: Extract<RunPlan, { kind: "npm_stage" }>,
): Promise<Acquired> {
  const { target, sha256 } = plan;
  // Going through the registry keeps an ecosystem without
  // `fetchStagedArchive` from ever being detonated from a stage.
  const adapter = getStagedAdapter("npm");
  const broker = adapter.createBroker(
    { env, executionCtx, db, session: { userId: "" } },
    { organizationId: target.organizationId, registryUrl: target.registryUrl },
  );
  // A missing or changed npm connection surfaces here as a thrown
  // precondition; either way the reviewed bytes cannot be fetched again.
  const archive: StagedArchiveResult = adapter.fetchStagedArchive
    ? await adapter
        .fetchStagedArchive(broker, {
          stageId: target.stageId,
          expectedSha256: sha256,
          maxBytes: MAX_DETONATION_TARBALL_BYTES,
        })
        .catch(() => ({ status: "unavailable" as const }))
        .finally(() => broker.dispose())
    : { status: "unavailable" };
  if (archive.status !== "ok") return refusedFor(archive.status);
  return {
    status: "ready",
    artifacts: null,
    invoke: (sandbox) => sandbox.detonate(archive.bytes),
  };
}

/**
 * The gate's GitHub artifact is downloaded again in this Worker and every
 * selected distribution must hash to the digest the review recorded. The
 * container receives bytes only, never the installation token.
 */
async function acquirePyPiGateFiles(
  env: Cloudflare.Env,
  db: AppDb,
  plan: Extract<RunPlan, { kind: "pypi_gate" }>,
): Promise<Acquired> {
  const { target, files } = plan;
  const fetched = await fetchGateReleaseFiles(env, db, {
    organizationId: target.organizationId,
    gateId: target.gateId,
    wanted: new Map(files.map((file) => [file.path, file.sha256])),
    // A file over the run's cap could never be selected below, so it is not
    // held; an oversize sdist must not cost the wheel its run.
    maxFileBytes: MAX_DETONATION_TARBALL_BYTES,
  }).catch(() => ({ status: "unavailable" as const }));
  if (fetched.status !== "ok") return refusedFor(fetched.status);

  // The wheel (or, without one, the sdist) is what the run is for; the sdist
  // build is dropped first when both do not fit.
  const selected: PyPiProvenanceArtifact[] = [];
  let total = 0;
  for (const file of files) {
    const bytes = fetched.oversized.has(file.path) ? undefined : fetched.files.get(file.path);
    const size = bytes?.byteLength ?? Number.POSITIVE_INFINITY;
    if (total + size > MAX_DETONATION_TARBALL_BYTES) {
      if (selected.length === 0) return refusedFor("too_large");
      continue;
    }
    total += size;
    selected.push(file);
  }
  const payload: PyPiDetonationFile[] = selected.map((file) => ({
    name: distributionFilename(file.path),
    kind: file.kind,
    bytes: fetched.files.get(file.path) as Uint8Array,
  }));
  return {
    status: "ready",
    artifacts: selected.map((file) => ({ path: file.path, sha256: file.sha256, role: file.kind })),
    invoke: (sandbox) => sandbox.detonatePyPi(payload),
  };
}
