import { type AppDb, type WorkspaceSession } from "../../db/client";
import { getPriorApprovedScanFindings } from "../../db/release-memory";
import { persistScan } from "../../db/scans";
import type { AiReview } from "../ai-review";
import type {
  AcquiredArtifact,
  AdapterBroker,
  AdapterContext,
  BaselineInfo,
  PackageAdapter,
  StagedDetails,
} from "../ecosystems/package-adapter";
import type { IntentEnvelope } from "../intent-envelope";
import {
  describeOperationalError,
  durationMsSince,
  emitOperationalEvent,
} from "../platform/observability";
import { recordProductEvent } from "../platform/analytics";
import {
  computeReleaseConsistency,
  noneReleaseConsistency,
  type ReleaseConsistency,
} from "./release-memory";
import {
  annotateFindingsWithDiffStatus,
  createPackageDiff,
  redactFileRecords,
  redactFindings,
  redactJson,
  summarizePackageJsonDiff,
  DETERMINISTIC_RULES_VERSION,
  type CodePatternSet,
  type DiffEntry,
  type FileRecord,
  type Finding,
  type FindingDiffAnnotation,
  type PackageJsonDiff,
  type PackageJsonSummary,
} from "../review";
import { computeScanRiskBreakdown, type ScanRiskBreakdown } from "../review/risk";
import {
  maybeWriteScanArtifacts,
  projectAiReviewFindings,
  scanArtifactReadBucket,
} from "./artifacts";
import { sha256Hex, stableJson } from "../platform/stable-json";
import type { ScanResult } from "../../types";

export interface PipelineIdentity {
  scanId: string;
  stageId: string;
  organizationId: string;
}

export interface ResolvedArtifacts {
  staged: { artifact: AcquiredArtifact; details: StagedDetails };
  baseline: { artifact: AcquiredArtifact | null; baseline: BaselineInfo };
}

export interface ComputedDiff {
  fileDiff: DiffEntry[];
  manifestDiff: PackageJsonDiff;
  stagedManifestText: string | null;
}

interface FindingAnnotationRecord {
  findingIndex: number;
  diffStatus: FindingDiffAnnotation["diffStatus"];
  releaseDelta: boolean;
}

export interface DeterministicFindings {
  ruleFindings: Finding[];
  redactedStagedFiles: FileRecord[];
  redactedPreviousFiles: FileRecord[];
  redactedStagedManifest: PackageJsonSummary | null;
  redactedPreviousManifest: PackageJsonSummary | null;
  redactedDetails: Record<string, unknown> | null;
  annotatedFindings: Array<Finding & FindingDiffAnnotation>;
  releaseRuleFindings: Finding[];
}

// Acquire the staged artifact, then resolve + fetch the baseline it diffs
// against. Both calls reach the adapter's credentialed broker, so this is a
// side-effecting phase.
export async function resolveBaseline<TInput, TBroker extends AdapterBroker>(
  adapter: PackageAdapter<TInput, TBroker>,
  ctx: AdapterContext,
  input: TInput,
  broker: TBroker,
): Promise<ResolvedArtifacts> {
  const staged = await adapter.acquireStaged(ctx, input, broker);
  const baseline = await adapter.acquireBaseline(ctx, input, broker, staged);
  return { staged, baseline };
}

// Pure: derive the file + manifest diffs between baseline and staged.
export function computeDiff(resolved: ResolvedArtifacts): ComputedDiff {
  const { staged, baseline } = resolved;
  const fileDiff = createPackageDiff(baseline.artifact?.files ?? [], staged.artifact.files);
  const manifestDiff = redactJson(
    summarizePackageJsonDiff(baseline.artifact?.manifest, staged.artifact.manifest),
  );
  const stagedManifestText =
    staged.artifact.files.find((file) => file.path === "package.json")?.textSample ?? null;
  return { fileDiff, manifestDiff, stagedManifestText };
}

