import { useComputed, useSignalEffect, type ReadonlySignal } from "@preact/signals";
import type { FileRecord } from "../../../../../server/lib/review";
import type { PersistedScanDetail, ScanDetailModelInstance } from "../../../../models/scan";

type PersistedScanFile = PersistedScanDetail["files"][number];

export interface ScanFileContent {
  stagedFileMeta: ReadonlySignal<PersistedScanFile | null>;
  stagedFile: ReadonlySignal<PersistedScanFile | null>;
  previousFileMeta: ReadonlySignal<FileRecord | null>;
  previousFile: ReadonlySignal<FileRecord | null>;
}

// Owns file metadata/content computeds and lazily fetches file bodies once the
// user has selected a path. The detail payload carries metadata only.
export function useScanFileContent(
  model: ScanDetailModelInstance,
  selectedPath: ReadonlySignal<string | null>,
  selectedVersion: ReadonlySignal<string | null>,
): ScanFileContent {
  const stagedFileMeta = useComputed(() => {
    const path = selectedPath.value;
    const detail = model.detail.value;
    if (!path) return null;
    return detail?.files.find((file) => file.path === path) ?? null;
  });

  const stagedFile = useComputed(() => {
    const path = selectedPath.value;
    const cache = model.stagedFileContentCache.value;
    const meta = stagedFileMeta.value;
    if (!path) return null;
    return cache[path] ?? (meta?.textSample || isPersistedBinary(meta) ? meta : null);
  });

  const previousFileMeta = useComputed(() => {
    const path = selectedPath.value;
    const compare = model.compare.value;
    if (!path || !compare) return null;
    return compare.files.find((file) => file.path === path) ?? null;
  });

  useSignalEffect(() => {
    const path = selectedPath.value;
    const meta = stagedFileMeta.value;
    const cache = model.stagedFileContentCache.value;
    if (!path) return;
    if (cache[path]) return;
    if (!meta) return;
    if (meta.textSample || isPersistedBinary(meta)) return;
    void model.loadStagedFile(path);
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

  return { stagedFileMeta, stagedFile, previousFileMeta, previousFile };
}

function isPersistedBinary(file: PersistedScanFile | null): boolean {
  return Array.isArray(file?.flagsJson) && (file.flagsJson as unknown[]).includes("binary");
}
