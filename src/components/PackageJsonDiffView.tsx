import type { PackageJsonDiff } from "../../server/types";
import { dependencyDiffHref, type DependencyDiffRow } from "../lib/package-diff-path";
import { Badge, statusTone } from "./Badge";
import { EmptyLine } from "./Typography";

// Structured manifest diff (scripts / dependencies / bin), shared by the scan
// detail report and the public package-diff page. `linkDependencyDiffs` adds a
// per-row link from added/bumped dependencies to that dependency's own public
// diff view; leave it off for ecosystems whose dependencies are not npm
// packages (PyPI).
//
// The package name and version pair are left to the caller: the page heading
// already names the package, and only the caller knows whether the manifest's
// version pair adds anything to what its header shows (see
// `manifestVersionRange`).
export function PackageJsonDiffView({
  diff,
  linkDependencyDiffs,
}: {
  diff: PackageJsonDiff;
  linkDependencyDiffs?: boolean;
}) {
  // Empty change lists collapse into one line rather than a pair of empty
  // bordered cards; once any list has rows, the empty ones keep their card so
  // "no script changes" stays stated beside the dependency changes.
  if (!hasManifestChanges(diff)) {
    return <EmptyLine>No script, dependency, bin, or entrypoint changes.</EmptyLine>;
  }
  const hasListChanges = Boolean(
    diff.scripts.length || diff.dependencies.length || diff.bin?.length,
  );
  return (
    <div class={hasListChanges ? "flex flex-col gap-4" : "flex flex-col gap-2"}>
      <div class="flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
        <InlineMeta label="entrypoints" value={diff.entrypointsChanged ? "changed" : "unchanged"} />
      </div>
      {hasListChanges ? (
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <ChangeList title="scripts" noun="script" rows={diff.scripts} />
          <ChangeList
            title="dependencies"
            noun="dependency"
            rows={diff.dependencies}
            linkFor={linkDependencyDiffs ? dependencyDiffHref : undefined}
          />
          {/* Only surfaced when present: most releases change no bin, and a new
              bin command is the install-path change flagged by diff.bin-added.
              Optional-chained for reports persisted before bin was diffed. */}
          {diff.bin?.length ? <ChangeList title="bin" noun="bin" rows={diff.bin} /> : null}
        </div>
      ) : (
        <EmptyLine>No script, dependency, or bin changes.</EmptyLine>
      )}
    </div>
  );
}

/**
 * The manifest's own version pair (`1.0.0 → 1.0.1`), or null for a first
 * release, where the staged version alone would repeat the page header.
 */
export function manifestVersionRange(diff: PackageJsonDiff): string | null {
  if (!diff.previousVersion || !diff.stagedVersion) return null;
  return `${diff.previousVersion} → ${diff.stagedVersion}`;
}

export function hasManifestChanges(diff: PackageJsonDiff): boolean {
  return Boolean(
    diff.scripts.length || diff.dependencies.length || diff.bin?.length || diff.entrypointsChanged,
  );
}

function InlineMeta({ label, value }: { label: string; value: string }) {
  return (
    <div class="flex items-baseline gap-2 min-w-0">
      <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle shrink-0">
        {label}
      </span>
      <code class="text-xs text-ink-muted break-words min-w-0">{value}</code>
    </div>
  );
}

function ChangeList({
  title,
  noun,
  rows,
  linkFor,
}: {
  title: string;
  // Singular attributive form for the empty line: "No dependency changes."
  noun: string;
  rows: DependencyDiffRow[];
  linkFor?: (row: DependencyDiffRow) => string | null;
}) {
  return (
    <div class="border border-border rounded-lg overflow-hidden">
      <div class="px-3 py-2 bg-surface-2 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
        {title} ({rows.length})
      </div>
      {rows.length ? (
        <div class="divide-y divide-border">
          {rows.map((row) => {
            const href = linkFor ? linkFor(row) : null;
            return (
              <div
                // A key changed in two dependency sections at once yields two
                // rows for the same package name, so the section is part of
                // the identity.
                key={`${title}-${row.section ?? ""}-${row.key}`}
                class="flex flex-col gap-1.5 px-3 py-2.5 text-[13px] min-w-0"
              >
                <div class="flex flex-wrap items-center gap-2 min-w-0">
                  <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  <code class="font-mono text-[12px] text-ink break-all min-w-0">{row.key}</code>
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      class="ml-auto font-mono text-[11px] text-ink-muted underline hover:text-ink whitespace-nowrap"
                      aria-label={`Open the ${row.key} package diff in a new tab`}
                    >
                      view diff
                    </a>
                  ) : null}
                </div>
                <ChangeValue status={row.status} previous={row.previous} staged={row.staged} />
              </div>
            );
          })}
        </div>
      ) : (
        <div class="px-3 py-3">
          <EmptyLine>No {noun} changes.</EmptyLine>
        </div>
      )}
    </div>
  );
}

function ChangeValue({
  status,
  previous,
  staged,
}: {
  status: "added" | "removed" | "modified";
  previous?: string;
  staged?: string;
}) {
  if (status === "added") {
    return (
      <code class="font-mono text-[11px] leading-[1.55] text-ink-muted break-words whitespace-pre-wrap">
        {staged || "—"}
      </code>
    );
  }
  if (status === "removed") {
    return (
      <code class="font-mono text-[11px] leading-[1.55] text-ink-subtle break-words whitespace-pre-wrap line-through decoration-1">
        {previous || "—"}
      </code>
    );
  }
  return (
    <div class="flex flex-col gap-1 font-mono text-[11px] leading-[1.55]">
      <code class="text-ink-subtle break-words whitespace-pre-wrap">
        <span class="text-ink-subtle mr-1.5 select-none">−</span>
        {previous || "—"}
      </code>
      <code class="text-ink-muted break-words whitespace-pre-wrap">
        <span class="text-ink-subtle mr-1.5 select-none">+</span>
        {staged || "—"}
      </code>
    </div>
  );
}
