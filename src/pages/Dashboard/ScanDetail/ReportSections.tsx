import type { ComponentChildren } from "preact";
import type { DisplayedAiResult } from "../../../../server/lib/ai-review-types";
import type { PackageJsonDiff, ReleaseProvenance } from "../../../../server/types";
import { Badge, severityTone, statusTone } from "../../../components/Badge";
import { EmptyLine, SectionLabel } from "../../../components/Typography";
import type { PersistedSummary } from "./types";

export function PersistedReportSections({
  summary,
  ai,
}: {
  summary: PersistedSummary;
  ai: DisplayedAiResult | null;
}) {
  return (
    <section class="flex flex-col gap-6">
      <ReportSection title="Manifest changes">
        {summary.packageJsonDiff ? (
          <PackageJsonDiffView diff={summary.packageJsonDiff} />
        ) : (
          <EmptyLine>No manifest changes were saved for this review.</EmptyLine>
        )}
      </ReportSection>

      {summary.stagedPublish?.provenance?.artifacts?.length ? (
        <ReportSection title="Provenance">
          <ProvenanceView provenance={summary.stagedPublish.provenance} />
        </ReportSection>
      ) : null}

      {ai != null && ai.model != null && (
        <ReportSection title="Reviewer notes">
          {ai.kind === "complete" ? (
            <>
              <div class="flex flex-wrap gap-2">
                <Badge tone={severityTone(ai.risk)}>{ai.risk}</Badge>
                <Badge tone={ai.requiresManualReview ? "medium" : "ok"}>
                  {ai.requiresManualReview ? "manual review" : "no extra review"}
                </Badge>
                <Badge tone="neutral">{ai.releaseAssessment.replaceAll("_", " ")}</Badge>
              </div>
              {/* The reviewer's findings render once, as assistant-badged cards
                  in the Risk signals section (they persist as scan_findings
                  rows). This panel carries only the narrative verdict — summary
                  plus the assessment badges above — so a finding is never shown
                  twice on the page. */}
              {ai.summary ? (
                <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">{ai.summary}</p>
              ) : null}
            </>
          ) : (
            <>
              <div class="flex flex-wrap gap-2">
                <Badge tone="neutral">assistant unavailable</Badge>
              </div>
              {ai.summary ? (
                <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">{ai.summary}</p>
              ) : null}
            </>
          )}
        </ReportSection>
      )}
    </section>
  );
}

function ReportSection({
  title,
  children,
  class: className,
}: {
  title: string;
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <section class={`flex flex-col gap-3 min-w-0 ${className || ""}`}>
      <SectionLabel>{title}</SectionLabel>
      {children}
    </section>
  );
}

function ProvenanceView({ provenance }: { provenance: ReleaseProvenance }) {
  const ecosystem =
    provenance.ecosystem === "pypi"
      ? "PyPI"
      : provenance.ecosystem === "vscode"
        ? "VS Code"
        : provenance.ecosystem === "composer"
          ? "Composer"
          : "npm";
  return (
    <div class="flex flex-col gap-3">
      <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">
        SHA-256 digests recomputed from the reviewed {ecosystem} release bytes. The publish job
        re-verifies these against the immutable artifact before upload, so the bytes reviewed are
        the bytes published.
      </p>
      <div class="border border-border rounded-lg overflow-hidden divide-y divide-border">
        {provenance.artifacts.map((artifact) => (
          <div key={artifact.path} class="flex flex-col gap-1.5 px-3 py-2.5 min-w-0">
            <div class="flex flex-wrap items-center gap-2 min-w-0">
              <Badge tone="neutral">{artifact.kind}</Badge>
              <code class="font-mono text-[12px] text-ink break-all min-w-0">{artifact.path}</code>
            </div>
            <div class="flex items-baseline gap-2 min-w-0">
              <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle flex-shrink-0">
                sha256
              </span>
              <code class="font-mono text-[11px] text-ink-muted break-all min-w-0">
                {artifact.sha256}
              </code>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PackageJsonDiffView({ diff }: { diff: PackageJsonDiff }) {
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
        <ChangeList title="dependencies" rows={diff.dependencies} />
        {/* Only surfaced when present: most releases change no bin, and a new
            bin command is the install-path change flagged by diff.bin-added.
            Optional-chained for reports persisted before bin was diffed. */}
        {diff.bin?.length ? <ChangeList title="bin" rows={diff.bin} /> : null}
      </div>
    </div>
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
}: {
  title: string;
  rows: Array<{
    key: string;
    status: "added" | "removed" | "modified";
    previous?: string;
    staged?: string;
  }>;
}) {
  return (
    <div class="border border-border rounded-lg overflow-hidden">
      <div class="px-3 py-2 bg-surface-2 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
        {title} ({rows.length})
      </div>
      {rows.length ? (
        <div class="divide-y divide-border">
          {rows.map((row) => (
            <div
              key={`${title}-${row.key}`}
              class="flex flex-col gap-1.5 px-3 py-2.5 text-[13px] min-w-0"
            >
              <div class="flex flex-wrap items-center gap-2 min-w-0">
                <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                <code class="font-mono text-[12px] text-ink break-all min-w-0">{row.key}</code>
              </div>
              <ChangeValue status={row.status} previous={row.previous} staged={row.staged} />
            </div>
          ))}
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
