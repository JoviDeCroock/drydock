import { deleteArtifactsByPrefix } from "./json-io";
import { organizationArtifactPrefix, scanArtifactPrefix } from "./keys";
/**
 * Artifact deletion, by scan or by organization.
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
