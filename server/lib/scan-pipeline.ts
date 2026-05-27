import { persistScan, recordScanEvent, type AppDb, type WorkspaceSession } from "../db";
import { runSelectiveAiReview, type AiReview } from "./ai-review";
import type {
  AdapterBroker,
  AdapterConnectionRef,
  AdapterContext,
  PackageAdapter,
} from "./adapters/types";
import { describeOperationalError, durationMsSince, emitOperationalEvent } from "./observability";
import {
  annotateFindingsWithDiffStatus,
  createPackageDiff,
  redactFileRecords,
  redactFindings,
  redactJson,
  summarizePackageJsonDiff,
  DETERMINISTIC_RULES_VERSION,
  type Finding,
} from "./review";
import { computeScanRiskBreakdown } from "./risk";
import type { ScanInput, ScanResult } from "../types";

export interface ScanPipelineOptions extends ScanInput {
  scanId?: string;
  organizationId: string;
}

export interface ScanPipelineContext {
  env: Cloudflare.Env;
  executionCtx: ExecutionContext;
  db: AppDb;
  session: WorkspaceSession;
}

export async function runScanPipeline<TInput, TBroker extends AdapterBroker>(
  context: ScanPipelineContext,
  adapter: PackageAdapter<TInput, TBroker>,
  input: ScanPipelineOptions,
): Promise<ScanResult> {
  const { env, executionCtx, db, session } = context;
  const adapterCtx: AdapterContext = { env, executionCtx, db, session };
  const adapterInput = adapter.parseInput(input);
  const connectionRef: AdapterConnectionRef = { organizationId: input.organizationId };
  const broker = adapter.createBroker(adapterCtx, connectionRef);
  const pipelineStartedAtMs = Date.now();

  try {
    const staged = await adapter.acquireStaged(adapterCtx, adapterInput, broker);
    const baseline = await adapter.acquireBaseline(adapterCtx, adapterInput, broker, staged);

    const fileDiff = createPackageDiff(baseline.artifact?.files ?? [], staged.artifact.files);
    const manifestDiff = redactJson(
      summarizePackageJsonDiff(baseline.artifact?.manifest, staged.artifact.manifest),
    );
    const stagedManifestText =
      staged.artifact.files.find((file) => file.path === "package.json")?.textSample ?? null;

    const adapterFindings = adapter.runFindings({
      staged: staged.artifact,
      baseline: baseline.artifact,
      details: staged.details,
      fileDiff,
      manifestDiff,
      stagedManifestText,
    });
    const ruleFindings = redactFindings(adapterFindings);

    const redactedStagedFiles = redactFileRecords(staged.artifact.files);
    const redactedPreviousFiles = baseline.artifact
      ? redactFileRecords(baseline.artifact.files)
      : [];
    const redactedStagedManifest = redactJson(staged.artifact.manifest ?? null);
    const redactedPreviousManifest = redactJson(baseline.artifact?.manifest ?? null);
    const redactedDetails = redactJson(adapter.summarizeDetails(staged.details));

    const annotatedFindings = annotateFindingsWithDiffStatus(ruleFindings, fileDiff, {
      previousFiles: redactedPreviousFiles,
      stagedFiles: redactedStagedFiles,
    });
    const releaseRuleFindings = stripFindingAnnotations(
      annotatedFindings.filter((finding) => finding.releaseDelta),
    );
    const findingAnnotations = annotatedFindings.map((finding, index) => ({
      findingIndex: index,
      diffStatus: finding.diffStatus,
      releaseDelta: finding.releaseDelta,
    }));

    const scanId = input.scanId || crypto.randomUUID();
    const aiFindings = await maybeRunAiReview({
      env,
      scanId,
      input,
      previousVersionAvailable: baseline.artifact !== null,
      releaseRuleFindings,
      manifestDiff,
      redactedStagedFiles,
      redactedPreviousFiles,
      fileDiff,
    });
    const riskSummary = computeScanRiskBreakdown(annotatedFindings, aiFindings);
    const risk = riskSummary.artifactRisk;

    const safety: ScanResult["safety"] = {
      tokenExposedToSandbox: false,
      directSandboxNetwork: false,
      outboundPolicy:
        "sandbox uses the gateway only for npm staged tarball, published tarball, and package metadata endpoints; parent fetches staged metadata with the organization credential",
      aiInputPolicy:
        "package bytes are untrusted evidence, not instructions; static safety prompt is prefix-cache friendly and AI cannot downgrade deterministic findings",
      fileExplorerPolicy:
        "package file previews are escaped text and secret-redacted before persistence; no package-provided HTML/script/image execution",
    };

    const packageSummary = adapter.describe({
      input: adapterInput,
      staged: staged.artifact,
      details: staged.details,
      baseline: baseline.baseline,
      previous: baseline.artifact,
    });

    const result: ScanResult = {
      id: scanId,
      stageId: input.stageId,
      package: packageSummary,
      baseline: baseline.baseline,
      fileCount: staged.artifact.files.length,
      previousFileCount: baseline.artifact?.files.length ?? 0,
      packageJson: redactedStagedManifest,
      packageJsonDiff: manifestDiff,
      diff: fileDiff,
      ruleFindings,
      aiFindings,
      risk,
      riskSummary,
      safety,
    };

    const reportPayload = {
      version: 1,
      rulesVersion: DETERMINISTIC_RULES_VERSION,
      stageId: input.stageId,
      stagedPublish: redactedDetails,
      package: result.package,
      baseline: baseline.baseline,
      fileCount: result.fileCount,
      previousFileCount: result.previousFileCount,
      packageJson: redactedStagedManifest,
      packageJsonDiff: manifestDiff,
      diff: fileDiff,
      ruleFindings,
      findingAnnotations,
      aiFindings,
      risk: riskSummary,
      safety,
    };
    const reportDigest = await sha256Hex(stableJson(reportPayload));

    const persisted = await persistScan(db, {
      id: scanId,
      stageId: input.stageId,
      organizationId: input.organizationId,
      ownerUserId: session.userId,
      packageJson: redactedStagedManifest,
      previousPackageJson: redactedPreviousManifest,
      risk,
      status: "complete",
      summary: {
        report: {
          version: reportPayload.version,
          digest: reportDigest,
          digestAlgorithm: "sha256",
          generatedAt: new Date().toISOString(),
          rulesVersion: reportPayload.rulesVersion,
        },
        packageJsonDiff: manifestDiff,
        diff: fileDiff,
        risk: riskSummary,
        stagedPublish: redactedDetails,
        baseline: baseline.baseline,
        safety: result.safety,
      },
      ai: aiFindings,
      files: redactedStagedFiles,
      previousFiles: redactedPreviousFiles,
      diff: fileDiff,
      findings: ruleFindings,
      riskSummary,
      report: { version: reportPayload.version, digest: reportDigest },
    });

    if (persisted.persisted) {
      await recordScanEvent(db, {
        organizationId: input.organizationId,
        actorUserId: session.userId,
        scanId,
        type: "scan.completed",
        metadata: {
          stageId: input.stageId,
          packageName: result.package.name,
          stagedVersion: result.package.stagedVersion,
          stagedTag: result.package.stagedTag,
          baseline: baseline.baseline,
          risk,
          releaseRisk: riskSummary.releaseRisk,
          artifactRisk: risk,
          contextRisk: riskSummary.contextRisk,
          durationMs: durationMsSince(pipelineStartedAtMs),
        },
      });
    }

    emitOperationalEvent("info", "scan.pipeline.completed", {
      scanId,
      organizationId: input.organizationId,
      stageId: input.stageId,
      adapterId: adapter.id,
      durationMs: durationMsSince(pipelineStartedAtMs),
      packageName: result.package.name,
      releaseRisk: riskSummary.releaseRisk,
      artifactRisk: risk,
      contextRisk: riskSummary.contextRisk,
      fileCount: result.fileCount,
      previousFileCount: result.previousFileCount,
      findingCount: ruleFindings.length,
    });

    return result;
  } catch (err) {
    emitOperationalEvent("error", "scan.pipeline.failed", {
      scanId: input.scanId ?? null,
      organizationId: input.organizationId,
      stageId: input.stageId,
      adapterId: adapter.id,
      durationMs: durationMsSince(pipelineStartedAtMs),
      error: describeOperationalError(err),
    });
    throw err;
  } finally {
    await broker.dispose();
  }
}

