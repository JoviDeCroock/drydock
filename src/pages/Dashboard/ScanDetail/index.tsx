import { useEffect } from "preact/hooks";
import { useComputed, useModel, useSignal, useSignalEffect } from "@preact/signals";
import { useLocation, useRoute } from "preact-iso";
import { getDashboardReturnUrl, useQuerySignal } from "../../../lib/query-state";
import { formatDateTime } from "../../../lib/format";
import { sessionModel } from "../../../models/auth";
import { ScanDetailModel, type PersistedScanDetail, type ScanDecision } from "../../../models/scan";
import type { WorkflowGateDecision } from "../../../models/github-app";
import { displayedAiResult, type AiReview } from "../../../../server/lib/ai-review-types";
import {
  annotateFindingsWithDiffStatus as annotateReviewFindingsWithDiffStatus,
  createPackageDiff,
  normalizeFindingDiffStatus,
  type DiffEntry,
  type FindingDiffAnnotation,
  type FileRecord,
} from "../../../../server/lib/review";
import {
  Alert,
  Badge,
  Button,
  Card,
  FileTree,
  Input,
  LoadingLine,
  LoadingState,
  MonoDetail,
  PageShell,
  SectionLabel,
  VersionPicker,
  severityTone,
} from "../../../components";
import { DecisionDialog } from "./DecisionDialog";
import { GateContextPanel, GateDecisionDialog } from "./GateDecisionDialog";
import { DiffWorkbench } from "./DiffWorkbench";
import { RiskSignalsSection } from "./FindingsSection";
import { ReleaseRecommendation } from "./ReleaseRecommendation";
import { PersistedReportSections } from "./ReportSections";
import type { FindingWithDiffStatus, PersistedFinding, PersistedSummary } from "./types";

