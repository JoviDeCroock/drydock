import type { DiffEntry } from "../../../server/lib/review";
import type { PublicReportFile } from "../../models/public-report";
import { hasNoLoadableBody } from "../../features/review/diff-entries";
import { type DiffFinding, DiffView } from "../../components/DiffView";
import { IndeterminateBar } from "../../components/Loading";
import { EmptyLine, LoadingLine } from "../../components/Typography";

/**
 * The file diff on a shared public report.
 *
 * Single-sided by construction: the share token buys the staged artifact's
 * redacted samples and nothing else, because reaching the published previous
 * version means spending the organization's npm credentials. `DiffView` keeps
 * the release's own status label and pins the findings to their staged lines,
 * so the reader still sees which lines a rule matched — they just do not get
 * the baseline text next to it. The page says so once, as the panel label's
 * aside (`REPORT_DIFF_ASIDE`), rather than letting the missing side read as
 * "nothing changed here" — and rather than repeating it above every file.
 */
export const REPORT_DIFF_ASIDE = "staged side only";

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

  if (!file && loading && !missing && !hasNoLoadableBody(entry.flags)) {
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

  // A file with no sample still goes through DiffView: its binary / no-sample
  // fallback keeps the path, the format badges, the size and digest, and this
  // file's findings, which are all the evidence there is.
  return (
    <DiffView
      path={entry.path}
      status={entry.status}
      beforeLabel="previous"
      afterLabel={`staged (${stagedVersion ?? "current"})`}
      before={null}
      after={
        file
          ? {
              textSample: file.textSample,
              size: file.size,
              sha256: file.sha256,
              flags: Array.isArray(file.flagsJson)
                ? file.flagsJson.filter((flag): flag is string => typeof flag === "string")
                : [],
            }
          : { size: entry.stagedSize, sha256: entry.stagedSha256, flags: entry.flags }
      }
      findings={findings}
    />
  );
}

function PanelMessage({ children }: { children: string }) {
  return (
    <div class="flex flex-1 flex-col items-center justify-center min-h-0">
      <EmptyLine>{children}</EmptyLine>
    </div>
  );
}
