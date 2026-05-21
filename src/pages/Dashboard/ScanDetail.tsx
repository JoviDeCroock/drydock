import { useEffect, useMemo, useState } from "preact/hooks";
import { useLocation, useRoute } from "preact-iso";
import { getSession } from "../../models/auth";
import {
  getScan,
  getScanCompare,
  getScanCompareFile,
  getScanVersions,
  type PersistedScanDetail,
  type ScanCompareResponse,
  type ScanVersionsResponse,
} from "../../models/scan";
import type { AiFinding, AiReview } from "../../../server/lib/ai-review";
import { createPackageDiff, type DiffEntry, type FileRecord } from "../../../server/lib/review";
import type { PackageJsonDiff, ScanResult } from "../../../server/types";
import {
  Alert,
  Badge,
  Card,
  DiffView,
  EmptyLine,
  FileTree,
  FindingCard,
  FindingRow,
  LoadingLine,
  MonoDetail,
  PageShell,
  SectionLabel,
  SeverityBar,
  SummaryCard,
  VersionPicker,
  severityTone,
  statusTone,
} from "../../components";
import type { SeverityCounts, SeverityKey } from "../../components";

interface PersistedSummary {
  report?: {
    version?: number;
    digest?: string;
    digestAlgorithm?: string;
    generatedAt?: string;
  };
  packageJsonDiff?: PackageJsonDiff;
  diff?: DiffEntry[];
  safety?: ScanResult["safety"];
}