export default function ScanDetailPage() {
  const location = useLocation();
  const route = useRoute();
  const id = route.params.id;
  const model = useModel(() => new ScanDetailModel(id));
  const sessionChecked = useSignal(false);
  const fileFilter = useSignal("");
  const changedFilesOnly = useSignal(true);
  const decisionDialogOpen = useSignal(false);
  const gateDialogOpen = useSignal(false);

  // Two-way bind filter state to query params. The text filter is debounced
  // because it fires on every keystroke; the rest write through immediately.
  useQuerySignal(fileFilter, {
    name: "file",
    parse: (raw) => raw ?? "",
    serialize: (value) => value || null,
    debounceMs: 250,
  });
  useQuerySignal(changedFilesOnly, {
    name: "changedOnly",
    parse: (raw) => raw !== "0",
    serialize: (value) => (value ? null : "0"),
  });
  useQuerySignal(model.selectedVersion, {
    name: "version",
    parse: (raw) => raw ?? null,
    serialize: (value) => value,
  });
  useQuerySignal(model.selectedPath, {
    name: "path",
    parse: (raw) => raw ?? null,
    serialize: (value) => value,
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const data = await sessionModel.load();
      if (cancelled) return;
      if (!data) {
        location.route("/login", true);
        return;
      }
      sessionChecked.value = true;
      await model.load();
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Fetch version metadata as soon as we have a package name (don't wait for complete).
  useSignalEffect(() => {
    if (!model.detail.value?.scan.packageName) return;
    if (model.versions.value) return;
    void model.loadVersions();
  });

  // Load the workflow gate once the review reaches a terminal state. Completed
  // and failed scans may both be linked to the pending gate so the workbench can
  // show the held GitHub job context.
  useSignalEffect(() => {
    if (!model.isWorkflowGate.value) return;
    if (model.status.value !== "complete" && model.status.value !== "failed") return;
    if (model.gateLoaded.value) return;
    void model.loadGate();
    const retryTimer = window.setInterval(() => {
      if (!model.gateLoaded.peek()) void model.loadGate();
    }, 2500);
    return () => window.clearInterval(retryTimer);
  });

  const summary = useComputed(() => asPersistedSummary(model.detail.value?.scan.summaryJson));
  const ai = useComputed(() => displayedAiResult(asAiReview(model.detail.value?.scan.aiJson)));

  const diffEntries = useComputed<DiffEntry[]>(() => {
    const detail = model.detail.value;
    const compare = model.compare.value;
    const isDefault = model.isDefaultComparison.value;
    const persistedSummary = summary.value;
    if (!detail) return [];
    if (compare && !isDefault) {
      const stagedRecords = scanFilesToFileRecords(detail.files);
      return createPackageDiff(compare.files, stagedRecords);
    }
    const persistedDiff = persistedSummary.diff ?? [];
    if (persistedDiff.length) return persistedDiff;
    return detail.files.map((file) => ({
      path: file.path,
      status: (file.status as DiffEntry["status"]) || "unchanged",
      stagedSize: file.size ?? undefined,
      stagedSha256: file.sha256 ?? undefined,
      flags: Array.isArray(file.flagsJson) ? (file.flagsJson as string[]) : [],
    }));
  });

  const selectedEntry = useComputed(() => {
    const path = model.selectedPath.value;
    const entries = diffEntries.value;
    if (!path) return null;
    return entries.find((entry) => entry.path === path) ?? null;
  });

  const visibleDiffEntries = useComputed(() =>
    filterDiffEntries(diffEntries.value, fileFilter.value, changedFilesOnly.value),
  );

  const findingsWithDiffStatus = useComputed(() =>
    annotateFindingsWithDiffStatus(
      model.detail.value?.findings ?? [],
      diffEntries.value,
      model.isDefaultComparison.value,
      model.compare.value?.files ?? [],
      model.detail.value ? scanFilesToFileRecords(model.detail.value.files) : [],
      model.isDefaultComparison.value ? undefined : model.compare.value?.findingAnnotations,
    ),
  );

  const stagedFile = useComputed(() => {
    const path = model.selectedPath.value;
    const detail = model.detail.value;
    if (!path) return null;
    return detail?.files.find((file) => file.path === path) ?? null;
  });

  const previousFileMeta = useComputed(() => {
    const path = model.selectedPath.value;
    const compare = model.compare.value;
    if (!path || !compare) return null;
    return compare.files.find((file) => file.path === path) ?? null;
  });

  const previousFileKey = useComputed(() => {
    const version = model.selectedVersion.value;
    const path = model.selectedPath.value;
    return version && path ? `${version}::${path}` : null;
  });

  const previousFile = useComputed(() => {
    const key = previousFileKey.value;
    const cache = model.fileContentCache.value;
    return key ? (cache[key] ?? null) : null;
  });

  // Lazy-load the previous file content when the user picks a file + version.
  useSignalEffect(() => {
    const key = previousFileKey.value;
    const cache = model.fileContentCache.value;
    const meta = previousFileMeta.value;
    const version = model.selectedVersion.value;
    const path = model.selectedPath.value;
    if (!key) return;
    if (cache[key]) return;
    if (!meta) return;
    if (meta.flags?.includes("binary")) return;
    if (!version || !path) return;
    void model.loadPreviousFile(version, path);
  });

  if (!sessionChecked.value) {
    return (
      <PageShell>
        <ScanDetailHeader />
        <LoadingState title="Opening review" detail="confirming session · fetching report" />
      </PageShell>
    );
  }

  const detail = model.detail.value;
  const versions = model.versions.value;
  const error = model.error.value;
  const compareLoading = model.compareLoading.value;
  const compareError = model.compareError.value;
  const selectedVersion = model.selectedVersion.value;
  const compare = model.compare.value;
  const hasRuleFindings = Boolean(detail?.findings.length);
  const workbenchGridClass = "grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)] gap-4";

  const isWorkflowGate = model.isWorkflowGate.value;
  const gate = model.gate.value;

  const handleDecisionSubmit = async (decision: ScanDecision, reason: string | null) => {
    await model.setDecision(decision, reason);
    if (model.decisionStatus.peek() === "idle") {
      decisionDialogOpen.value = false;
    }
  };

  const handleGateDecision = async (decision: WorkflowGateDecision, comment: string | null) => {
    await model.decideGate(decision, comment);
    if (model.gateDecisionStatus.peek() === "idle") {
      gateDialogOpen.value = false;
    }
  };

  // npm scans become decidable once complete; gate scans only while the gate is
  // still pending (the decision is a one-way release/block of the GitHub job).
  const onDecideClick = isWorkflowGate
    ? gate?.status === "pending"
      ? () => (gateDialogOpen.value = true)
      : undefined
    : detail?.scan.status === "complete"
      ? () => (decisionDialogOpen.value = true)
      : undefined;

  return (
    <PageShell>
      <ScanDetailHeader detail={detail} onDecideClick={onDecideClick} />

      {error ? <Alert tone="critical">{error}</Alert> : null}
      {isWorkflowGate && detail ? (
        <GateContextPanel gate={gate} packageName={detail.scan.packageName} />
      ) : null}
      {detail?.scan.status === "failed" ? (
        <ScanFailureAlert errorJson={detail.scan.errorJson} />
      ) : null}

      {!detail && !error ? (
        <LoadingState title="Loading saved review" detail="fetching report · normalizing diff" />
      ) : null}

      {detail ? (
        detail.scan.status === "complete" ? (
          <>
            <ReleaseRecommendation
              detail={detail}
              summary={summary.value}
              ai={ai.value}
              diffCount={diffEntries.value.filter((entry) => entry.status !== "unchanged").length}
              findingsWithDiffStatus={findingsWithDiffStatus.value}
              usePersistedRiskSummary={model.isDefaultComparison.value || !compare}
              isWorkflowGate={isWorkflowGate}
            />

            {detail.scan.packageName ? (
              <div class="flex flex-col gap-2 border-t border-border pt-3">
                {versions ? (
                  <VersionPicker
                    options={versions.versions}
                    selected={selectedVersion}
                    defaultVersion={versions.defaultPreviousVersion}
                    stagedVersion={versions.stagedVersion}
                    onChange={(value) => model.selectVersion(value)}
                    disabled={compareLoading}
                  />
                ) : (
                  <VersionPickerSkeleton stagedVersion={detail.scan.stagedVersion ?? null} />
                )}
                {compareLoading ? (
                  <LoadingLine size="inline">Fetching {selectedVersion} via sandbox</LoadingLine>
                ) : null}
                {compareError ? <Alert tone="warn">{compareError}</Alert> : null}
              </div>
            ) : compareError ? (
              <Alert tone="warn">{compareError}</Alert>
            ) : null}

            <section class={workbenchGridClass}>
              <Card as="aside" class="p-5 flex flex-col gap-3 h-[720px] overflow-hidden">
                <SectionLabel>Release tree</SectionLabel>
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
                      onChange={(e) =>
                        (changedFilesOnly.value = (e.target as HTMLInputElement).checked)
                      }
                    />
                    Changed files only
                  </label>
                  <span class="font-mono text-[11px] text-ink-subtle">
                    {visibleDiffEntries.value.length} / {diffEntries.value.length}
                  </span>
                </div>
                <div class="flex flex-col overflow-y-auto flex-1 min-h-0 border-t border-border pt-2">
                  <FileTree
                    entries={visibleDiffEntries.value}
                    selectedPath={model.selectedPath.value}
                    onSelect={(path) => model.selectPath(path)}
                  />
                </div>
              </Card>

              <Card class="p-5 flex flex-col gap-3 h-[720px]">
                <SectionLabel>File diff</SectionLabel>
                <DiffWorkbench
                  entry={selectedEntry.value}
                  staged={stagedFile.value}
                  previousMeta={previousFileMeta.value}
                  previousContent={previousFile.value}
                  compareReady={Boolean(compare)}
                  selectedVersion={selectedVersion}
                  stagedVersion={detail.scan.stagedVersion}
                />
              </Card>
            </section>

            {hasRuleFindings ? (
              <RiskSignalsSection findings={findingsWithDiffStatus.value} />
            ) : null}

            <PersistedReportSections summary={summary.value} ai={ai.value} />
          </>
        ) : detail.scan.status === "pending" || detail.scan.status === "running" ? (
          <LoadingState
            title={detail.scan.status === "pending" ? "Review queued" : "Reviewing release"}
            detail="auto-refreshes when the report is ready"
          />
        ) : null
      ) : null}

      {detail && detail.scan.status === "complete" && !isWorkflowGate ? (
        <DecisionDialog
          open={decisionDialogOpen.value}
          onClose={() => (decisionDialogOpen.value = false)}
          decision={detail.scan.decision}
          decisionReason={detail.scan.decisionReason}
          decidedAt={detail.scan.decidedAt}
          status={model.decisionStatus.value}
          error={model.decisionError.value}
          onSubmit={handleDecisionSubmit}
        />
      ) : null}

      {detail && isWorkflowGate && gate ? (
        <GateDecisionDialog
          open={gateDialogOpen.value}
          onClose={() => (gateDialogOpen.value = false)}
          gate={gate}
          packageName={detail.scan.packageName}
          status={model.gateDecisionStatus.value}
          error={model.gateDecisionError.value}
          onSubmit={handleGateDecision}
        />
      ) : null}
    </PageShell>
  );
}

function ScanDetailHeader({
  detail,
  onDecideClick,
}: {
  detail?: PersistedScanDetail | null;
  onDecideClick?: () => void;
} = {}) {
  const decision = detail?.scan.decision;
  const decidedAt = detail?.scan.decidedAt;
  const isComplete = detail?.scan.status === "complete";
  const releaseRisk = isComplete ? (detail.riskSummary?.releaseRisk ?? detail.scan.risk) : null;
  const dashboardHref = getDashboardReturnUrl();
  return (
    <header class="flex flex-wrap items-start justify-between gap-4">
      <div class="flex flex-col gap-2 min-w-0">
        <a href={dashboardHref} class="text-[13px] text-ink-muted hover:text-ink no-underline">
          ← Reviews
        </a>
        <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">
          {detail?.scan.packageName || "Release review"}
        </h1>
        {detail ? (
          <MonoDetail
            parts={[
              <span key="version">
                {detail.scan.previousVersion || "—"} → {detail.scan.stagedVersion || "—"}
              </span>,
              releaseRisk ? (
                <Badge key="risk" tone={severityTone(releaseRisk)}>
                  release {releaseRisk}
                </Badge>
              ) : null,
              <span key="scan-id">scan {detail.scan.id.slice(0, 12)}</span>,
            ]}
          />
        ) : (
          <LoadingLine size="inline">Loading saved review</LoadingLine>
        )}
      </div>
      {decision || onDecideClick ? (
        <div class="flex flex-wrap items-start gap-3">
          {decision ? (
            <div class="flex flex-col items-end gap-1">
              <Badge tone={decision === "publish" ? "ok" : "critical"}>
                {decision === "publish" ? "approved" : "blocked"}
              </Badge>
              {decidedAt ? (
                <span class="font-mono text-[11px] text-ink-subtle">
                  {formatDateTime(decidedAt)}
                </span>
              ) : null}
            </div>
          ) : null}
          {onDecideClick ? (
            <Button variant={decision ? "secondary" : "primary"} onClick={onDecideClick}>
              {decision ? "Update decision" : "Decide"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}

function VersionPickerSkeleton({ stagedVersion }: { stagedVersion: string | null }) {
  return (
    <div class="flex flex-wrap items-center gap-3" aria-busy="true">
      <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
        Compare against
      </span>
      <div class="flex items-center bg-bg border border-border rounded-md text-[13px] text-ink-muted pl-3 pr-8 py-2 font-mono min-w-[200px] opacity-60">
        loading versions<span class="ml-0.5 motion-safe:animate-pulse">…</span>
      </div>
      <span class="font-mono text-[11px] text-ink-muted">→ staged {stagedVersion || "—"}</span>
    </div>
  );
}

function ScanFailureAlert({ errorJson }: { errorJson: unknown }) {
  const error =
    errorJson && typeof errorJson === "object"
      ? (errorJson as { message?: unknown; code?: unknown })
      : null;
  return (
    <Alert tone="critical">
      <div class="flex flex-col gap-1">
        <strong>{typeof error?.message === "string" ? error.message : "Review failed."}</strong>
        {typeof error?.code === "string" ? (
          <span class="font-mono text-xs">code: {error.code}</span>
        ) : null}
      </div>
    </Alert>
  );
}

const DIFF_STATUS_RANK: Record<DiffEntry["status"], number> = {
  added: 0,
  modified: 1,
  removed: 2,
  unchanged: 3,
};

function filterDiffEntries(
  entries: DiffEntry[],
  rawFilter: string,
  changedOnly: boolean,
): DiffEntry[] {
  const filter = rawFilter.trim().toLowerCase();
  return entries
    .filter((entry) => {
      if (changedOnly && entry.status === "unchanged") return false;
      if (!filter) return true;
      return entry.path.toLowerCase().includes(filter);
    })
    .sort((a, b) => {
      const status = DIFF_STATUS_RANK[a.status] - DIFF_STATUS_RANK[b.status];
      return status || a.path.localeCompare(b.path);
    });
}

function scanFilesToFileRecords(files: PersistedScanDetail["files"]): FileRecord[] {
  return files.map((file) => ({
    path: file.path,
    size: file.size ?? 0,
    sha256: file.sha256 ?? "",
    textSample: file.textSample ?? undefined,
    flags: Array.isArray(file.flagsJson) ? (file.flagsJson as string[]) : [],
  }));
}

function annotateFindingsWithDiffStatus(
  findings: PersistedFinding[],
  diff: DiffEntry[],
  preferPersistedStatus: boolean,
  previousFiles: FileRecord[],
  stagedFiles: FileRecord[],
  compareAnnotations?: Array<{ id: string } & FindingDiffAnnotation>,
): FindingWithDiffStatus[] {
  const persistedAnnotations = compareAnnotations
    ? new Map(
        compareAnnotations.map((annotation) => [
          annotation.id,
          {
            diffStatus: normalizeFindingDiffStatus(annotation.diffStatus),
            releaseDelta: Boolean(annotation.releaseDelta),
          },
        ]),
      )
    : preferPersistedStatus
      ? new Map(
          findings.flatMap((finding): Array<[string, FindingDiffAnnotation]> => {
            if (!finding.diffStatus) return [];
            return [
              [
                finding.id,
                {
                  diffStatus: normalizeFindingDiffStatus(finding.diffStatus),
                  releaseDelta: Boolean(finding.releaseDelta),
                },
              ],
            ];
          }),
        )
      : undefined;
  return annotateReviewFindingsWithDiffStatus(findings, diff, {
    persistedAnnotations,
    previousFiles,
    stagedFiles,
  }).map((finding) => {
    return {
      finding,
      diffStatus: finding.diffStatus,
      releaseDelta: finding.releaseDelta,
    };
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
