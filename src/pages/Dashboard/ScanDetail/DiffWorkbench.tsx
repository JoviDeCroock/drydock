import type { DiffEntry, FileRecord } from "../../../../server/lib/review";
import type { PersistedScanDetail } from "../../../models/scan";
import { DiffView, EmptyLine, LoadingLine } from "../../../components";

export function DiffWorkbench({
  entry,
  staged,
  previousMeta,
  previousContent,
  compareReady,
  selectedVersion,
  stagedVersion,
}: {
  entry: DiffEntry | null;
  staged: PersistedScanDetail["files"][number] | null;
  previousMeta: FileRecord | null;
  previousContent: FileRecord | null;
  compareReady: boolean;
  selectedVersion: string | null;
  stagedVersion: string | null | undefined;
}) {
  if (!entry) {
    return <EmptyLine>Select a file from the tree to diff.</EmptyLine>;
  }

  const needsPrevious = entry.status !== "added";
  const isBinaryPrev = Boolean(previousMeta?.flags?.includes("binary"));

  if (needsPrevious && !compareReady && entry.status !== "unchanged") {
    return <LoadingLine size="inline">Loading comparison</LoadingLine>;
  }

  if (needsPrevious && previousMeta && !isBinaryPrev && !previousContent) {
    return <LoadingLine size="inline">Loading file content</LoadingLine>;
  }

  if (!staged && !previousContent && !previousMeta) {
    return <EmptyLine>No file content available.</EmptyLine>;
  }

  return (
    <DiffView
      path={entry.path}
      status={entry.status}
      beforeLabel={selectedVersion ? `previous (${selectedVersion})` : "previous"}
      afterLabel={`staged (${stagedVersion ?? "current"})`}
      before={
        previousContent
          ? toDiffSide(previousContent)
          : previousMeta
            ? toDiffSide(previousMeta)
            : null
      }
      after={staged ? scanFileToDiffSide(staged) : null}
    />
  );
}

function scanFileToDiffSide(file: PersistedScanDetail["files"][number]) {
  return {
    textSample: file.textSample,
    size: file.size,
    sha256: file.sha256,
    flags: Array.isArray(file.flagsJson) ? (file.flagsJson as string[]) : [],
  };
}

function toDiffSide(file: FileRecord) {
  return {
    textSample: file.textSample,
    size: file.size,
    sha256: file.sha256,
    flags: file.flags,
  };
}
