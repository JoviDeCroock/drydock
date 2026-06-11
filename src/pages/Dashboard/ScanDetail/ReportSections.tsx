import type { ComponentChildren } from "preact";
import { sortFindingsBySeverity } from "../../../lib/findings";
import { formatDateTime } from "../../../lib/format";
import type { AiFinding, DisplayedAiResult } from "../../../../server/lib/ai-review-types";
import type {
  ReportArtifactDigest,
  ReportProvenance,
} from "../../../../server/lib/report-provenance";
import type { PackageJsonDiff } from "../../../../server/types";
import {
  Badge,
  EmptyLine,
  FindingCard,
  FindingRow,
  SectionLabel,
  severityTone,
  statusTone,
} from "../../../components";
import type { PersistedSummary } from "./types";

export function PersistedReportSections({
  summary,
  ai,
  provenance,
}: {
  summary: PersistedSummary;
  ai: DisplayedAiResult | null;
  provenance?: ReportProvenance;
}) {
  return (
    <section class="flex flex-col gap-6">
      {provenance ? <ProvenanceSection provenance={provenance} /> : null}

      <ReportSection title="Manifest changes">
        {summary.packageJsonDiff ? (
          <PackageJsonDiffView diff={summary.packageJsonDiff} />
        ) : (
          <EmptyLine>No manifest changes were saved for this review.</EmptyLine>
        )}
      </ReportSection>

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
              {ai.summary ? (
                <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">{ai.summary}</p>
              ) : null}
              {ai.findings.length ? (
                <AiFindingList findings={ai.findings} />
              ) : (
                <EmptyLine>No assistant findings.</EmptyLine>
              )}
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

function ProvenanceSection({ provenance }: { provenance: ReportProvenance }) {
  const report = provenance.report;
  const scan = provenance.scan;
  const pkg = provenance.package;
  const baselineVersion = baselineLabel(provenance.baseline) ?? pkg.previousVersion ?? "none";
  return (
    <ReportSection title="Report provenance">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
        <InlineMeta label="report digest" value={report.digest ?? "unavailable"} />
        <InlineMeta
          label="report schema"
          value={`${report.schema}${report.version ? ` / v${report.version}` : ""}`}
        />
        <InlineMeta label="rules version" value={report.rulesVersion ?? "unavailable"} />
        <InlineMeta
          label="generated"
          value={report.generatedAt ? formatDateTime(report.generatedAt) : "unavailable"}
        />
        <InlineMeta label="package" value={pkg.name ?? "unknown"} />
        <InlineMeta
          label="version"
          value={`${pkg.previousVersion ?? baselineVersion} → ${pkg.stagedVersion ?? "unknown"}`}
        />
        <InlineMeta label="source" value={scan.source ?? "unknown"} />
        <InlineMeta
          label={scan.workflowGateId ? "workflow gate" : "stage id"}
          value={scan.workflowGateId ?? scan.stageId ?? "unknown"}
        />
        <InlineMeta label="baseline" value={baselineVersion} />
        <InlineMeta label="assistant" value={aiLabel(provenance.ai.status, provenance.ai.model)} />
      </div>

      {provenance.artifacts.length ? (
        <div class="flex flex-col gap-2">
          <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
            Reviewed artifact digests
          </span>
          <ul class="list-none p-0 m-0 flex flex-col border-t border-border">
            {provenance.artifacts.map((artifact) => (
              <ArtifactDigestRow
                key={`${artifact.path}-${artifact.digestAlgorithm}-${artifact.digest}`}
                artifact={artifact}
              />
            ))}
          </ul>
        </div>
      ) : (
        <EmptyLine>No artifact digest metadata was saved for this review.</EmptyLine>
      )}

      <ul class="m-0 pl-4 text-[13px] leading-[1.6] text-ink-muted">
        {provenance.review.limitations.map((limitation) => (
          <li key={limitation}>{limitation}</li>
        ))}
      </ul>
    </ReportSection>
  );
}

function ArtifactDigestRow({ artifact }: { artifact: ReportArtifactDigest }) {
  return (
    <li class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-1 py-2 border-b border-border text-[13px]">
      <div class="min-w-0">
        <span class="font-mono text-[13px] text-ink break-all">{artifact.path}</span>
        <span class="ml-2 font-mono text-[11px] text-ink-subtle">
          {artifact.kind ?? "artifact"} · {artifact.source.replace("_", " ")}
        </span>
      </div>
      <span class="font-mono text-[13px] text-ink-muted break-all">
        {artifact.digestAlgorithm}:{artifact.digest}
      </span>
    </li>
  );
}

function AiFindingList({ findings }: { findings: AiFinding[] }) {
  return (
    <ul class="list-none p-0 m-0 grid grid-cols-1 md:grid-cols-2 gap-2">
      {sortFindingsBySeverity(findings).map((finding, index) => (
        <FindingCard
          key={`${finding.file}-${index}`}
          severity={finding.severity}
          file={finding.file}
        >
          <FindingRow label="evidence" value={finding.evidence} />
          <FindingRow label="reason" value={finding.reason} />
          <FindingRow label="recommendation" value={finding.recommendation} />
        </FindingCard>
      ))}
    </ul>
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

function baselineLabel(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const item = value as { version?: unknown; source?: unknown };
  const version = typeof item.version === "string" && item.version ? item.version : null;
  const source = typeof item.source === "string" && item.source ? item.source : null;
  if (version && source) return `${version} (${source})`;
  return version ?? source;
}

function aiLabel(status: string | null, model: string | null): string {
  if (!status && !model) return "not recorded";
  if (!model) return status ?? "unavailable";
  return `${status ?? "available"} / ${model}`;
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
