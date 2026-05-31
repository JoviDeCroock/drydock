import { useSignalEffect, type ReadonlySignal } from "@preact/signals";
import type { ScanDetailModelInstance, ScanVersionsResponse } from "../../../../models/scan";

// Fetch version metadata as soon as we have a package name (don't wait for complete).
export function useScanVersions(
  model: ScanDetailModelInstance,
): ReadonlySignal<ScanVersionsResponse | null> {
  useSignalEffect(() => {
    if (!model.detail.value?.scan.packageName) return;
    if (model.versions.value) return;
    void model.loadVersions();
  });
  return model.versions;
}
