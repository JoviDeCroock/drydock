/**
 * Scan artifacts: the scan body offloaded to R2.
 *
 * A completed scan's files, diff, and findings live here and nowhere else —
 * D1 keeps only the scan's metadata row. Writes fail closed and reads are
 * digest-verified. This stays the import path for all consumers; the
 * implementation is split by what it does to an artifact set:
 *
 * - `types`    stored shapes and caps
 * - `keys`     org-scoped R2 key layout
 * - `json-io`  the digest-verified put/get that everything else goes through
 * - `parse`    tolerant parsers for bodies read back
 * - `write` / `read` / `delete`   the three operations
 */

export {
  SCAN_ARTIFACT_WRITE_ATTEMPTS,
  SCAN_FILE_SAMPLE_LIMIT,
  type ScanArtifactMetadata,
} from "./types";

export { scanFileRowsForArtifacts, writeScanArtifacts, writeScanArtifactsWithRetry } from "./write";

export {
  loadScanArtifactFile,
  loadScanArtifactMetadata,
  loadScanArtifacts,
  scanArtifactReadBucket,
} from "./read";

export { deleteOrganizationArtifacts, deleteScanArtifacts } from "./delete";

export { projectAiReviewFindings } from "./parse";
