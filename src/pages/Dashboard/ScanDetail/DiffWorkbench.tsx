import type { DiffEntry, FileRecord } from "../../../../server/lib/review";
import type { PersistedScanDetail } from "../../../models/scan";
import { type DiffFinding, DiffView } from "../../../components/DiffView";
import { IndeterminateBar } from "../../../components/Loading";
import { EmptyLine, LoadingLine } from "../../../components/Typography";
import { hasNoLoadableBodyFlags, selectDiffWorkbenchState } from "./diff-helpers";

export function DiffWorkbench({
  entry,
  stagedMeta,
  staged,
  previousMeta,
  previousContent,
  compareReady,
  compareLoading,
  selectedVersion,
  stagedVersion,
  findings,
}: {
  entry: DiffEntry | null;
  stagedMeta: PersistedScanDetail["files"][number] | null;
  staged: PersistedScanDetail["files"][number] | null;
  previousMeta: FileRecord | null;
  previousContent: FileRecord | null;
  compareReady: boolean;
  compareLoading: boolean;
  selectedVersion: string | null;
  stagedVersion: string | null | undefined;
  findings: DiffFinding[];
}) {
  if (!entry) {
    return <DiffPanelMessage>Select a file from the tree to diff.</DiffPanelMessage>;
  }

  const state = selectDiffWorkbenchState({
    hasEntry: true,
    entryStatus: entry.status,
    hasStagedMeta: Boolean(stagedMeta),
    hasStagedContent: Boolean(staged),
    stagedHasNoLoadableBody: isPersistedUnpreviewable(stagedMeta),
    hasPreviousMeta: Boolean(previousMeta),
    hasPreviousContent: Boolean(previousContent),
    previousHasNoLoadableBody: isUnpreviewable(previousMeta),
    compareReady,
    compareLoading,
  });

  if (state.kind === "empty") {
    return <DiffPanelMessage>{state.message}</DiffPanelMessage>;
  }

  if (state.kind === "processing") {
    return <DiffProcessing title={state.title} detail={state.detail} />;
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
      findings={findings}
    />
  );
}

function isPersistedUnpreviewable(file: PersistedScanDetail["files"][number] | null): boolean {
  return hasNoLoadableBodyFlags(Array.isArray(file?.flagsJson) ? file.flagsJson : []);
}

function isUnpreviewable(file: FileRecord | null): boolean {
  return hasNoLoadableBodyFlags(file?.flags ?? []);
}

// A centered processing block that fills the diff panel so the "still working"
// signal is unmistakable while the previous version streams in — the file tree
// renders first, and the sandbox fetch of the previous tarball can take a
// minute. No spinner (DESIGN.md): mono line plus an indeterminate bar.
function DiffProcessing({ title, detail }: { title: string; detail: string }) {
  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-3 text-center min-h-0">
      <LoadingLine>{title}</LoadingLine>
      <IndeterminateBar class="w-48 max-w-full" />
      <p class="font-mono text-[11px] tracking-[0.02em] text-ink-subtle m-0">{detail}</p>
    </div>
  );
}

function DiffPanelMessage({ children }: { children: string }) {
  return (
    <div class="flex flex-1 flex-col items-center justify-center min-h-0">
      <EmptyLine>{children}</EmptyLine>
    </div>
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
