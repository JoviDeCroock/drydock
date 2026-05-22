import { persistScan, recordScanEvent, type AppDb, type WorkspaceSession } from "../db";
import { runSelectiveAiReview } from "./ai-review";
import { fetchPackageMetadata, pickPreviousVersion } from "./registry";
import {
  createPackageDiff,
  deterministicFindings,
  DETERMINISTIC_RULES_VERSION,
  redactFileRecords,
  redactFindings,
  redactJson,
  summarizePackageJsonDiff,
  type PackageJsonSummary,
} from "./review";
import { computeScanRisk } from "./risk";
import { downloadInSandbox } from "./sandbox";
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

  const staged = await downloadInSandbox(env, executionCtx, {
    stageId: input.stageId,
    maxFiles: input.maxFiles,
    maxBytesPerFile: input.maxBytesPerFile,
    npmToken: input.npmToken,
    npmRegistry: input.npmRegistry,
  });

  const previous = await maybeDownloadPreviousVersion(
    env,
    executionCtx,
    staged.packageJson ?? null,
    input,
  );
  const diff = previous
    ? createPackageDiff(previous.files, staged.files)
    : createPackageDiff([], staged.files);
  const packageJsonDiff = redactJson(
    summarizePackageJsonDiff(previous?.packageJson, staged.packageJson),
  );
  const ruleFindings = redactFindings(deterministicFindings(staged.files, diff));
  const redactedStagedFiles = redactFileRecords(staged.files);
  const redactedPackageJson = redactJson(staged.packageJson ?? null);
  const redactedPreviousPackageJson = redactJson(previous?.packageJson ?? null);
  const scanId = input.scanId || crypto.randomUUID();
  const aiFindings = await runSelectiveAiReview(env, {
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
  const risk = computeScanRisk(ruleFindings, aiFindings);

  const safety: ScanResult["safety"] = {
    tokenExposedToSandbox: false,
    directSandboxNetwork: false,
    outboundPolicy:
      "only npm staged tarball, published tarball, and package metadata endpoints via gateway",
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
      previousVersion: previous?.packageJson?.version ?? null,
    },
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
    package: result.package,
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
  input: ScanInput & { npmToken?: string; npmRegistry?: string },
) {
  if (!pkg?.name || !pkg.version) return null;
  const metadata = await fetchPackageMetadata(env, pkg.name, {
    npmToken: input.npmToken,
    npmRegistry: input.npmRegistry,
  }).catch(() => null);
  if (!metadata) return null;
  const version = pickPreviousVersion(metadata, pkg.version);
  const tarballUrl = version ? metadata.versions?.[version]?.dist?.tarball : null;
  if (!version || !tarballUrl) return null;
  return downloadInSandbox(env, ctx, {
    tarballUrl,
    maxFiles: input.maxFiles,
    maxBytesPerFile: input.maxBytesPerFile,
    npmToken: input.npmToken,
    npmRegistry: input.npmRegistry,
  });
}
