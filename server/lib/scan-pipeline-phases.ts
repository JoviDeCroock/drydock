import { persistScan, recordScanEvent, type AppDb, type WorkspaceSession } from "../db";
import type { AiReview } from "./ai-review";
import type {
  AcquiredArtifact,
  AdapterBroker,
  AdapterContext,
  BaselineInfo,
  PackageAdapter,
  StagedDetails,
} from "./adapters/types";
import { durationMsSince, emitOperationalEvent } from "./observability";
import {
  annotateFindingsWithDiffStatus,
  createPackageDiff,
  redactFileRecords,
  redactFindings,
  redactJson,
  summarizePackageJsonDiff,
  DETERMINISTIC_RULES_VERSION,
  type DiffEntry,
  type FileRecord,
  type Finding,
  type FindingDiffAnnotation,
  type PackageJsonDiff,
  type PackageJsonSummary,
} from "./review";
import { computeScanRiskBreakdown, type ScanRiskBreakdown } from "./risk";
import { maybeWriteScanArtifacts } from "./scan-artifacts";
import { sha256Hex, stableJson } from "./stable-json";
import type { ScanResult } from "../types";

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

export interface FindingAnnotationRecord {
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
  findingAnnotations: FindingAnnotationRecord[];
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
// the persistence + AI phases consume.
export function runDeterministicFindings<TInput, TBroker extends AdapterBroker>(
  adapter: PackageAdapter<TInput, TBroker>,
  resolved: ResolvedArtifacts,
  diff: ComputedDiff,
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
  const ruleFindings = redactFindings(adapterFindings);

  const redactedStagedFiles = redactFileRecords(staged.artifact.files);
  const redactedPreviousFiles = baseline.artifact ? redactFileRecords(baseline.artifact.files) : [];
  const redactedStagedManifest = redactJson(staged.artifact.manifest ?? null);
  const redactedPreviousManifest = redactJson(baseline.artifact?.manifest ?? null);
  const redactedDetails = redactJson(adapter.summarizeDetails(staged.details));

  const annotatedFindings = annotateFindingsWithDiffStatus(ruleFindings, diff.fileDiff, {
    previousFiles: redactedPreviousFiles,
    stagedFiles: redactedStagedFiles,
    codePatternSet: adapter.codePatternSet,
  });
  const releaseRuleFindings = stripFindingAnnotations(
    annotatedFindings.filter((finding) => finding.releaseDelta),
  );
  const findingAnnotations = annotatedFindings.map((finding, index) => ({
    findingIndex: index,
    diffStatus: finding.diffStatus,
    releaseDelta: finding.releaseDelta,
  }));

  return {
    ruleFindings,
    redactedStagedFiles,
    redactedPreviousFiles,
    redactedStagedManifest,
    redactedPreviousManifest,
    redactedDetails,
    annotatedFindings,
    releaseRuleFindings,
    findingAnnotations,
  };
}

// Pure: fold deterministic + AI findings into the artifact/release/context
// risk breakdown.
export function scoreRisk(
  annotatedFindings: Array<Finding & FindingDiffAnnotation>,
  aiFindings: AiReview,
): ScanRiskBreakdown {
  return computeScanRiskBreakdown(annotatedFindings, aiFindings);
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
  riskSummary: ScanRiskBreakdown;
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
    safety,
  };

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
    findingAnnotations: findings.findingAnnotations,
    aiFindings: args.aiFindings,
    risk: args.riskSummary,
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
      safety: result.safety,
    },
    ai: args.aiFindings,
    files: findings.redactedStagedFiles,
    previousFiles: findings.redactedPreviousFiles,
    diff: diff.fileDiff,
    findings: findings.ruleFindings,
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
}

// Side-effecting: write the completion audit event (only when this attempt won
// the persistence claim) and emit the structured completion observability
// event.
export async function recordCompletion(args: RecordCompletionArgs): Promise<void> {
  const { result, identity, baseline } = args;
  const riskSummary = result.riskSummary;
  const risk = result.risk;

  if (args.persisted) {
    await recordScanEvent(args.db, {
      organizationId: identity.organizationId,
      actorUserId: args.session.userId,
      scanId: identity.scanId,
      type: "scan.completed",
      metadata: {
        stageId: identity.stageId,
        packageName: result.package.name,
        stagedVersion: result.package.stagedVersion,
        stagedTag: result.package.stagedTag,
        baseline,
        risk,
        releaseRisk: riskSummary.releaseRisk,
        artifactRisk: risk,
        contextRisk: riskSummary.contextRisk,
        durationMs: durationMsSince(args.pipelineStartedAtMs),
      },
    });
  }

  emitOperationalEvent("info", "scan.pipeline.completed", {
    scanId: identity.scanId,
    organizationId: identity.organizationId,
    stageId: identity.stageId,
    adapterId: args.adapterId,
    durationMs: durationMsSince(args.pipelineStartedAtMs),
    packageName: result.package.name,
    releaseRisk: riskSummary.releaseRisk,
    artifactRisk: risk,
    contextRisk: riskSummary.contextRisk,
    fileCount: result.fileCount,
    previousFileCount: result.previousFileCount,
    findingCount: result.ruleFindings.length,
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
