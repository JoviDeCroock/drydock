import { persistScan, recordScanEvent, type AppDb, type WorkspaceSession } from "../db";
import { runSelectiveAiReview, type AiReview } from "./ai-review";
import {
  fetchPackageMetadata,
  pickBaselineVersion,
  type BaselineVersionSelection,
} from "./registry";
import {
  createPackageDiff,
  deterministicFindings,
  DETERMINISTIC_RULE_IDS,
  DETERMINISTIC_RULES_VERSION,
  redactFileRecords,
  redactFindings,
  redactJson,
  summarizePackageJsonDiff,
  type Finding,
  type PackageJsonSummary,
} from "./review";
import { computeScanRisk } from "./risk";
import { downloadInSandbox, type DownloadResult } from "./sandbox";
import { fetchStagedPublishDetails, type StagedPublishDetails } from "./staged-publishes";
import type { ScanInput, ScanResult } from "../types";

export interface ScanPipelineOptions extends ScanInput {
  scanId?: string;
  organizationId: string;
  npmToken?: string;
  npmRegistry?: string;
}

export interface ScanPipelineContext {
  env: Cloudflare.Env;
  executionCtx: ExecutionContext;
  db: AppDb;
  session: WorkspaceSession;
}

export async function runScanPipeline(
  context: ScanPipelineContext,
  input: ScanPipelineOptions,
): Promise<ScanResult> {
  const { env, executionCtx, db, session } = context;

  const [staged, stagedDetails] = await Promise.all([
    downloadInSandbox(env, executionCtx, {
      stageId: input.stageId,
      maxFiles: input.maxFiles,
      maxBytesPerFile: input.maxBytesPerFile,
      npmToken: input.npmToken,
      npmRegistry: input.npmRegistry,
    }),
    maybeFetchStagedDetails(env, input),
  ]);

  const stagedMetadataFindings = createStagedMetadataFindings(
    stagedDetails,
    staged.packageJson ?? null,
  );
  const stagedTag = stagedMetadataFindings.length ? null : (stagedDetails?.tag ?? null);
  const previousResult = await maybeDownloadPreviousVersion(
    env,
    executionCtx,
    staged.packageJson ?? null,
    stagedTag,
    input,
  );
  const previous = previousResult.previous;
  const baseline = previousResult.baseline;
  const diff = previous
    ? createPackageDiff(previous.files, staged.files)
    : createPackageDiff([], staged.files);
  const packageJsonDiff = redactJson(
    summarizePackageJsonDiff(previous?.packageJson, staged.packageJson),
  );
  const ruleFindings = redactFindings([
    ...deterministicFindings(staged.files, diff),
    ...stagedMetadataFindings,
  ]);
  const redactedStagedFiles = redactFileRecords(staged.files);
  const redactedPackageJson = redactJson(staged.packageJson ?? null);
  const redactedPreviousPackageJson = redactJson(previous?.packageJson ?? null);
  const redactedStagedDetails = redactJson(summarizeStagedDetails(stagedDetails));
  const scanId = input.scanId || crypto.randomUUID();
  // AI review is disabled while we work toward a paid-tier offering. The call,
  // escalation logging, and risk wiring below stay intact (gated by `if (false)`)
  // so the feature can be re-enabled without rebuilding the contract.
  let aiFindings: AiReview = {
    status: "unavailable",
    risk: "low",
    releaseAssessment: "not_assessed",
    summary: "AI review is disabled.",
    findings: [],
    requiresManualReview: false,
    model: null,
    escalated: false,
    escalationReasons: [],
  };
  // eslint-disable-next-line no-constant-condition -- AI review is intentionally disabled; the call below remains wired up for paid-tier re-introduction.
  if (false) {
    aiFindings = await runSelectiveAiReview(env, {
      files: redactedStagedFiles,
      diff,
      packageJsonDiff,
      ruleFindings,
      previousVersionAvailable: previous !== null,
    });
    if (aiFindings.escalated) {
      console.log("ai review escalated to stronger model", {
        scanId,
        stageId: input.stageId,
        organizationId: input.organizationId,
        packageName: staged.packageJson?.name ?? null,
        stagedVersion: staged.packageJson?.version ?? null,
        model: aiFindings.model,
        reasons: aiFindings.escalationReasons,
      });
    }
  }
  const risk = computeScanRisk(ruleFindings, aiFindings);

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

  const result: ScanResult = {
    id: scanId,
    stageId: input.stageId,
    package: {
      name: staged.packageJson?.name ?? null,
      stagedVersion: staged.packageJson?.version ?? null,
      stagedTag: stagedDetails?.tag ?? null,
      previousVersion: previous?.packageJson?.version ?? null,
    },
    baseline,
    fileCount: staged.files.length,
    previousFileCount: previous?.files.length ?? 0,
    packageJson: redactedPackageJson,
    packageJsonDiff,
    diff,
    ruleFindings,
    aiFindings,
    risk,
    safety,
  };

  const reportPayload = {
    version: 1,
    rulesVersion: DETERMINISTIC_RULES_VERSION,
    stageId: input.stageId,
    stagedPublish: redactedStagedDetails,
    package: result.package,
    baseline,
    fileCount: result.fileCount,
    previousFileCount: result.previousFileCount,
    packageJson: redactedPackageJson,
    packageJsonDiff,
    diff,
    ruleFindings,
    aiFindings,
    risk,
    safety,
  };
  const reportDigest = await sha256Hex(stableJson(reportPayload));

  const persisted = await persistScan(db, {
    id: scanId,
    stageId: input.stageId,
    organizationId: input.organizationId,
    ownerUserId: session.userId,
    packageJson: redactedPackageJson,
    previousPackageJson: redactedPreviousPackageJson,
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
      packageJsonDiff,
      diff,
      stagedPublish: redactedStagedDetails,
      baseline,
      safety: result.safety,
    },
    ai: aiFindings,
    files: redactedStagedFiles,
    diff,
    findings: ruleFindings,
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
        baseline,
        risk,
      },
    });
  }

  return result;
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

