export interface NpmStageFollowUpScan {
  source?: string | null;
  registryVersionStatus?: string | null;
  registryStatusSupersededAt?: string | number | Date | null;
}

const STATUSES_WITHOUT_AN_ACTIONABLE_STAGE = new Set(["published", "blocked", "deleted"]);

/** Whether the UI may offer a web or CLI action against this scan's npm stage. */
export function canOfferNpmStageFollowUp(scan: NpmStageFollowUpScan): boolean {
  return (
    scan.source !== "workflow_gate" &&
    scan.registryStatusSupersededAt == null &&
    !STATUSES_WITHOUT_AN_ACTIONABLE_STAGE.has(scan.registryVersionStatus ?? "")
  );
}
