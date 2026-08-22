/**
 * Scan artifacts: the scan body offloaded to R2.
 *
 * New artifact-backed scans keep files/findings here; legacy or degraded scans
 * can retain them in D1. R2 reads are digest-verified. This stays the import
 * path for all consumers; the implementation is split by what it does to an
 * artifact set:
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
  type ScanArtifactFileRow,
  type ScanArtifactMetadata,
} from "./types";

export { maybeWriteScanArtifacts, scanFileRowsForArtifacts, writeScanArtifacts } from "./write";

export {
  loadScanArtifactFile,
  loadScanArtifactMetadata,
  loadScanArtifacts,
  scanArtifactReadBucket,
} from "./read";

export { deleteOrganizationArtifacts, deleteScanArtifacts } from "./delete";

export { projectAiReviewFindings } from "./parse";
