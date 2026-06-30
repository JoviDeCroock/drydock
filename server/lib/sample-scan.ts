import { recordScanEvent, type AppDb } from "../db";
import type { AiReview } from "./ai-review-types";
import { npmAdapter, type NpmAdapterInput } from "./adapters/npm";
import type { AcquiredArtifact, StagedDetails } from "./adapters/types";
import {
  computeDiff,
  persistResults,
  runDeterministicFindings,
  scoreRisk,
} from "./scan-pipeline-phases";
import { sha256Hex } from "./stable-json";
import type { PackageJsonSummary } from "./review";
import type { ResolvedArtifacts } from "./scan-pipeline-phases";

export const SAMPLE_SCAN_STAGE_ID = "drydock-sample-release";

export function sampleScanId(organizationId: string): string {
  return `sample-scan:${organizationId}`;
}

const disabledAi: AiReview = {
  status: "unavailable",
  risk: "low",
  releaseAssessment: "not_assessed",
  summary: "AI review is disabled.",
  findings: [],
  requiresManualReview: false,
  model: null,
};

const SAMPLE_PACKAGE_NAME = "@drydock/sample-utils";
const SAMPLE_BASELINE_VERSION = "1.4.0";
const SAMPLE_STAGED_VERSION = "1.5.0";
const SAMPLE_STAGE_TAG = "latest";

export async function seedSampleScan(
  db: AppDb,
  params: { organizationId: string; ownerUserId: string; env?: Cloudflare.Env },
): Promise<void> {
  const resolved = await buildSampleResolvedArtifacts();
  const diff = computeDiff(resolved);
  const findings = runDeterministicFindings(npmAdapter, resolved, diff);
  const riskSummary = scoreRisk(findings.annotatedFindings, disabledAi);

  const result = await persistResults({
    env: params.env,
    db,
    session: { userId: params.ownerUserId },
    adapter: npmAdapter,
    adapterInput: { stageId: SAMPLE_SCAN_STAGE_ID } satisfies NpmAdapterInput,
    identity: {
      scanId: sampleScanId(params.organizationId),
      stageId: SAMPLE_SCAN_STAGE_ID,
      organizationId: params.organizationId,
    },
    resolved,
    diff,
    findings,
    aiFindings: disabledAi,
    riskSummary,
  });

  if (result.persisted) {
    await recordScanEvent(db, {
      organizationId: params.organizationId,
      actorUserId: params.ownerUserId,
      scanId: sampleScanId(params.organizationId),
      type: "scan.completed",
      metadata: {
        stageId: SAMPLE_SCAN_STAGE_ID,
        packageName: result.result.package.name,
        stagedVersion: result.result.package.stagedVersion,
        stagedTag: result.result.package.stagedTag,
        baseline: result.result.baseline,
        risk: result.result.risk,
        releaseRisk: result.result.riskSummary.releaseRisk,
        artifactRisk: result.result.risk,
        contextRisk: result.result.riskSummary.contextRisk,
      },
    });
  }
}

async function buildSampleResolvedArtifacts(): Promise<ResolvedArtifacts> {
  const baselineManifest = sampleManifest(SAMPLE_BASELINE_VERSION, false);
  const stagedManifest = sampleManifest(SAMPLE_STAGED_VERSION, true);
  const baselinePackageJson = toPackageJsonText(baselineManifest);
  const stagedPackageJson = toPackageJsonText(stagedManifest);

  const baselineFiles = await buildSampleFiles({
    packageJsonText: baselinePackageJson,
    includeCollectFile: false,
  });
  const stagedFiles = await buildSampleFiles({
    packageJsonText: stagedPackageJson,
    includeCollectFile: true,
  });

  const stagedDetails: StagedDetails = {
    id: "sample-stage:drydock-sample-release",
    packageName: SAMPLE_PACKAGE_NAME,
    version: SAMPLE_STAGED_VERSION,
    tag: SAMPLE_STAGE_TAG,
    access: "public",
    actor: "drydock-bot",
    actorType: "bot",
    createdAt: "2024-01-01T00:00:00.000Z",
    shasum: stagedFiles.find((file) => file.path === "package.json")?.sha256 ?? null,
    packageJson: stagedManifest,
  };

  return {
    staged: {
      artifact: {
        files: stagedFiles,
        manifest: stagedManifest,
      },
      details: stagedDetails,
    },
    baseline: {
      artifact: {
        files: baselineFiles,
        manifest: baselineManifest,
      },
      baseline: {
        version: SAMPLE_BASELINE_VERSION,
        tag: SAMPLE_STAGE_TAG,
        source: "latest-published",
        distTagVersion: SAMPLE_BASELINE_VERSION,
        reason: "sample fixture resolved from the latest published version",
      },
    },
  };
}

async function buildSampleFiles(args: {
  packageJsonText: string;
  includeCollectFile: boolean;
}): Promise<AcquiredArtifact["files"]> {
  const files: AcquiredArtifact["files"] = [
    await fileRecord("package.json", args.packageJsonText),
    await fileRecord(
      "lib/index.js",
      "module.exports = function index() {\n  return 'sample-utils';\n};\n",
    ),
  ];

  if (args.includeCollectFile) {
    files.push(
      await fileRecord(
        "lib/collect.js",
        [
          'const { exec } = require("child_process");',
          "",
          "module.exports = async function collect() {",
          '  await exec("npm view @drydock/sample-utils version");',
          '  return fetch("https://example.com/telemetry");',
          "};",
          "",
        ].join("\n"),
      ),
    );
  }

  return files;
}

function sampleManifest(version: string, includePostinstall: boolean): PackageJsonSummary {
  return {
    name: SAMPLE_PACKAGE_NAME,
    version,
    ...(includePostinstall ? { scripts: { postinstall: "node lib/collect.js" } } : {}),
  };
}

function toPackageJsonText(manifest: PackageJsonSummary): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function fileRecord(path: string, textSample: string) {
  return {
    path,
    size: new TextEncoder().encode(textSample).length,
    sha256: await sha256Hex(textSample),
    textSample,
    flags: [],
  };
}
