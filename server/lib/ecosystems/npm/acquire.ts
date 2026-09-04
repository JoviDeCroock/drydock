import { pickBaselineVersion } from "./registry";
import { BASELINE_TEXT_SAMPLE_LIMIT } from "../../sample-retention";
import { parseSandboxErrorDetail } from "../../sandbox";
import { emitOperationalEvent } from "../../platform/observability";
import type { PackageJsonSummary } from "../../review";
import {
  evaluateStagedArtifactIntegrity,
  type StagedArtifactIntegrity,
} from "../artifact-integrity";
import type { NpmStagedDetails, StagedPublishDetails } from "./staged-publishes";
import type {
  AcquiredArtifact,
  AdapterContext,
  BaselineInfo,
  StagedDetails,
} from "../package-adapter";
import { mergeStagedPackageJson } from "./findings";
import type { NpmStagePublisher } from "./publisher-identity";
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
  const [staged, initialStagedDetails] = await Promise.all([
    broker.downloadStaged(input.stageId, downloadOpts),
    broker.fetchStagedDetails(input.stageId),
  ]);

  // Bind the review to the bytes it reviewed before deriving any metadata from
  // the stage record. A mismatch re-read may discover that the stage changed
  // between the two initial requests, in which case every downstream field
  // must come from the same fresh record as the integrity verdict.
  const evaluated = await evaluateStagedArtifact(
    broker,
    input.stageId,
    initialStagedDetails,
    staged.archiveSha1,
  );
  const stagedDetails = evaluated.details;
  const artifactIntegrity = evaluated.integrity;

  // If staged metadata disagrees with the tarball we cannot trust it, so we
  // drop its package.json contribution. The mismatch itself surfaces as a
  // finding in runFindings.
  const metadataIsTrustworthy = !hasMetadataMismatch(stagedDetails, staged.packageJson ?? null);
  const mergedManifest = mergeStagedPackageJson(
    staged.packageJson ?? null,
    metadataIsTrustworthy ? (stagedDetails?.packageJson ?? null) : null,
  );

  const packageName = mergedManifest?.name ?? stagedDetails?.packageName ?? null;
  const version = mergedManifest?.version ?? stagedDetails?.version ?? null;
  if (artifactIntegrity.status === "mismatch") {
    emitOperationalEvent("warn", "scan.staged_artifact.digest_mismatch", {
      stageId: input.stageId,
      packageName,
      version,
      algorithm: artifactIntegrity.algorithm,
      declaredDigest: artifactIntegrity.declared,
      computedDigest: artifactIntegrity.computed,
    });
  } else if (artifactIntegrity.status === "unverified") {
    // Verification silently covering nothing looks exactly like verification
    // working, so an unprovable scan is reported too: a registry that stops
    // returning digests, or a cap that starts biting, is a coverage outage
    // rather than a per-scan curiosity.
    emitOperationalEvent("info", "scan.staged_artifact.digest_unverified", {
      stageId: input.stageId,
      packageName,
      version,
      algorithm: artifactIntegrity.algorithm,
      reason: artifactIntegrity.reason ?? null,
    });
  }

  // Trust configs need the org token and the package name; the staged
  // version's own attestation is public and normally 404s until approval.
  // Both are fetched once here, and the previous version's build identity
  // joins the block once the baseline step has chosen that version.
  const [trustLookup, stagedBuild] = await Promise.all([
    broker.fetchTrustConfigs(packageName),
    broker.fetchBuildIdentity(packageName, version),
  ]);
  const publisher: NpmStagePublisher = {
    actor: stagedDetails?.actor ?? null,
    actorType: stagedDetails?.actorType ?? null,
    trustConfigs: trustLookup.state === "checked" ? trustLookup.configs : null,
    trustConfigsState: trustLookup.state,
    previousBuild: null,
    stagedBuild,
  };

  return {
    artifact: {
      files: staged.files,
      manifest: mergedManifest,
      suspiciousTarEntries: staged.suspiciousEntries,
    },
    // Persist an explicit unverified verdict even when the registry's detail
    // request failed. Otherwise a newly unbound scan is indistinguishable from
    // a legacy scan that predates artifact verification.
    details: withArtifactIntegrity(input.stageId, stagedDetails, artifactIntegrity, publisher),
  };
}

/**
 * Fill in the previous version's build identity after baseline selection.
 * The details object is the adapter's own, created above, so the staged
 * adapter completes it in place rather than re-deriving the baseline here.
 */
export async function attachPreviousBuildIdentity(
  broker: NpmBroker,
  details: NpmStagedDetails,
  packageName: string | null,
  previousVersion: string | null,
): Promise<void> {
  if (!previousVersion) return;
  details.publisher.previousBuild = await broker.fetchBuildIdentity(packageName, previousVersion);
}

interface EvaluatedStagedArtifact {
  details: StagedPublishDetails | null;
  integrity: StagedArtifactIntegrity;
}

/**
 * Compare the downloaded bytes against npm's stage record, confirming a
 * mismatch against a second read of the record before it becomes an
 * accusation.
 *
 * The bytes and the digest they are checked against arrive from two
 * independent requests, so a stage rewritten between them — or a replica
 * serving a record from a different generation — would otherwise raise a
 * critical finding about two artifacts that were each internally consistent.
 * Only the disagreeing case pays for the extra fetch. If that confirmation is
 * unavailable, the review remains explicitly unverified: the original pair of
 * digests may describe two different generations of the same mutable stage.
 */
async function evaluateStagedArtifact(
  broker: NpmBroker,
  stageId: string,
  stagedDetails: StagedPublishDetails | null,
  computedSha1: string | null | undefined,
): Promise<EvaluatedStagedArtifact> {
  const verdict = evaluateStagedArtifactIntegrity(stagedDetails?.shasum, computedSha1);
  if (verdict.status !== "mismatch") return { details: stagedDetails, integrity: verdict };
  const confirmation = await broker.fetchStagedDetails(stageId);
  if (!confirmation) {
    return {
      details: stagedDetails,
      integrity: {
        ...verdict,
        status: "unverified",
        reason: "stage-record-confirmation-unavailable",
      },
    };
  }
  return {
    details: confirmation,
    integrity: evaluateStagedArtifactIntegrity(confirmation.shasum, computedSha1),
  };
}

function withArtifactIntegrity(
  stageId: string,
  details: StagedPublishDetails | null,
  artifactIntegrity: StagedArtifactIntegrity,
  publisher: NpmStagePublisher,
): NpmStagedDetails {
  return {
    id: details?.id ?? stageId,
    packageName: details?.packageName ?? null,
    version: details?.version ?? null,
    tag: details?.tag ?? null,
    access: details?.access ?? null,
    actor: details?.actor ?? null,
    actorType: details?.actorType ?? null,
    createdAt: details?.createdAt ?? null,
    shasum: details?.shasum ?? null,
    packageJson: details?.packageJson ?? null,
    artifactIntegrity,
    publisher,
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
      // The baseline's text samples are diff/annotation context only — never
      // the reviewed release, never persisted — so they are clipped inside the
      // sandbox instead of shipping whole bodies of both package sides.
      maxTextSampleChars: BASELINE_TEXT_SAMPLE_LIMIT,
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