export default function ScanDetailPage() {
  const location = useLocation();
  const route = useRoute();
  const id = route.params.id;
  const [detail, setDetail] = useState<PersistedScanDetail | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [versions, setVersions] = useState<ScanVersionsResponse | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [compareCache, setCompareCache] = useState<Record<string, ScanCompareResponse>>({});
  const [fileContentCache, setFileContentCache] = useState<Record<string, FileRecord>>({});
  const [compareLoading, setCompareLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSession().then(async (current) => {
      if (cancelled) return;
      if (!current) {
        location.route("/login", true);
        return;
      }
      try {
        const data = await getScan(id);
        if (cancelled) return;
        setDetail(data);
        setSelectedPath(
          data.files.find((file) => file.status !== "unchanged")?.path ?? data.files[0]?.path ?? null,
        );
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (detail?.scan.status !== "pending" && detail?.scan.status !== "running") return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const data = await getScan(id, { poll: true });
        if (cancelled) return;
        setDetail(data);
        setError(null);
        setSelectedPath(
          (current) => current ?? data.files.find((file) => file.status !== "unchanged")?.path ?? data.files[0]?.path ?? null,
        );
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    const timer = window.setInterval(refresh, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [detail?.scan.status, id]);

  useEffect(() => {
    if (!detail || detail.scan.status !== "complete") return;
    if (!detail.scan.packageName) return;
    let cancelled = false;
    getScanVersions(id)
      .then((data) => {
        if (cancelled) return;
        setVersions(data);
        setSelectedVersion((current) => current ?? data.defaultPreviousVersion ?? null);
      })
      .catch((err) => {
        if (!cancelled) setCompareError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id, detail?.scan.status, detail?.scan.packageName]);

  useEffect(() => {
    if (!selectedVersion) return;
    if (compareCache[selectedVersion]) return;
    let cancelled = false;
    setCompareLoading(true);
    setCompareError(null);
    getScanCompare(id, selectedVersion)
      .then((data) => {
        if (cancelled) return;
        setCompareCache((prev) => ({ ...prev, [selectedVersion]: data }));
      })
      .catch((err) => {
        if (!cancelled) setCompareError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setCompareLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, selectedVersion, compareCache]);

  const summary = asPersistedSummary(detail?.scan.summaryJson);
  const ai = asAiReview(detail?.scan.aiJson);
  const compare = selectedVersion ? compareCache[selectedVersion] ?? null : null;
  const isDefaultComparison = selectedVersion === (versions?.defaultPreviousVersion ?? null);

  const persistedDiff = summary.diff ?? [];
  const diffEntries: DiffEntry[] = useMemo(() => {
    if (!detail) return [];
    if (compare && !isDefaultComparison) {
      const stagedRecords = scanFilesToFileRecords(detail.files);
      return createPackageDiff(compare.files, stagedRecords);
    }
    if (persistedDiff.length) return persistedDiff;
    return detail.files.map((file) => ({
      path: file.path,
      status: (file.status as DiffEntry["status"]) || "unchanged",
      stagedSize: file.size ?? undefined,
      stagedSha256: file.sha256 ?? undefined,
      flags: Array.isArray(file.flagsJson) ? (file.flagsJson as string[]) : [],
    }));
  }, [detail, compare, isDefaultComparison, persistedDiff]);

  const selectedEntry = selectedPath
    ? diffEntries.find((entry) => entry.path === selectedPath) ?? null
    : null;
  const stagedFile = selectedPath
    ? detail?.files.find((file) => file.path === selectedPath) ?? null
    : null;
  const previousFileMeta = selectedPath && compare
    ? compare.files.find((file) => file.path === selectedPath) ?? null
    : null;
  const previousFileKey = selectedVersion && selectedPath ? `${selectedVersion}::${selectedPath}` : null;
  const previousFile = previousFileKey ? fileContentCache[previousFileKey] ?? null : null;

  useEffect(() => {
    if (!previousFileKey || !selectedVersion || !selectedPath) return;
    if (!previousFileMeta) return;
    if (fileContentCache[previousFileKey]) return;
    if (previousFileMeta.flags?.includes("binary")) return;
    let cancelled = false;
    setFileLoading(true);
    getScanCompareFile(id, selectedVersion, selectedPath)
      .then((data) => {
        if (cancelled) return;
        setFileContentCache((prev) => ({ ...prev, [previousFileKey]: data.file }));
      })
      .catch((err) => {
        if (!cancelled) setCompareError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setFileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, selectedVersion, selectedPath, previousFileKey, previousFileMeta, fileContentCache]);

  return (
    <PageShell>
      <header class="flex flex-col gap-2">
        <a href="/dashboard" class="text-[13px] text-ink-muted hover:text-ink no-underline">
          ← Reviews
        </a>
        <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">
          {detail?.scan.packageName || "Release review"}
        </h1>
        {detail ? (
          <MonoDetail
            parts={[
              <span>
                {detail.scan.previousVersion || "—"} → {detail.scan.stagedVersion || "—"}
              </span>,
              <Badge tone={severityTone(detail.scan.risk)}>{detail.scan.risk}</Badge>,
              <span>scan {detail.scan.id.slice(0, 12)}</span>,
            ]}
          />
        ) : (
          <LoadingLine>Loading saved review</LoadingLine>
        )}
      </header>

      {error ? <Alert tone="critical">{error}</Alert> : null}
      {detail?.scan.status === "pending" || detail?.scan.status === "running" ? (
        <Alert tone="info">
          Review is {detail.scan.status}. This page refreshes automatically until the report is ready.
        </Alert>
      ) : null}
      {detail?.scan.status === "failed" ? <ScanFailureAlert errorJson={detail.scan.errorJson} /> : null}

      {detail ? (
        <>
          <ReportOverview
            detail={detail}
            summary={summary}
            ai={ai}
            findings={detail.findings}
            aiFindings={ai?.findings ?? []}
            diffCount={diffEntries.filter((entry) => entry.status !== "unchanged").length}
          />

          {versions ? (
            <Card class="p-4 flex flex-col gap-2">
              <VersionPicker
                options={versions.versions}
                selected={selectedVersion}
                defaultVersion={versions.defaultPreviousVersion}
                stagedVersion={versions.stagedVersion}
                onChange={setSelectedVersion}
                disabled={compareLoading}
              />
              {compareLoading ? (
                <LoadingLine size="inline">Fetching {selectedVersion} via sandbox</LoadingLine>
              ) : null}
              {compareError ? <Alert tone="warn">{compareError}</Alert> : null}
            </Card>
          ) : null}

          <section class="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_320px] gap-4">
            <Card as="aside" class="p-0 overflow-hidden flex flex-col min-h-0">
              <div class="px-4 py-3 border-b border-border">
                <SectionLabel>Release tree</SectionLabel>
              </div>
              <div class="flex flex-col overflow-y-auto max-h-[640px] py-2">
                <FileTree
                  entries={diffEntries}
                  selectedPath={selectedPath}
                  onSelect={setSelectedPath}
                />
              </div>
            </Card>

            <Card class="p-5 flex flex-col gap-3 min-h-0">
              <SectionLabel>File diff</SectionLabel>
              {selectedEntry && (stagedFile || previousFile || previousFileMeta) ? (
                <>
                  {fileLoading && !previousFile ? (
                    <LoadingLine size="inline">Loading previous content</LoadingLine>
                  ) : null}
                  <DiffView
                    path={selectedEntry.path}
                    status={selectedEntry.status}
                    beforeLabel={selectedVersion ? `previous (${selectedVersion})` : "previous"}
                    afterLabel={`staged (${detail.scan.stagedVersion ?? "current"})`}
                    before={previousFile ? toDiffSide(previousFile) : previousFileMeta ? toDiffSide(previousFileMeta) : null}
                    after={stagedFile ? scanFileToDiffSide(stagedFile) : null}
                  />
                </>
              ) : selectedEntry && !compare && selectedEntry.status !== "unchanged" ? (
                <LoadingLine>Loading previous version metadata</LoadingLine>
              ) : (
                <EmptyLine>Select a file from the tree to diff.</EmptyLine>
              )}
            </Card>

            <Card as="aside" class="p-5 flex flex-col gap-3">
              <SectionLabel>Risk signals</SectionLabel>
              {detail.findings.length ? (
                <ul class="list-none p-0 m-0 flex flex-col gap-2">
                  {detail.findings.map((finding) => (
                    <FindingCard key={finding.id} severity={finding.severity} file={finding.file}>
                      <FindingRow label="evidence" value={finding.evidence} />
                      <FindingRow label="reason" value={finding.reason} />
                    </FindingCard>
                  ))}
                </ul>
              ) : (
                <EmptyLine>No rule findings.</EmptyLine>
              )}
            </Card>
          </section>

          <PersistedReportSections summary={summary} ai={ai} />
        </>
      ) : null}
    </PageShell>
  );
}

function scanFilesToFileRecords(
  files: PersistedScanDetail["files"],
): FileRecord[] {
  return files.map((file) => ({
    path: file.path,
    size: file.size ?? 0,
    sha256: file.sha256 ?? "",
    textSample: file.textSample ?? undefined,
    flags: Array.isArray(file.flagsJson) ? (file.flagsJson as string[]) : [],
  }));
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

function ScanFailureAlert({ errorJson }: { errorJson: unknown }) {
  const error = errorJson && typeof errorJson === "object" ? errorJson as { message?: unknown; detail?: unknown; code?: unknown } : null;
  return (
    <Alert tone="critical">
      <div class="flex flex-col gap-1">
        <strong>{typeof error?.message === "string" ? error.message : "Review failed."}</strong>
        {typeof error?.detail === "string" ? <span class="font-mono text-xs break-all">{error.detail}</span> : null}
        {typeof error?.code === "string" ? <span class="font-mono text-xs">code: {error.code}</span> : null}
      </div>
    </Alert>
  );
}

function ReportOverview({
  detail,
  summary,
  ai,
  findings,
  aiFindings,
  diffCount,
}: {
  detail: PersistedScanDetail;
  summary: PersistedSummary;
  ai: AiReview | null;
  findings: PersistedScanDetail["findings"];
  aiFindings: AiFinding[];
  diffCount: number;
}) {
  const changed = diffCount || summary.diff?.filter((entry) => entry.status !== "unchanged").length ||
    detail.files.filter((file) => file.status !== "unchanged").length;
  const severityCounts = countSeverities([...findings, ...aiFindings]);
  return (
    <section class="flex flex-col gap-4">
      <div class="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        <SummaryCard label="status" value="sentence">{detail.scan.status}</SummaryCard>
        <SummaryCard label="stage ID">{detail.scan.stageId}</SummaryCard>
        <SummaryCard
          label="risk"
          value="metric"
          tone={detail.scan.risk === "high" || detail.scan.risk === "critical" ? "danger" : "default"}
        >
          {detail.scan.risk}
        </SummaryCard>
        <SummaryCard label="files" value="metric">{detail.files.length}</SummaryCard>
        <SummaryCard label="changed" value="metric">{changed}</SummaryCard>
        <SummaryCard label="assistant take" value="sentence">{ai?.releaseAssessment?.replaceAll("_", " ") || "saved"}</SummaryCard>
        <SummaryCard label="report">{summary.report?.version ? `v${summary.report.version}` : "legacy"}</SummaryCard>
      </div>
      <Card class="p-4">
        <SeverityBar counts={severityCounts} />
      </Card>
    </section>
  );
}

function countSeverities(findings: Array<{ severity?: string }>): SeverityCounts {
  const counts: SeverityCounts = {};
  for (const finding of findings) {
    const key = normalizeSeverityKey(finding.severity);
    if (!key) continue;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function normalizeSeverityKey(value: string | undefined): SeverityKey | null {
  switch (value) {
    case "critical":
    case "high":
    case "medium":
    case "low":
    case "info":
    case "ok":
      return value;
    default:
      return null;
  }
}

function PersistedReportSections({ summary, ai }: { summary: PersistedSummary; ai: AiReview | null }) {
  return (
    <section class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card class="p-5 flex flex-col gap-3">
        <SectionLabel>Reviewer notes</SectionLabel>
        {ai ? (
          <>
            <div class="flex flex-wrap gap-2">
              <Badge tone={severityTone(ai.risk)}>{ai.risk}</Badge>
              <Badge tone={ai.requiresManualReview ? "medium" : "ok"}>
                {ai.requiresManualReview ? "manual review" : "no extra review"}
              </Badge>
              <Badge tone="neutral">{ai.releaseAssessment?.replaceAll("_", " ") || "assessment stored"}</Badge>
            </div>
            {ai.summary ? <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">{ai.summary}</p> : null}
            {ai.findings?.length ? <AiFindingList findings={ai.findings} /> : <EmptyLine>No assistant findings.</EmptyLine>}
          </>
        ) : (
          <EmptyLine>No reviewer notes were saved for this review.</EmptyLine>
        )}
      </Card>

      <Card class="p-5 flex flex-col gap-3">
        <SectionLabel>Report fingerprint</SectionLabel>
        {summary.report ? (
          <div class="flex flex-col gap-2 text-[13px]">
            <MetadataRow label="version" value={String(summary.report.version ?? "unknown")} />
            <MetadataRow label="digest" value={`${summary.report.digestAlgorithm || "sha256"}:${summary.report.digest || "missing"}`} />
            <MetadataRow label="generated" value={summary.report.generatedAt ? formatDate(summary.report.generatedAt) : "unknown"} />
          </div>
        ) : (
          <EmptyLine>This older review does not include a report fingerprint.</EmptyLine>
        )}
        {summary.safety ? (
          <details class="group mt-2">
            <summary class="cursor-pointer font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle list-none">
              Safety model
            </summary>
            <pre class="bg-surface-2 rounded-lg p-3 overflow-x-auto text-xs leading-[1.5] mt-3 mb-0">
              {JSON.stringify(summary.safety, null, 2)}
            </pre>
          </details>
        ) : null}
      </Card>

      <Card class="p-5 flex flex-col gap-3 lg:col-span-2">
        <SectionLabel>Manifest changes</SectionLabel>
        {summary.packageJsonDiff ? <PackageJsonDiffView diff={summary.packageJsonDiff} /> : <EmptyLine>No manifest changes were saved for this review.</EmptyLine>}
      </Card>
    </section>
  );
}

function AiFindingList({ findings }: { findings: AiFinding[] }) {
  return (
    <ul class="list-none p-0 m-0 flex flex-col gap-2">
      {findings.map((finding, index) => (
        <FindingCard key={`${finding.file}-${index}`} severity={finding.severity} file={finding.file}>
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
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-3">
      <SummaryCard label="package">{diff.name || "unknown"}</SummaryCard>
      <SummaryCard label="version">{diff.previousVersion || "—"} → {diff.stagedVersion || "—"}</SummaryCard>
      <SummaryCard label="entrypoints" value="sentence">{diff.entrypointsChanged ? "changed" : "unchanged"}</SummaryCard>
      <ChangeList title="scripts" rows={diff.scripts} />
      <ChangeList title="dependencies" rows={diff.dependencies} />
    </div>
  );
}

function ChangeList({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ key: string; status: "added" | "removed" | "modified"; previous?: string; staged?: string }>;
}) {
  return (
    <div class="lg:col-span-3 border border-border rounded-lg overflow-hidden">
      <div class="px-3 py-2 bg-surface-2 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
        {title} ({rows.length})
      </div>
      {rows.length ? (
        <div class="divide-y divide-border">
          {rows.map((row) => (
            <div key={`${title}-${row.key}`} class="grid grid-cols-1 md:grid-cols-[120px_minmax(0,1fr)] gap-2 px-3 py-2 text-[13px]">
              <div class="flex items-center gap-2 min-w-0">
                <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                <code class="truncate">{row.key}</code>
              </div>
              <code class="text-xs text-ink-muted break-all">
                {row.previous || "—"} → {row.staged || "—"}
              </code>
            </div>
          ))}
        </div>
      ) : (
        <div class="px-3 py-3"><EmptyLine>No {title} changes.</EmptyLine></div>
      )}
    </div>
  );
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div class="grid grid-cols-[96px_minmax(0,1fr)] gap-3">
      <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">{label}</span>
      <code class="text-xs text-ink-muted break-all">{value}</code>
    </div>
  );
}

function formatDate(value: string | number | Date) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function asPersistedSummary(value: unknown): PersistedSummary {
  if (!value || typeof value !== "object") return {};
  return value as PersistedSummary;
}

function asAiReview(value: unknown): AiReview | null {
  if (!value || typeof value !== "object") return null;
  return value as AiReview;
}
