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
    return cache[path] ?? (meta?.textSample || hasNoLoadableBody(meta) ? meta : null);
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
    if (meta.textSample || hasNoLoadableBody(meta)) return;
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
    if (meta.flags?.includes("binary") || meta.flags?.includes("content-skipped")) return;
    if (!version || !path) return;
    void model.loadPreviousFile(version, path);
  });

  return { stagedFileMeta, stagedFile, previousFileMeta, previousFile };
}

// A file whose body the scanner never captured as text: binary payloads (bytes
// but no text sample) and content-skipped entries (oversized bodies recorded as
// metadata only). Neither can be lazily fetched, so the UI shows the metadata
// placeholder instead of spinning on a load that would never resolve.
function hasNoLoadableBody(file: PersistedScanFile | null): boolean {
  if (!Array.isArray(file?.flagsJson)) return false;
  const flags = file.flagsJson as unknown[];
  return flags.includes("binary") || flags.includes("content-skipped");
}
