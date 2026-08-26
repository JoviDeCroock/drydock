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
 * - `scan-registry-status` npm lifecycle identity, refresh and supersession
 * - `scan-approvals` the per-member votes a verdict is derived from
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
  SCAN_SOURCES,
  type ScanSource,
} from "./scan-jobs";

export { persistScan, type PersistedScanInput } from "./scan-persist";

export {
  backfillScanRegistryReleaseIdentity,
  getScanReleaseIdentity,
  listScansAwaitingRegistryStatus,
  markRegistryPublishReminderSent,
  recordRegistryVersionStatus,
  supersedeRegistryReleaseIncarnations,
  type RegistryStatusCandidate,
} from "./scan-registry-status";

export { LIST_SCANS_DEFAULT_LIMIT, LIST_SCANS_MAX_LIMIT, listScans } from "./scan-list";

export { getScan, getScanCompareData, getScanFile, getScanStatus } from "./scan-detail";

export {
  recordGatePackageDecision,
  recordScanDecisionProductEvents,
  recordScanDecision,
  SCAN_DECISION_FILTERS,
  SCAN_DECISIONS,
  type ScanDecision,
  type ScanDecisionFilter,
} from "./scan-decisions";

export {
  countScanApprovals,
  removeUserMembershipsAndReconcileApprovals,
  getOrganizationApprovalPolicy,
  listReadyPendingGates,
  loadScanApprovalState,
  MAX_REQUIRED_RELEASE_APPROVALS,
  setRequiredReleaseApprovals,
} from "./scan-approvals";
