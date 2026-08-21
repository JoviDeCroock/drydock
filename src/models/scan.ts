/**
 * Scan models.
 *
 * Stays the import path for the whole dashboard; the implementation is split
 * into the HTTP surface (`scan-api`) and the two independent models built on
 * it (`scan-list-model`, `scan-detail-model`).
 */

export * from "./scan-api";
export { ScanListModel } from "./scan-list-model";
export {
  SCAN_POLL_BASE_DELAY_MS,
  SCAN_POLL_MAX_DELAY_MS,
  SCAN_POLL_STALL_AFTER_MS,
  ScanDetailModel,
  type ScanDetailModelInstance,
} from "./scan-detail-model";
