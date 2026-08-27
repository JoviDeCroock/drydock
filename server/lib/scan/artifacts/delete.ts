import { deleteArtifactsByPrefix } from "./json-io";
import { organizationArtifactPrefix, scanArtifactPrefix } from "./keys";
import { emitOperationalEvent } from "../../platform/observability";
/**
 * Artifact deletion, by scan, by organization, or by completion-attempt run.
 */
export async function deleteOrganizationArtifacts(
  bucket: R2Bucket | undefined,
  organizationId: string,
): Promise<void> {
  if (!bucket) return;
  await deleteArtifactsByPrefix(bucket, organizationArtifactPrefix(organizationId), {
    organizationId,
    scope: "organization",
  });
}

export async function deleteScanArtifacts(
  bucket: R2Bucket | undefined,
  organizationId: string,
  scanId: string,
): Promise<void> {
  if (!bucket) return;
  await deleteArtifactsByPrefix(bucket, scanArtifactPrefix(organizationId, scanId), {
    organizationId,
    scanId,
    scope: "scan",
  });
}

/**
 * Drop the objects a single completion attempt wrote, for an attempt that then
 * lost the D1 claim.
 *
 * `artifactRunPrefix` must come from the in-memory `WrittenScanArtifacts` of the
 * attempt doing the discarding. Never reconstruct one by stripping a filename
 * off a persisted key: an object written before run-id prefixes existed strips
 * to `orgs/{org}/scans/{scan}/v1/`, and sweeping there would delete a live
 * artifact set.
 */
export async function discardScanArtifactRun(
  bucket: R2Bucket | undefined,
  args: { organizationId: string; scanId: string; artifactRunPrefix: string; reason: string },
): Promise<void> {
  if (!bucket) return;
  const logFields = {
    organizationId: args.organizationId,
    scanId: args.scanId,
    runPrefix: args.artifactRunPrefix,
    reason: args.reason,
  };
  if (!args.artifactRunPrefix.startsWith(scanArtifactPrefix(args.organizationId, args.scanId))) {
    emitOperationalEvent("error", "scan.artifacts.run_discard_rejected", logFields);
    return;
  }
  // Logged before the delete so a discarded run is on record even if the sweep
  // fails; an operator correlates it against this run id's `scan.artifacts.written`.
  emitOperationalEvent("warn", "scan.artifacts.run_discarded", logFields);
  // Prefix-based rather than four named keys so it cannot drift if another
  // artifact kind is added to the writer.
  await deleteArtifactsByPrefix(bucket, args.artifactRunPrefix, {
    organizationId: args.organizationId,
    scanId: args.scanId,
    scope: "run",
    reason: args.reason,
  });
}
