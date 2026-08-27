export interface NpmStageFollowUpScan {
  source?: string | null;
  registryVersionStatus?: string | null;
  registryStatusSupersededAt?: string | number | Date | null;
}

// Keep this aligned with `SETTLED_NPM_VERSION_STATUSES` in the server npm
// adapter without importing server runtime code into the client bundle.
const STATUSES_WITHOUT_AN_ACTIONABLE_STAGE = new Set(["published", "blocked", "deleted"]);

export function isSettledRegistryStatus(status: string | null | undefined): boolean {
  return STATUSES_WITHOUT_AN_ACTIONABLE_STAGE.has(status ?? "");
}

/** Whether the UI may offer a web or CLI action against this scan's npm stage. */
export function canOfferNpmStageFollowUp(scan: NpmStageFollowUpScan): boolean {
  return (
    scan.source !== "workflow_gate" &&
    scan.registryStatusSupersededAt == null &&
    !isSettledRegistryStatus(scan.registryVersionStatus)
  );
}
