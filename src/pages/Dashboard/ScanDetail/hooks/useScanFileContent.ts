import { useComputed, useSignalEffect, type ReadonlySignal } from "@preact/signals";
import type { FileRecord } from "../../../../../server/lib/review";
import type { ScanDetailModelInstance } from "../../../../models/scan";

export interface ScanFileContent {
  previousFileMeta: ReadonlySignal<FileRecord | null>;
  previousFile: ReadonlySignal<FileRecord | null>;
}

// Owns the previous-file metadata/content computeds and lazily fetches the
// previous file body once the user has picked both a file and a version.
export function useScanFileContent(
  model: ScanDetailModelInstance,
  selectedPath: ReadonlySignal<string | null>,
  selectedVersion: ReadonlySignal<string | null>,
): ScanFileContent {
  const previousFileMeta = useComputed(() => {
    const path = selectedPath.value;
    const compare = model.compare.value;
    if (!path || !compare) return null;
    return compare.files.find((file) => file.path === path) ?? null;
  });

  const previousFileKey = useComputed(() => {
    const version = selectedVersion.value;
    const path = selectedPath.value;
    return version && path ? `${version}::${path}` : null;
  });

  const previousFile = useComputed(() => {
    const key = previousFileKey.value;
    const cache = model.fileContentCache.value;
    return key ? (cache[key] ?? null) : null;
  });

  useSignalEffect(() => {
    const key = previousFileKey.value;
    const cache = model.fileContentCache.value;
    const meta = previousFileMeta.value;
    const version = selectedVersion.value;
    const path = selectedPath.value;
    if (!key) return;
    if (cache[key]) return;
    if (!meta) return;
    if (meta.flags?.includes("binary")) return;
    if (!version || !path) return;
    void model.loadPreviousFile(version, path);
  });

  return { previousFileMeta, previousFile };
}