async function maybeDownloadPreviousVersion(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  pkg: PackageJsonSummary | null,
  stagedTag: string | null,
  input: ScanInput & { npmToken?: string; npmRegistry?: string },
): Promise<{ previous: DownloadResult | null; baseline: BaselineVersionSelection }> {
  if (!pkg?.name || !pkg.version) {
    return {
      previous: null,
      baseline: emptyBaseline(stagedTag, "package-json-missing-name-or-version"),
    };
  }
  const metadata = await fetchPackageMetadata(env, pkg.name, {
    npmToken: input.npmToken,
    npmRegistry: input.npmRegistry,
  }).catch(() => null);
  if (!metadata) {
    return { previous: null, baseline: emptyBaseline(stagedTag, "metadata-unavailable") };
  }
  const baseline = pickBaselineVersion(metadata, pkg.version, stagedTag);
  const tarballUrl = baseline.version ? metadata.versions?.[baseline.version]?.dist?.tarball : null;
  if (!baseline.version || !tarballUrl) {
    return {
      previous: null,
      baseline: baseline.version
        ? { ...baseline, reason: `${baseline.reason}:no-tarball` }
        : baseline,
    };
  }
  const previous = await downloadInSandbox(env, ctx, {
    tarballUrl,
    maxFiles: input.maxFiles,
    maxBytesPerFile: input.maxBytesPerFile,
    npmToken: input.npmToken,
    npmRegistry: input.npmRegistry,
  });
  return { previous, baseline };
}

async function maybeFetchStagedDetails(
  env: Cloudflare.Env,
  input: ScanPipelineOptions,
): Promise<StagedPublishDetails | null> {
  if (!input.npmToken) return null;
  const registry = input.npmRegistry || env.NPM_REGISTRY || "https://registry.npmjs.org";
  return fetchStagedPublishDetails(registry, input.npmToken, input.stageId).catch(() => null);
}

function emptyBaseline(tag: string | null, reason: string): BaselineVersionSelection {
  return {
    version: null,
    tag,
    source: "none",
    distTagVersion: null,
    reason,
  };
}

function summarizeStagedDetails(details: StagedPublishDetails | null) {
  if (!details) return null;
  return {
    id: details.id,
    packageName: details.packageName,
    version: details.version,
    tag: details.tag,
    access: details.access,
    actor: details.actor,
    actorType: details.actorType,
    createdAt: details.createdAt,
    shasum: details.shasum,
  };
}

function createStagedMetadataFindings(
  details: StagedPublishDetails | null,
  pkg: PackageJsonSummary | null,
): Finding[] {
  if (!details || !pkg) return [];
  const mismatches: string[] = [];
  if (details.packageName && pkg.name && details.packageName !== pkg.name) {
    mismatches.push(`packageName ${details.packageName} != package.json name ${pkg.name}`);
  }
  if (details.version && pkg.version && details.version !== pkg.version) {
    mismatches.push(`version ${details.version} != package.json version ${pkg.version}`);
  }
  if (!mismatches.length) return [];
  return [
    {
      severity: "critical",
      file: "package.json",
      evidence: mismatches.join("; "),
      reason:
        "npm staged metadata does not match the staged tarball package.json, so the release target cannot be trusted",
      ruleId: DETERMINISTIC_RULE_IDS.stageMetadataMismatch,
      ruleVersion: DETERMINISTIC_RULES_VERSION,
    },
  ];
}
