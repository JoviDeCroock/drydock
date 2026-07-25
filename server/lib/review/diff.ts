import type { FileRecord } from "./";

export interface DiffEntry {
  path: string;
  status: "added" | "removed" | "modified" | "unchanged";
  previousSize?: number;
  stagedSize?: number;
  previousSha256?: string;
  stagedSha256?: string;
  flags: string[];
}

export function createPackageDiff(
  previousFiles: FileRecord[],
  stagedFiles: FileRecord[],
): DiffEntry[] {
  const previous = new Map(previousFiles.map((file) => [file.path, file]));
  const staged = new Map(stagedFiles.map((file) => [file.path, file]));
  const paths = [...new Set([...previous.keys(), ...staged.keys()])].sort();

  return paths.map((path) => {
    const before = previous.get(path);
    const after = staged.get(path);
    if (!before && after)
      return {
        path,
        status: "added",
        stagedSize: after.size,
        stagedSha256: after.sha256,
        flags: after.flags,
      };
    if (before && !after)
      return {
        path,
        status: "removed",
        previousSize: before.size,
        previousSha256: before.sha256,
        flags: before.flags,
      };
    // content-skipped bodies are hashed while being discarded, so a real,
    // equal hash pair proves an uninspected file is byte-identical to the
    // baseline and it can report as unchanged. A missing hash (legacy
    // artifacts persisted before skip-hashing) can't prove anything, so it
    // stays modified — fail visible, not silent.
    if (before && after && (!bothHashesKnown(before, after) || before.sha256 !== after.sha256)) {
      return {
        path,
        status: "modified",
        previousSize: before.size,
        stagedSize: after.size,
        previousSha256: before.sha256,
        stagedSha256: after.sha256,
        flags: [...new Set([...before.flags, ...after.flags])],
      };
    }
    return {
      path,
      status: "unchanged",
      previousSize: before?.size,
      stagedSize: after?.size,
      previousSha256: before?.sha256,
      stagedSha256: after?.sha256,
      flags: [...new Set([...(before?.flags || []), ...(after?.flags || [])])],
    };
  });
}

function bothHashesKnown(before: FileRecord, after: FileRecord): boolean {
  return before.sha256 !== "" && after.sha256 !== "";
}
