import type { ComponentProps } from "preact";
import { useEffect } from "preact/hooks";
import {
  type ReadonlySignal,
  useComputed,
  useModel,
  useSignal,
  useSignalEffect,
} from "@preact/signals";
import { useLocation, useRoute } from "preact-iso";
import { useQuerySignal } from "../../../lib/query-state";
import { sessionModel } from "../../../models/auth";
import { ScanDetailModel, type DecisionStatus, type ScanDecision } from "../../../models/scan";
import type { WorkflowGateDecision } from "../../../models/github-app";
import { displayedAiResult, type AiReview } from "../../../../server/lib/ai-review-types";
import { createPackageDiff, type DiffEntry } from "../../../../server/lib/review";
import {
  Alert,
  Card,
  FileTree,
  Input,
  LoadingLine,
  LoadingState,
  PageShell,
  SectionLabel,
  VersionPicker,
} from "../../../components";
import { DecisionDialog } from "./DecisionDialog";
import { GateContextPanel, GateDecisionDialog } from "./GateDecisionDialog";
import { DiffWorkbench } from "./DiffWorkbench";
import { RiskSignalsSection } from "./FindingsSection";
import { ReleaseRecommendation } from "./ReleaseRecommendation";
import { PersistedReportSections } from "./ReportSections";
import { ScanDetailHeader, ScanFailureAlert, VersionPickerSkeleton } from "./ScanDetailChrome";
import { filterDiffEntries, scanFilesToFileRecords } from "./diff-helpers";
import { useFindingsWithDiff } from "./hooks/useFindingsWithDiff";
import { useScanFileContent } from "./hooks/useScanFileContent";
import { useScanVersions } from "./hooks/useScanVersions";
import type { PersistedSummary } from "./types";

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

  const versionsSignal = useScanVersions(model);

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

  const findingsWithDiffStatus = useFindingsWithDiff(
    model.detail,
    model.compare,
    diffEntries,
    model.isDefaultComparison,
  );

  const stagedFile = useComputed(() => {
    const path = model.selectedPath.value;
    const detail = model.detail.value;
    if (!path) return null;
    return detail?.files.find((file) => file.path === path) ?? null;
  });

  const { previousFileMeta, previousFile } = useScanFileContent(
    model,
    model.selectedPath,
    model.selectedVersion,
  );

  if (!sessionChecked.value) {
    return (
      <PageShell>
        <ScanDetailHeader />
        <LoadingState title="Opening review" detail="confirming session · fetching report" />
      </PageShell>
    );
  }

  const detail = model.detail.value;
  const versions = versionsSignal.value;
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

  const gateReviewComplete = detail?.scan.status === "complete";
  const gateReviewFailed = detail?.scan.status === "failed";

  // npm scans become decidable once complete; gate scans are decidable while
  // pending after the review either completes or fails. Failed reviews can only
  // be rejected because approval releases the held GitHub job.
  const onDecideClick = isWorkflowGate
    ? gate?.status === "pending" && (gateReviewComplete || gateReviewFailed)
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
                  compareLoading={compareLoading}
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
        <DecisionDialogHost
          openSignal={decisionDialogOpen}
          onClose={() => (decisionDialogOpen.value = false)}
          decision={detail.scan.decision}
          decisionReason={detail.scan.decisionReason}
          decidedAt={detail.scan.decidedAt}
          statusSignal={model.decisionStatus}
          errorSignal={model.decisionError}
          onSubmit={handleDecisionSubmit}
        />
      ) : null}

      {detail && isWorkflowGate && gate ? (
        <GateDialogHost
          openSignal={gateDialogOpen}
          onClose={() => (gateDialogOpen.value = false)}
          gate={gate}
          packageName={detail.scan.packageName}
          statusSignal={model.gateDecisionStatus}
          errorSignal={model.gateDecisionError}
          canApprove={detail.scan.status === "complete"}
          onSubmit={handleGateDecision}
        />
      ) : null}
    </PageShell>
  );
}

// The dialog's reactive inputs (open/status/error) are read as signals inside
// these thin hosts rather than in ScanDetailPage's body. Reading `.value` here
// subscribes only the host, so opening the dialog and the save round-trip
// (idle → saving → idle/error) re-render the dialog alone — not the whole page,
// which includes the risk-signals list (one card per finding, thousands for a
// large package). Reading any of these in the page body re-renders that list
// synchronously and freezes the main thread for seconds.
function DecisionDialogHost({
  openSignal,
  statusSignal,
  errorSignal,
  ...props
}: Omit<ComponentProps<typeof DecisionDialog>, "open" | "status" | "error"> & {
  openSignal: ReadonlySignal<boolean>;
  statusSignal: ReadonlySignal<DecisionStatus>;
  errorSignal: ReadonlySignal<string | null>;
}) {
  return (
    <DecisionDialog
      open={openSignal.value}
      status={statusSignal.value}
      error={errorSignal.value}
      {...props}
    />
  );
}

function GateDialogHost({
  openSignal,
  statusSignal,
  errorSignal,
  ...props
}: Omit<ComponentProps<typeof GateDecisionDialog>, "open" | "status" | "error"> & {
  openSignal: ReadonlySignal<boolean>;
  statusSignal: ReadonlySignal<DecisionStatus>;
  errorSignal: ReadonlySignal<string | null>;
}) {
  return (
    <GateDecisionDialog
      open={openSignal.value}
      status={statusSignal.value}
      error={errorSignal.value}
      {...props}
    />
  );
}

function asPersistedSummary(value: unknown): PersistedSummary {
  if (!value || typeof value !== "object") return {};
  return value as PersistedSummary;
}

function asAiReview(value: unknown): AiReview | null {
  if (!value || typeof value !== "object") return null;
  return value as AiReview;
}
