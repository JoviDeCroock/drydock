import { deleteArtifactsByPrefix } from "./json-io";
import { organizationArtifactPrefix, scanArtifactPrefix } from "./keys";
import type { ArtifactSweepResult } from "./types";
/**
 * Artifact deletion, by scan or by organization.
 */
export async function deleteOrganizationArtifacts(
  bucket: R2Bucket | undefined,
  organizationId: string,
): Promise<ArtifactSweepResult> {
  if (!bucket) return { ok: false, objectsDeleted: 0 };
  return deleteArtifactsByPrefix(bucket, organizationArtifactPrefix(organizationId), {
    organizationId,
    scope: "organization",
  });
}

export async function deleteScanArtifacts(
  bucket: R2Bucket | undefined,
  organizationId: string,
  scanId: string,
): Promise<ArtifactSweepResult> {
  if (!bucket) return { ok: false, objectsDeleted: 0 };
  return deleteArtifactsByPrefix(bucket, scanArtifactPrefix(organizationId, scanId), {
    organizationId,
    scanId,
    scope: "scan",
  });
}