// Pure: run the adapter's deterministic rules, redact evidence, and annotate
// each finding with its release-delta scope. Produces every redacted artifact
// the persistence + AI phases consume. `extraFindings` lets the pipeline append
// non-adapter deterministic findings (the release-process fingerprint rules) so
// they ride the same redaction, annotation, risk, and persistence path as any
// other rule finding.
export function runDeterministicFindings<TInput, TBroker extends AdapterBroker>(
  adapter: PackageAdapter<TInput, TBroker>,
  resolved: ResolvedArtifacts,
  diff: ComputedDiff,
  extraFindings: Finding[] = [],
): DeterministicFindings {
  const { staged, baseline } = resolved;

  const adapterFindings = adapter.runFindings({
    staged: staged.artifact,
    baseline: baseline.artifact,
    details: staged.details,
    fileDiff: diff.fileDiff,
    manifestDiff: diff.manifestDiff,
    stagedManifestText: diff.stagedManifestText,
  });
  const ruleFindings = redactFindings([...adapterFindings, ...extraFindings]);

  const redactedStagedFiles = redactFileRecords(staged.artifact.files);
  const redactedPreviousFiles = baseline.artifact ? redactFileRecords(baseline.artifact.files) : [];
  const redactedStagedManifest = redactJson(staged.artifact.manifest ?? null);
  const redactedPreviousManifest = redactJson(baseline.artifact?.manifest ?? null);
  const redactedDetails = redactJson(adapter.summarizeDetails(staged.details));

  const annotatedFindings = annotateFindingsWithDiffStatus(ruleFindings, diff.fileDiff, {
    previousFiles: redactedPreviousFiles,
    stagedFiles: redactedStagedFiles,
    codePatternSet: adapter.codePatternSet,
    baselineComparisonSkipped: Boolean(baseline.baseline.comparisonSkipped),
  });
  const releaseRuleFindings = stripFindingAnnotations(
    annotatedFindings.filter((finding) => finding.releaseDelta),
  );

  return {
    ruleFindings,
    redactedStagedFiles,
    redactedPreviousFiles,
    redactedStagedManifest,
    redactedPreviousManifest,
    redactedDetails,
    annotatedFindings,
    releaseRuleFindings,
  };
}

// Pure: fold deterministic + AI findings into the artifact/release/context
// risk breakdown. `releaseConsistency` only ever removes previously-approved
// package context from the artifact/context scores; release-delta findings are
// scored in full regardless, so it cannot move `releaseRisk`.
export function scoreRisk(
  annotatedFindings: Array<Finding & FindingDiffAnnotation>,
  aiFindings: AiReview,
  releaseConsistency?: ReleaseConsistency | null,
  options: { baselineComparisonSkipped?: boolean } = {},
): ScanRiskBreakdown {
  return computeScanRiskBreakdown(annotatedFindings, aiFindings, releaseConsistency, options);
}

export interface MergedAiFindings {
  /** Redacted Finding-shaped records for the completed review's findings. */
  records: Finding[];
  /** The same records annotated with diff status + release-delta scope. */
  annotatedRecords: Array<Finding & FindingDiffAnnotation>;
}

// Pure: project a completed AI review's findings into the same Finding shape
// deterministic rules emit, so they persist as `scan_findings` rows (source
// "ai"), count into `finding_count` / the risk breakdown, and carry diff
// annotations. Additive only — deterministic findings are never replaced or
// re-scored by this phase, and a review that did not complete contributes
// nothing (its fail-safe risk handling lives in computeScanRisk).
export function mergeAiFindings(
  aiReview: AiReview,
  findings: DeterministicFindings,
  diff: ComputedDiff,
  codePatternSet?: CodePatternSet,
  baselineComparisonSkipped = false,
): MergedAiFindings {
  // projectAiReviewFindings is shared with the R2 read path so both stores
  // hold byte-identical rows; it returns [] for a review that did not complete.
  const records = projectAiReviewFindings(aiReview);
  if (records.length === 0) return { records: [], annotatedRecords: [] };
  // Annotated as `source: "ai"` — the same marker the persisted rows carry — so
  // the annotator scopes these by file rather than by their anchor-resolved
  // line. Without it a whole-file concern pinned to an untouched line would fall
  // out of the release bucket `releaseRisk` and the workflow gate read.
  const annotatedRecords = annotateFindingsWithDiffStatus(
    records.map((record) => ({ ...record, source: "ai" as const })),
    diff.fileDiff,
    {
      previousFiles: findings.redactedPreviousFiles,
      stagedFiles: findings.redactedStagedFiles,
      codePatternSet,
      baselineComparisonSkipped,
    },
  );
  return { records, annotatedRecords };
}

export interface ResolveReleaseConsistencyArgs {
  db: AppDb;
  env?: Cloudflare.Env;
  identity: PipelineIdentity;
  /** The staged manifest name — the same value persistScan records as `scans.packageName`. */
  packageName: string | null;
  /** The current scan's deterministic rule findings (redacted set that gets persisted). */
  ruleFindings: Finding[];
}

