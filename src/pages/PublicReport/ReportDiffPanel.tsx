import type { DiffEntry } from "../../../server/lib/review";
import { hasNoLoadableBody, type PublicReportFile } from "../../models/public-report";
import { type DiffFinding, DiffView } from "../../components/DiffView";
import { IndeterminateBar } from "../../components/Loading";
import { EmptyLine, LoadingLine } from "../../components/Typography";

/**
 * The file diff on a shared public report.
 *
 * Single-sided by construction: the share token buys the staged artifact's
 * redacted samples and nothing else, because reaching the published previous
 * version means spending the organization's npm credentials. `DiffView` keeps
 * the release's own status badge and pins the findings to their staged lines,
 * so the reader still sees which lines a rule matched — they just do not get
 * the baseline text next to it. Say so rather than letting the missing side
 * read as "nothing changed here".
 */
export function ReportDiffPanel({
  entry,
  file,
  loading,
  missing,
  stagedVersion,
  findings,
}: {
  entry: DiffEntry | null;
  file: PublicReportFile | null;
  loading: boolean;
  missing: boolean;
  stagedVersion: string | null;
  findings: DiffFinding[];
}) {
  if (!entry) {
    return <PanelMessage>Select a file from the release tree to read it.</PanelMessage>;
  }

  if (entry.status === "removed") {
    return (
      <PanelMessage>
        Removed in this release. The published file's contents belong to the previous version, which
        a shared report does not carry.
      </PanelMessage>
    );
  }

  if (!file) {
    if (missing || hasNoLoadableBody(entry.flags)) {
      return <PanelMessage>No text sample was retained for this file.</PanelMessage>;
    }
    if (loading) {
      return (
        <div class="flex flex-1 flex-col items-center justify-center gap-3 text-center min-h-0">
          <LoadingLine>Loading file</LoadingLine>
          <IndeterminateBar class="w-48 max-w-full" />
          <p class="font-mono text-[11px] tracking-[0.02em] text-ink-subtle m-0">
            fetching the reviewed sample
          </p>
        </div>
      );
    }
    return <PanelMessage>No text sample was retained for this file.</PanelMessage>;
  }

  return (
    <div class="flex flex-col gap-3 min-h-0">
      {entry.status === "modified" ? (
        <p class="m-0 font-mono text-[11px] text-ink-subtle">
          Shared reports carry the reviewed release only: modified files show the staged side with
          findings pinned, not a side-by-side against the previous version.
        </p>
      ) : null}
      <DiffView
        path={entry.path}
        status={entry.status}
        beforeLabel="previous"
        afterLabel={`staged (${stagedVersion ?? "current"})`}
        before={null}
        after={{
          textSample: file.textSample,
          size: file.size,
          sha256: file.sha256,
          flags: Array.isArray(file.flagsJson)
            ? file.flagsJson.filter((flag): flag is string => typeof flag === "string")
            : [],
        }}
        findings={findings}
      />
    </div>
  );
}

function PanelMessage({ children }: { children: string }) {
  return (
    <div class="flex flex-1 flex-col items-center justify-center min-h-0">
      <EmptyLine>{children}</EmptyLine>
    </div>
  );
}
