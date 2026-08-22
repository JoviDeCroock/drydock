import { SCAN_ARTIFACT_STORAGE_VERSION } from "./types";
/**
 * R2 key layout for scan artifacts.
 *
 * Keys embed the organization id, so an artifact read is org-scoped by
 * construction rather than by a check the caller has to remember. Every
 * segment is sanitized: an id is never interpolated into a key raw.
 */
export function artifactKeys(organizationId: string, scanId: string) {
  const base = `orgs/${safeSegment(organizationId)}/scans/${safeSegment(scanId)}/v${SCAN_ARTIFACT_STORAGE_VERSION}`;
  return {
    report: `${base}/report.json`,
    files: `${base}/files.json`,
    diff: `${base}/diff.json`,
    manifest: `${base}/manifest.json`,
  };
}

function safeSegment(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "~");
}

// Deletion prefixes intentionally stop *before* the `v{N}` segment so a cleanup
// removes every storage version of the scan/org, not just the current one. They
// must match the `artifactKeys` layout exactly or a sweep would miss objects.
export function organizationArtifactPrefix(organizationId: string): string {
  return `orgs/${safeSegment(organizationId)}/`;
}

export function scanArtifactPrefix(organizationId: string, scanId: string): string {
  return `orgs/${safeSegment(organizationId)}/scans/${safeSegment(scanId)}/`;
}
