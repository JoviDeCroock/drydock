import type { ComponentChildren } from "preact";
import { useComputed, type ReadonlySignal, type Signal } from "@preact/signals";
import type { DiffEntry } from "../../../server/lib/review";
import { Card } from "../../components/Card";
import { FileTree } from "../../components/FileTree";
import { Input } from "../../components/Input";
import { SectionLabel } from "../../components/Typography";
import { filterDiffEntries, type FindingCount } from "./diff-entries";

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
  onSelect,
  children,
}: {
  entries: ReadonlySignal<DiffEntry[]>;
  fileFilter: Signal<string>;
  changedFilesOnly: Signal<boolean>;
  selectedPath: ReadonlySignal<string | null>;
  findingCounts: ReadonlySignal<Map<string, FindingCount>>;
  onSelect: (path: string) => void;
  // The diff panel for the selected file. Owned by the surface, because what a
  // "previous side" is differs: the scan detail refetches it through the org's
  // npm credentials, and a public report has none to spend.
  children: ComponentChildren;
}) {
  const visibleEntries = useComputed(() =>
    filterDiffEntries(entries.value, fileFilter.value, changedFilesOnly.value),
  );

  // The tree caps at 720px rather than fixing that height, and the diff panel
  // is unconstrained (`DiffView` caps its own scroll region at 560px). The grid
  // stretches both to the taller of the two, so a two-line diff now sits in a
  // two-line card instead of 720px of empty space — which matters more now that
  // the workbench is the first thing on the page.
  return (
    <section class="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)] gap-4">
      <Card as="aside" class="p-5 flex flex-col gap-3 lg:max-h-[720px] overflow-hidden">
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
          <span class="font-mono text-[11px] text-ink-subtle">
            {visibleEntries.value.length} / {entries.value.length}
          </span>
        </div>
        <div class="flex flex-col overflow-y-auto flex-1 min-h-0 border-t border-border pt-2">
          <FileTree
            entries={visibleEntries.value}
            selectedPath={selectedPath.value}
            onSelect={onSelect}
            findingCounts={findingCounts.value}
          />
        </div>
      </Card>

      <Card class="p-5 flex flex-col gap-3 min-w-0">
        <SectionLabel as="h2">File diff</SectionLabel>
        {children}
      </Card>
    </section>
  );
}
