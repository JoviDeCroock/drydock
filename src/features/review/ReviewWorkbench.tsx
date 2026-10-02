import type { ComponentChildren } from "preact";
import { useComputed, type ReadonlySignal, type Signal } from "@preact/signals";
import type { DiffEntry } from "../../../server/lib/review";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { FileTree } from "../../components/FileTree";
import { Input } from "../../components/Input";
import { IndeterminateBar } from "../../components/Loading";
import { EmptyLine, LoadingLine, SectionLabel } from "../../components/Typography";
import { filterDiffEntries, type FindingCount } from "./diff-entries";

/** Stands in for the tree while its entries are not the comparison on screen. */
export interface TreeNotice {
  tone: "loading" | "unavailable";
  text: string;
  detail?: string;
  retry?: () => void;
}

/**
 * The release tree and the file diff, side by side — the pair every review
 * surface leads with (docs/design.md: the diff is the headline).
 *
 * Filter state arrives as signals and is read here rather than in the page
 * body, so typing in the filter box re-renders the tree alone. On the scan
 * detail the page body also renders the per-finding risk index, where a
 * keystroke-rate rerender costs seconds of main thread.
 */
export function ReviewWorkbench({
  entries,
  fileFilter,
  changedFilesOnly,
  selectedPath,
  findingCounts,
  treeNotice,
  onSelect,
  children,
  diffAside,
  id,
}: {
  id?: string;
  entries: ReadonlySignal<DiffEntry[]>;
  fileFilter: Signal<string>;
  changedFilesOnly: Signal<boolean>;
  selectedPath: ReadonlySignal<string | null>;
  findingCounts: ReadonlySignal<Map<string, FindingCount>>;
  // Replaces the tree (and its count) when the surface has no entries for the
  // comparison it shows yet, rather than rendering an empty or stale tree. The
  // surface reports that state here only, not again beside the picker or in
  // the diff panel.
  treeNotice?: ReadonlySignal<TreeNotice | null>;
  onSelect: (path: string) => void;
  // The diff panel for the selected file. Owned by the surface, because what a
  // "previous side" is differs: the scan detail refetches it through the org's
  // npm credentials, and a public report has none to spend.
  children: ComponentChildren;
  // A standing caveat about every diff this surface can show, said once on the
  // panel label instead of above each file. Omitted, the label keeps its plain
  // trailing rule.
  diffAside?: ComponentChildren;
}) {
  const visibleEntries = useComputed(() =>
    filterDiffEntries(entries.value, fileFilter.value, changedFilesOnly.value),
  );
  const notice = treeNotice?.value ?? null;

  // The tree caps at 720px rather than fixing that height, and the diff panel
  // is unconstrained (`DiffView` caps its own scroll region at 560px). The grid
  // stretches both to the taller of the two, so a two-line diff now sits in a
  // two-line card instead of 720px of empty space — which matters more now that
  // the workbench is the first thing on the page.
  return (
    <section
      id={id}
      tabIndex={id ? -1 : undefined}
      class="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)] gap-4"
    >
      <Card
        as="aside"
        padding="compact"
        class="flex flex-col gap-3 lg:max-h-[720px] overflow-hidden"
      >
        <SectionLabel as="h2">Release tree</SectionLabel>
        <Input
          type="search"
          value={fileFilter.value}
          placeholder="Filter files"
          onInput={(e) => (fileFilter.value = (e.target as HTMLInputElement).value)}
          autoComplete="off"
          spellcheck={false}
        />
        <div class="flex flex-wrap items-center justify-between gap-2">
          <label class="flex items-center gap-2 text-[13px] text-ink-muted">
            <input
              type="checkbox"
              checked={changedFilesOnly.value}
              onChange={(e) => (changedFilesOnly.value = (e.target as HTMLInputElement).checked)}
            />
            Changed files only
          </label>
          {notice ? null : (
            <span class="font-mono text-[11px] text-ink-subtle">
              {visibleEntries.value.length} / {entries.value.length}
            </span>
          )}
        </div>
        <div class="flex flex-col overflow-y-auto flex-1 min-h-0 border-t border-border pt-2">
          {notice?.tone === "loading" ? (
            <div class="flex flex-col gap-2 py-1">
              <LoadingLine size="inline">{notice.text}</LoadingLine>
              <IndeterminateBar />
            </div>
          ) : notice ? (
            <div class="flex flex-col gap-1 py-1">
              <EmptyLine>{notice.text}</EmptyLine>
              {notice.detail ? (
                <p class="m-0 font-mono text-[11px] text-ink-subtle break-words">{notice.detail}</p>
              ) : null}
              {notice.retry ? (
                <Button variant="secondary" size="sm" class="self-start" onClick={notice.retry}>
                  Try again
                </Button>
              ) : null}
            </div>
          ) : (
            <FileTree
              entries={visibleEntries.value}
              selectedPath={selectedPath.value}
              onSelect={onSelect}
              findingCounts={findingCounts.value}
            />
          )}
        </div>
      </Card>

      <Card padding="compact" class="flex flex-col gap-3 min-w-0">
        <SectionLabel as="h2" aside={diffAside}>
          File diff
        </SectionLabel>
        {children}
      </Card>
    </section>
  );
}
