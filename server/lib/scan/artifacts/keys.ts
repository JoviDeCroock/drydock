import { SCAN_ARTIFACT_STORAGE_VERSION } from "./types";
/**
 * R2 key layout for scan artifacts.
 *
 * Keys embed the organization id, so an artifact read is org-scoped by
 * construction rather than by a check the caller has to remember. Every
 * segment is sanitized: an id is never interpolated into a key raw.
 *
 * Keys also embed a per-write-attempt run id. Two completion attempts for one
 * scan therefore address disjoint object sets, so a stale attempt cannot
 * overwrite the bytes a committed D1 row points at. The read path resolves keys
 * from the persisted columns rather than recomputing them, so objects written
 * before run ids existed stay readable at their run-id-less keys.
 */
export function scanArtifactRunPrefix(
  organizationId: string,
  scanId: string,
  runId: string,
): string {
  const scanPrefix = scanArtifactPrefix(organizationId, scanId);
  return `${scanPrefix}v${SCAN_ARTIFACT_STORAGE_VERSION}/${safeSegment(runId)}/`;
}

export function artifactKeys(organizationId: string, scanId: string, runId: string) {
  const base = scanArtifactRunPrefix(organizationId, scanId, runId);
  return {
    report: `${base}report.json`,
    files: `${base}files.json`,
    diff: `${base}diff.json`,
    manifest: `${base}manifest.json`,
  };
}

function safeSegment(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "~");
}

// Deletion prefixes intentionally stop *before* the `v{N}` segment so a cleanup
// removes every storage version of the scan/org, not just the current one — and,
// for the same reason, every run prefix under it. They must match the
// `artifactKeys` layout exactly or a sweep would miss objects.
export function organizationArtifactPrefix(organizationId: string): string {
  return `orgs/${safeSegment(organizationId)}/`;
}

export function scanArtifactPrefix(organizationId: string, scanId: string): string {
  return `orgs/${safeSegment(organizationId)}/scans/${safeSegment(scanId)}/`;
}
