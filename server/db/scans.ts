/**
 * Scan persistence.
 *
 * The scan table is read and written from routes, the queue consumer, gate
 * jobs and notifications, so this stays the one import path for all of it.
 * Implementations live in the sibling modules, split by what they do to a
 * scan rather than by which caller reaches for them:
 *
 * - `scan-jobs`      create / claim / fail / discard — lifecycle, no results
 * - `scan-persist`   the single writer of scan results, claim-guarded
 * - `scan-list`      the organization-scoped, keyset-paginated list
 * - `scan-detail`    reading one scan back, D1 rows merged with R2 artifacts
 * - `scan-decisions` publish / no-publish verdicts and their audit events
 * - `scan-risk`      persisted risk-summary readers shared by the above
 */

export { chunkForD1 } from "./d1-chunk";

export {
  claimScanForRun,
  createScanJob,
  deleteFailedScan,
  deletePendingScanJob,
  discardGateScans,
  discardScanAttempt,
  listExistingScanStageIds,
  markScanFailed,
  type CreateScanJobInput,
  type DeleteFailedScanResult,
  type ScanSource,
} from "./scan-jobs";

export { persistScan, type PersistedScanInput } from "./scan-persist";

export {
  LIST_SCANS_DEFAULT_LIMIT,
  LIST_SCANS_MAX_LIMIT,
  listScans,
  type ListScansOptions,
  type ListScansResult,
} from "./scan-list";

export {
  getScan,
  getScanCompareData,
  getScanFile,
  getScanStatus,
  type ScanDetailFileMode,
} from "./scan-detail";

export {
  recordGatePackageDecision,
  recordScanDecision,
  SCAN_DECISION_FILTERS,
  SCAN_DECISIONS,
  type RecordGatePackageDecisionInput,
  type RecordScanDecisionInput,
  type ScanDecision,
  type ScanDecisionFilter,
} from "./scan-decisions";