interface AiReviewArgs {
  env: Cloudflare.Env;
  scanId: string;
  input: ScanPipelineOptions;
  previousVersionAvailable: boolean;
  releaseRuleFindings: Finding[];
  manifestDiff: ReturnType<typeof summarizePackageJsonDiff>;
  redactedStagedFiles: ReturnType<typeof redactFileRecords>;
  redactedPreviousFiles: ReturnType<typeof redactFileRecords>;
  fileDiff: ReturnType<typeof createPackageDiff>;
}

async function maybeRunAiReview(args: AiReviewArgs): Promise<AiReview> {
  // AI review is gated by the Cloudflare Flagship `ai-review` flag in the
  // `drydock` app, evaluated per-organization. Default-off until Flagship
  // returns true for the organization placing the scan.
  const disabled: AiReview = {
    status: "unavailable",
    risk: "low",
    releaseAssessment: "not_assessed",
    summary: "AI review is disabled.",
    findings: [],
    requiresManualReview: false,
    model: null,
  };
  const aiReviewEnabled = args.env.FLAGS
    ? await args.env.FLAGS.getBooleanValue("ai-review", false, {
        targetingKey: args.input.organizationId,
        organizationId: args.input.organizationId,
      })
    : false;
  if (!aiReviewEnabled) return disabled;

  const startedAtMs = Date.now();
  try {
    const review = await runSelectiveAiReview(args.env, {
      scanId: args.scanId,
      files: args.redactedStagedFiles,
      previousFiles: args.redactedPreviousFiles,
      diff: args.fileDiff,
      packageJsonDiff: args.manifestDiff,
      ruleFindings: args.releaseRuleFindings,
      previousVersionAvailable: args.previousVersionAvailable,
    });
    emitOperationalEvent("info", "scan.ai_review.completed", {
      scanId: args.scanId,
      organizationId: args.input.organizationId,
      durationMs: durationMsSince(startedAtMs),
      status: review.status,
      model: review.model,
    });
    return review;
  } catch (err) {
    emitOperationalEvent("error", "scan.ai_review.failed", {
      scanId: args.scanId,
      organizationId: args.input.organizationId,
      durationMs: durationMsSince(startedAtMs),
      error: describeOperationalError(err),
    });
    throw err;
  }
}

function stripFindingAnnotations(
  findings: Array<Finding & { diffStatus?: string; releaseDelta?: boolean }>,
): Finding[] {
  return findings.map((finding) => ({
    severity: finding.severity,
    file: finding.file,
    evidence: finding.evidence,
    reason: finding.reason,
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    ...(finding.ruleId !== undefined ? { ruleId: finding.ruleId } : {}),
    ...(finding.ruleVersion !== undefined ? { ruleVersion: finding.ruleVersion } : {}),
  }));
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}
