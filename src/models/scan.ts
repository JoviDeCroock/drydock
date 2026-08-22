/**
 * Scan models.
 *
 * Stays the import path for the whole dashboard; the implementation is split
 * into the HTTP surface (`scan-api`) and the two independent models built on
 * it (`scan-list-model`, `scan-detail-model`). Re-exports exactly what
 * consumers use — the fetch helpers stay internal to the models.
 */

export {
  publicReportAttestationUrl,
  scanMatchesDecisionFilter,
  type DecisionStatus,
  type DeleteStatus,
  type PersistedReleaseAuthority,
  type PersistedScanDetail,
  type PublicShareInfo,
  type ScanCompareResponse,
  type ScanDecision,
  type ScanDecisionFilter,
  type ScanListItem,
  type ScanVersionsResponse,
} from "./scan-api";

export { ScanListModel } from "./scan-list-model";

export {
  SCAN_POLL_BASE_DELAY_MS,
  SCAN_POLL_MAX_DELAY_MS,
  SCAN_POLL_STALL_AFTER_MS,
  ScanDetailModel,
  type ScanDetailModelInstance,
} from "./scan-detail-model";