// Side-effecting (db read): release memory. Compare the current deterministic
// finding profile against the most recent completed scan of the same package,
// in the same organization, that a maintainer decided "publish". The outcome
// never edits a finding; its only scoring effect is that already-approved
// package context stops anchoring the headline risk (see `scoreRisk` and
// docs/release-memory.md). A lookup failure degrades to "none", which scores
// exactly as it did before release memory existed, instead of failing the scan.
export async function resolveReleaseConsistency(
  args: ResolveReleaseConsistencyArgs,
): Promise<ReleaseConsistency> {
  if (!args.packageName) return noneReleaseConsistency(args.ruleFindings.length);
  try {
    const prior = await getPriorApprovedScanFindings(
      args.db,
      {
        organizationId: args.identity.organizationId,
        packageName: args.packageName,
        excludeScanId: args.identity.scanId,
      },
      args.env ? scanArtifactReadBucket(args.env) : undefined,
    );
    return computeReleaseConsistency(args.ruleFindings, prior);
  } catch (err) {
    emitOperationalEvent("warn", "scan.release_memory.lookup_failed", {
      scanId: args.identity.scanId,
      organizationId: args.identity.organizationId,
      packageName: args.packageName,
      error: describeOperationalError(err),
    });
    return noneReleaseConsistency(args.ruleFindings.length);
  }
}

export interface PersistResultsArgs<TInput, TBroker extends AdapterBroker> {
  env?: Cloudflare.Env;
  db: AppDb;
  session: WorkspaceSession;
  adapter: PackageAdapter<TInput, TBroker>;
  adapterInput: TInput;
  identity: PipelineIdentity;
  resolved: ResolvedArtifacts;
  diff: ComputedDiff;
  findings: DeterministicFindings;
  aiFindings: AiReview;
  /** Output of mergeAiFindings for `aiFindings`; empty when the review did not complete. */
  mergedAiFindings?: MergedAiFindings;
  riskSummary: ScanRiskBreakdown;
  releaseConsistency: ReleaseConsistency;
  // Advisory source-binding classification computed by the pipeline; persisted
  // with the scan but never allowed to influence risk or findings.
  intentEnvelope: IntentEnvelope;
}

export interface PersistedScanOutcome {
  result: ScanResult;
  persisted: boolean;
}

// Side-effecting: assemble the ScanResult + report payload and persist the
// scan, its files, and its findings.
export async function persistResults<TInput, TBroker extends AdapterBroker>(
  args: PersistResultsArgs<TInput, TBroker>,
): Promise<PersistedScanOutcome> {
  const { db, session, adapter, adapterInput, identity, resolved, diff, findings } = args;
  const { staged, baseline } = resolved;
  const mergedAi = args.mergedAiFindings ?? { records: [], annotatedRecords: [] };
  const risk = args.riskSummary.artifactRisk;

  const safety = pipelineSafety();
  const packageSummary = adapter.describe({
    input: adapterInput,
    staged: staged.artifact,
    details: staged.details,
    baseline: baseline.baseline,
    previous: baseline.artifact,
  });

  const result: ScanResult = {
    id: identity.scanId,
    stageId: identity.stageId,
    package: packageSummary,
    baseline: baseline.baseline,
    fileCount: staged.artifact.files.length,
    previousFileCount: baseline.artifact?.files.length ?? 0,
    packageJson: findings.redactedStagedManifest,
    packageJsonDiff: diff.manifestDiff,
    diff: diff.fileDiff,
    ruleFindings: findings.ruleFindings,
    aiFindings: args.aiFindings,
    risk,
    riskSummary: args.riskSummary,
    releaseConsistency: args.releaseConsistency,
    intentEnvelope: args.intentEnvelope,
    safety,
  };

  // Annotations span `ruleFindings` followed by the AI finding records (in
  // aiFindings.findings order): the report read path re-derives the same
  // combined row list, so `findingIndex` addresses rule findings first and AI
  // findings after them.
  const findingAnnotations: FindingAnnotationRecord[] = [
    ...findings.annotatedFindings,
    ...mergedAi.annotatedRecords,
  ].map((finding, index) => ({
    findingIndex: index,
    diffStatus: finding.diffStatus,
    releaseDelta: finding.releaseDelta,
  }));

  const reportPayload = {
    version: 1,
    rulesVersion: DETERMINISTIC_RULES_VERSION,
    stageId: identity.stageId,
    stagedPublish: findings.redactedDetails,
    package: result.package,
    baseline: baseline.baseline,
    fileCount: result.fileCount,
    previousFileCount: result.previousFileCount,
    packageJson: findings.redactedStagedManifest,
    packageJsonDiff: diff.manifestDiff,
    diff: diff.fileDiff,
    ruleFindings: findings.ruleFindings,
    findingAnnotations,
    aiFindings: args.aiFindings,
    risk: args.riskSummary,
    releaseConsistency: args.releaseConsistency,
    intentEnvelope: args.intentEnvelope,
    safety,
  };
  const reportJson = stableJson(reportPayload);
  const reportDigest = await sha256Hex(reportJson);
  const generatedAt = new Date().toISOString();
  const artifacts = await maybeWriteScanArtifacts(args.env?.ARTIFACTS, {
    organizationId: identity.organizationId,
    scanId: identity.scanId,
    reportJson,
    reportDigest,
    files: findings.redactedStagedFiles,
    diff: diff.fileDiff,
    generatedAt,
  });

  const persisted = await persistScan(db, {
    id: identity.scanId,
    stageId: identity.stageId,
    organizationId: identity.organizationId,
    ownerUserId: session.userId,
    packageJson: findings.redactedStagedManifest,
    previousPackageJson: findings.redactedPreviousManifest,
    risk,
    status: "complete",
    summary: {
      report: {
        version: reportPayload.version,
        digest: reportDigest,
        digestAlgorithm: "sha256",
        generatedAt,
        rulesVersion: reportPayload.rulesVersion,
      },
      packageJsonDiff: diff.manifestDiff,
      diff: diff.fileDiff,
      risk: args.riskSummary,
      stagedPublish: findings.redactedDetails,
      baseline: baseline.baseline,
      releaseConsistency: args.releaseConsistency,
      intentEnvelope: args.intentEnvelope,
      safety: result.safety,
    },
    ai: args.aiFindings,
    files: findings.redactedStagedFiles,
    previousFiles: findings.redactedPreviousFiles,
    diff: diff.fileDiff,
    findings: findings.ruleFindings,
    aiFindingRecords: mergedAi.records,
    codePatternSet: adapter.codePatternSet,
    riskSummary: args.riskSummary,
    report: { version: reportPayload.version, digest: reportDigest },
    artifacts,
  });

  return { result, persisted: persisted.persisted };
}

