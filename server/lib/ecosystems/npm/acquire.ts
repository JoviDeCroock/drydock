import { pickBaselineVersion } from "./registry";
import { parseSandboxErrorDetail } from "../../sandbox";
import type { PackageJsonSummary } from "../../review";
import type { StagedPublishDetails } from "./staged-publishes";
import type {
  AcquiredArtifact,
  AdapterContext,
  BaselineInfo,
  StagedDetails,
} from "../package-adapter";
import { mergeStagedPackageJson } from "./findings";
import type { NpmBroker, NpmBrokerDownloadOptions } from "./broker";

export interface NpmAdapterInput {
  stageId: string;
  maxFiles?: number;
}

export async function acquireStagedNpm(
  _ctx: AdapterContext,
  input: NpmAdapterInput,
  broker: NpmBroker,
): Promise<{ artifact: AcquiredArtifact; details: StagedDetails }> {
  const downloadOpts: NpmBrokerDownloadOptions = {
    maxFiles: input.maxFiles,
  };
  const [staged, stagedDetails] = await Promise.all([
    broker.downloadStaged(input.stageId, downloadOpts),
    broker.fetchStagedDetails(input.stageId),
  ]);

  // If staged metadata disagrees with the tarball we cannot trust it, so we
  // drop its package.json contribution. The mismatch itself surfaces as a
  // finding in runFindings.
  const metadataIsTrustworthy = !hasMetadataMismatch(stagedDetails, staged.packageJson ?? null);
  const mergedManifest = mergeStagedPackageJson(
    staged.packageJson ?? null,
    metadataIsTrustworthy ? (stagedDetails?.packageJson ?? null) : null,
  );

  return {
    artifact: {
      files: staged.files,
      manifest: mergedManifest,
      suspiciousTarEntries: staged.suspiciousEntries,
    },
    details: stagedDetails as StagedDetails,
  };
}

/**
 * Resolve + fetch the currently-published npm version to diff against. Shared by
 * the staged-publish adapter and the workflow-gate adapter: both select the
 * baseline through the organization's npm connection (so private packages
 * resolve) and parse it in the credentials-free sandbox. Only the download
 * limits are read here, so the gate adapter passes its limits without a stageId.
 */
export async function acquireBaselineNpm(
  _ctx: AdapterContext,
  input: { maxFiles?: number },
  broker: NpmBroker,
  staged: { artifact: AcquiredArtifact; details: StagedDetails },
): Promise<{ artifact: AcquiredArtifact | null; baseline: BaselineInfo }> {
  const manifest = staged.artifact.manifest;
  const stagedTag = stagedTagFor(staged.details, staged.artifact.manifest);
  if (!manifest?.name || !manifest.version) {
    return {
      artifact: null,
      baseline: emptyBaseline(stagedTag, "package-json-missing-name-or-version"),
    };
  }

  const metadata = await broker.fetchPackageMetadata(manifest.name);
  if (!metadata) {
    return { artifact: null, baseline: emptyBaseline(stagedTag, "metadata-unavailable") };
  }

  const baseline = pickBaselineVersion(metadata, manifest.version, stagedTag);
  const tarballUrl = baseline.version ? metadata.versions?.[baseline.version]?.dist?.tarball : null;
  if (!baseline.version || !tarballUrl) {
    return {
      artifact: null,
      baseline: baseline.version
        ? { ...baseline, reason: `${baseline.reason}:no-tarball` }
        : baseline,
    };
  }

  let previous;
  try {
    previous = await broker.downloadPublished(tarballUrl, {
      maxFiles: input.maxFiles,
    });
  } catch (err) {
    // A baseline the sandbox rejects on a safety limit degrades to a no-baseline
    // scan (the staged artifact still gets fully reviewed) instead of failing the
    // whole scan. The baseline streams through the sandbox without parent
    // buffering, so the size branch only fires past the decompressed stream cap
    // (SANDBOX_MAX_STREAM_TAR_BYTES). The reason names the actual limit so
    // operators are not told "too large" when the baseline instead had too many
    // entries.
    const limit = baselineSafetyLimit(err);
    if (limit) {
      return {
        artifact: null,
        baseline: { ...baseline, reason: `${baseline.reason}:${limit}` },
      };
    }
    throw err;
  }
  return {
    artifact: {
      files: previous.files,
      manifest: previous.packageJson ?? null,
      suspiciousTarEntries: previous.suspiciousEntries,
    },
    baseline,
  };
}

function stagedTagFor(details: StagedDetails, manifest: PackageJsonSummary | null): string | null {
  const stagedDetails = details as StagedPublishDetails | null;
  if (hasMetadataMismatch(stagedDetails, manifest)) return null;
  return stagedDetails?.tag ?? null;
}

function hasMetadataMismatch(
  details: StagedPublishDetails | null | undefined,
  pkg: PackageJsonSummary | null,
): boolean {
  if (!details || !pkg) return false;
  if (details.packageName && pkg.name && details.packageName !== pkg.name) return true;
  if (details.version && pkg.version && details.version !== pkg.version) return true;
  return false;
}

/**
 * Classify a sandbox baseline-download failure into the specific safety limit it
 * hit, or null if it is an unrelated error that must still fail the scan. Only
 * whole-archive size limits (oversized tarball, decompression-bomb expansion,
 * too-many-files) degrade the baseline; the sandbox maps those to status 413, so
 * the status gates the branch and the error string names the cause. A malformed
 * baseline (truncated/invalid entry, status 400) still fails the scan.
 */
function baselineSafetyLimit(
  err: unknown,
): "baseline-too-large" | "baseline-too-many-files" | null {
  const detail = parseSandboxErrorDetail(err);
  if (!detail || detail.status !== 413) return null;
  const error = detail.error ?? "";
  if (error.includes("too many files")) return "baseline-too-many-files";
  if (error.includes("too large") || error.includes("safety limit")) return "baseline-too-large";
  return null;
}

function emptyBaseline(tag: string | null, reason: string): BaselineInfo {
  return {
    version: null,
    tag,
    source: "none",
    distTagVersion: null,
    reason,
  };
}
