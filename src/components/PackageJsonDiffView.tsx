import type { PackageJsonDiff } from "../../server/types";
import {
  dependencyDeclarationKey,
  type DependencyEvidence,
} from "../../server/lib/review/dependency-evidence";
import { dependencyDiffHref, type DependencyDiffRow } from "../lib/package-diff-path";
import { dependencyEvidenceDomId } from "../lib/dependency-evidence-navigation";
import { Badge, statusTone } from "./Badge";
import { EmptyLine } from "./Typography";

// Structured manifest diff (scripts / dependencies / bin), shared by the scan
// detail report and the public package-diff page. `linkDependencyDiffs` adds a
// per-row link from added/bumped dependencies to that dependency's own public
// diff view; leave it off for ecosystems whose dependencies are not npm
// packages (PyPI).
export function PackageJsonDiffView({
  diff,
  linkDependencyDiffs,
  dependencyEvidenceByDeclaration,
}: {
  diff: PackageJsonDiff;
  linkDependencyDiffs?: boolean;
  dependencyEvidenceByDeclaration?: Record<string, DependencyEvidence>;
}) {
  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
        <InlineMeta label="package" value={diff.name || "unknown"} />
        <InlineMeta
          label="version"
          value={`${diff.previousVersion || "—"} → ${diff.stagedVersion || "—"}`}
        />
        <InlineMeta label="entrypoints" value={diff.entrypointsChanged ? "changed" : "unchanged"} />
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <ChangeList title="scripts" rows={diff.scripts} />
        <ChangeList
          title="dependencies"
          rows={diff.dependencies}
          linkFor={linkDependencyDiffs ? dependencyDiffHref : undefined}
          dependencyEvidenceByDeclaration={dependencyEvidenceByDeclaration}
        />
        {/* Only surfaced when present: most releases change no bin, and a new
            bin command is the install-path change flagged by diff.bin-added.
            Optional-chained for reports persisted before bin was diffed. */}
        {diff.bin?.length ? <ChangeList title="bin" rows={diff.bin} /> : null}
      </div>
    </div>
  );
}

export function hasManifestChanges(diff: PackageJsonDiff): boolean {
  return Boolean(
    diff.scripts.length || diff.dependencies.length || diff.bin?.length || diff.entrypointsChanged,
  );
}

function InlineMeta({ label, value }: { label: string; value: string }) {
  return (
    <div class="flex items-baseline gap-2 min-w-0">
      <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle flex-shrink-0">
        {label}
      </span>
      <code class="text-xs text-ink-muted break-words min-w-0">{value}</code>
    </div>
  );
}

function ChangeList({
  title,
  rows,
  linkFor,
  dependencyEvidenceByDeclaration,
}: {
  title: string;
  rows: DependencyDiffRow[];
  linkFor?: (row: DependencyDiffRow) => string | null;
  dependencyEvidenceByDeclaration?: Record<string, DependencyEvidence>;
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
            const section = row.section ?? "dependencies";
            const evidence =
              row.status === "added" && row.staged !== undefined
                ? dependencyEvidenceByDeclaration?.[
                    dependencyDeclarationKey(row.key, section, row.staged)
                  ]
                : null;
            return (
              <div
                // A key changed in two dependency sections at once yields two
                // rows for the same package name, so the section is part of
                // the identity.
                key={`${title}-${section}-${row.key}`}
                class="flex flex-col gap-1.5 px-3 py-2.5 text-[13px] min-w-0"
              >
                <div class="flex flex-wrap items-center gap-2 min-w-0">
                  <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  <code class="font-mono text-[12px] text-ink break-all min-w-0">{row.key}</code>
                  {evidence ? (
                    <a href={`#${dependencyEvidenceDomId(evidence)}`} class="no-underline">
                      <Badge tone={evidence.outcome === "inspected" ? "ok" : "medium"}>
                        {evidence.outcome === "inspected"
                          ? `reviewed ${evidence.resolution?.version ?? ""}`.trim()
                          : "uninspectable"}
                      </Badge>
                    </a>
                  ) : null}
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
          <EmptyLine>No {title} changes.</EmptyLine>
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
