import type { ScanStatus } from "./enums";

// Scan lifecycle constants shared by the `scans.ts` responsibility modules.
// A leaf so those modules never import each other for a constant.

export const NON_TERMINAL_STATUSES = [
  "pending",
  "running",
] as const satisfies readonly ScanStatus[];

/**
 * Column patch that retires a scan's registry incarnation: npm now serves a
 * newer stage for the same version, so its registry status and every public
 * surface derived from it must stop pointing at this row.
 */
export function registrySupersessionPatch(supersededAt: Date) {
  return {
    registryStatusSupersededAt: supersededAt,
    registryVersionStatus: null,
    registryVersionStatusAt: null,
    publicShareToken: null,
    publicSharedAt: null,
    publicSharedByUserId: null,
    publicShareIncludesFiles: false,
    publicFeedListedAt: null,
    publicPackageKey: null,
  };
}
