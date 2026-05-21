import { persistScan, recordScanEvent, type AppDb, type WorkspaceSession } from "../db";
import { analyzeWithAi } from "./ai-review";
import { fetchPackageMetadata, pickPreviousVersion } from "./registry";
import {
  combineRisk,
  computeRisk,
  createPackageDiff,
  deterministicFindings,
  normalizeRisk,
  redactFileRecords,
  redactFindings,
  redactJson,
  summarizePackageJsonDiff,
  type PackageJsonSummary,
} from "./review";
import { downloadInSandbox } from "./sandbox";
import type { ScanInput, ScanResult } from "../types";

export interface ScanPipelineOptions extends ScanInput {
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

  const previous = await maybeDownloadPreviousVersion(env, executionCtx, staged.packageJson ?? null, input);
  const diff = previous
    ? createPackageDiff(previous.files, staged.files)
    : createPackageDiff([], staged.files);
  const packageJsonDiff = redactJson(summarizePackageJsonDiff(previous?.packageJson, staged.packageJson));
  const ruleFindings = redactFindings(deterministicFindings(staged.files, diff));
  const redactedStagedFiles = redactFileRecords(staged.files);
  const redactedPackageJson = redactJson(staged.packageJson ?? null);
  const redactedPreviousPackageJson = redactJson(previous?.packageJson ?? null);
  const aiFindings = await analyzeWithAi(env, redactedStagedFiles, diff, packageJsonDiff, ruleFindings);
  const risk = combineRisk(
    computeRisk(ruleFindings),
    normalizeRisk(aiFindings.risk),
    aiFindings.requiresManualReview ? "medium" : "low",
  );
  const scanId = crypto.randomUUID();

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
    safety: {
      tokenExposedToSandbox: false,
      directSandboxNetwork: false,
      outboundPolicy: "only npm staged tarball, published tarball, and package metadata endpoints via gateway",
      aiInputPolicy: "package bytes are untrusted evidence, not instructions; static safety prompt is prefix-cache friendly and AI cannot downgrade deterministic findings",
      fileExplorerPolicy: "package file previews are escaped text and secret-redacted before persistence; no package-provided HTML/script/image execution",
    },
  };

  await persistScan(db, {
    id: scanId,
    stageId: input.stageId,
    organizationId: input.organizationId,
    ownerUserId: session.userId,
    packageJson: redactedPackageJson,
    previousPackageJson: redactedPreviousPackageJson,
    risk,
    status: "complete",
    summary: { packageJsonDiff, diff, safety: result.safety },
    ai: aiFindings,
    files: redactedStagedFiles,
    diff,
    findings: ruleFindings,
  });

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

  return result;
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