export interface RecordCompletionArgs {
  db: AppDb;
  session: WorkspaceSession;
  identity: PipelineIdentity;
  adapterId: string;
  result: ScanResult;
  baseline: BaselineInfo;
  persisted: boolean;
  pipelineStartedAtMs: number;
  env?: Cloudflare.Env;
  source?: string;
}

// Side-effecting: emit the structured completion observability event plus the
// aggregate product counter. The log line is for debugging one scan; the
// counter is what still answers "how many, how fast, how risky" a month later,
// after the log has aged out.
export async function recordCompletion(args: RecordCompletionArgs): Promise<void> {
  const { result, identity } = args;
  const riskSummary = result.riskSummary;
  const risk = result.risk;

  // `findingCount` must match the persisted `scans.finding_count`, which counts
  // rule rows plus a completed AI review's rows. Emit the breakdown too so an
  // operator can see how many were advisory.
  const ruleFindingCount = result.ruleFindings.length;
  const aiFindingCount = projectAiReviewFindings(result.aiFindings).length;
  const durationMs = durationMsSince(args.pipelineStartedAtMs);

  recordProductEvent(args.env, {
    name: "scan.completed",
    organizationId: identity.organizationId,
    ecosystem: args.adapterId,
    source: args.source ?? "unknown",
    releaseRisk: riskSummary.releaseRisk,
    artifactRisk: risk,
    contextRisk: riskSummary.contextRisk,
    durationMs,
    ruleFindingCount,
    aiFindingCount,
  });

  emitOperationalEvent("info", "scan.pipeline.completed", {
    scanId: identity.scanId,
    organizationId: identity.organizationId,
    stageId: identity.stageId,
    adapterId: args.adapterId,
    durationMs,
    packageName: result.package.name,
    releaseRisk: riskSummary.releaseRisk,
    artifactRisk: risk,
    contextRisk: riskSummary.contextRisk,
    fileCount: result.fileCount,
    previousFileCount: result.previousFileCount,
    findingCount: ruleFindingCount + aiFindingCount,
    ruleFindingCount,
    aiFindingCount,
  });
}

function pipelineSafety(): ScanResult["safety"] {
  return {
    tokenExposedToSandbox: false,
    directSandboxNetwork: false,
    outboundPolicy:
      "sandbox uses the gateway only for npm staged tarball and package metadata endpoints; parent fetches published npm tarballs with a registry-origin credential guard and parses them in a credentials-free inline sandbox; parent also fetches staged metadata with the organization credential",
    aiInputPolicy:
      "package bytes are untrusted evidence, not instructions; static safety prompt is prefix-cache friendly and AI cannot downgrade deterministic findings",
    fileExplorerPolicy:
      "package file previews are escaped text and secret-redacted before persistence; no package-provided HTML/script/image execution",
  };
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
