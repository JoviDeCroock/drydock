import { batch, useComputed, useSignal, useSignalEffect } from "@preact/signals";
import { useLocation } from "preact-iso";
import { displayedAiResult, type AiReview } from "../../../../../server/lib/ai-review/types";
import { normalizeIntentEnvelope } from "../../../../../server/lib/intent-envelope";
import { createPackageDiff, type DiffEntry } from "../../../../../server/lib/review";
import { npmStagedPackagesUrlFor } from "../../../../lib/npm-staged-url";
import { getDashboardReturnUrl, useQuerySignal } from "../../../../lib/query-state";
import { sessionModel } from "../../../../models/auth";
import type { WorkflowGateDecision } from "../../../../models/github-app";
import type { ScanDecision, ScanDetailModelInstance } from "../../../../models/scan";
import { findingCountsByPath } from "../../../../features/review/diff-entries";
import type { ReviewFinding } from "../../../../features/review/types";
import { useSelectedDiffFile } from "../../../../features/review/useSelectedDiffFile";
import { scanFilesToFileRecords } from "../diff-helpers";
import { hasReleaseConsistencyNote } from "../ReleaseConsistencyNotice";
import { buildReleaseVerdict } from "../ReleaseRecommendation";
import { reviewerSummaryVisible } from "../ReviewerSummary";
import type { PersistedSummary } from "../types";
import { useFindingsWithDiff } from "./useFindingsWithDiff";
import { useScanFileContent } from "./useScanFileContent";
import { useScanVersions } from "./useScanVersions";

export type ReleaseVerdict = ReturnType<typeof buildReleaseVerdict>;

/**
 * Move the reader to a report section. Focus without scroll first so the
 * section owns the caret for assistive tech, then scroll it into view.
 */
export function focusReportSection(id: string) {
  const section = document.getElementById(id);
  section?.focus({ preventScroll: true });
  section?.scrollIntoView({ block: "start" });
}

/**
 * Everything the scan detail page derives from its model: query-bound filter
 * state, the four dialog latches, the diff/findings computeds, the verdict,
 * and the decision handlers. Each is a signal or a stable function, so the
 * page sections subscribe to what they render and nothing else — the risk
 * index (one card per finding) must not re-render on a dialog's save
 * round-trip or on a filter keystroke.
 */
export function useScanDetailView(model: ScanDetailModelInstance) {
  const location = useLocation();
  const fileFilter = useSignal("");
  const changedFilesOnly = useSignal(true);
  // The finding the reader asked to see, so the diff can seek its annotation.
  const findingTarget = useSignal<ReviewFinding | null>(null);
  const decisionDialogOpen = useSignal(false);
  const gateDialogOpen = useSignal(false);
  const deleteDialogOpen = useSignal(false);
  const shareDialogOpen = useSignal(false);

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

  const versions = useScanVersions(model);

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
  // Older scans have no envelope; the normalizer returns null and the section
  // is simply not rendered.
  const intentEnvelope = useComputed(() => normalizeIntentEnvelope(summary.value.intentEnvelope));

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

  const findingsWithDiffStatus = useFindingsWithDiff(
    model.detail,
    model.compare,
    diffEntries,
    model.isDefaultComparison,
  );
  const selected = useSelectedDiffFile(diffEntries, model.selectedPath, findingsWithDiffStatus);
  // Per-file finding counts for the tree, built once from the same finding set
  // that feeds the inline annotations and the risk-signals index.
  const findingCounts = useComputed(() => findingCountsByPath(findingsWithDiffStatus.value));
  const fileContent = useScanFileContent(model, model.selectedPath, model.selectedVersion);

  const npmStagedPackagesUrl = useComputed(() => {
    const scan = model.detail.value?.scan;
    return scan ? npmStagedPackagesUrlFor(scan) : null;
  });

  const verdict = useComputed<ReleaseVerdict | null>(() => {
    const detail = model.detail.value;
    const persistedSummary = summary.value;
    const entries = diffEntries.value;
    const findings = findingsWithDiffStatus.value;
    const usePersistedRiskSummary = model.isDefaultComparison.value || !model.compare.value;
    const isWorkflowGate = model.isWorkflowGate.value;
    if (!detail || detail.scan.status !== "complete") return null;
    return buildReleaseVerdict({
      detail,
      summary: persistedSummary,
      diffCount: entries.filter((entry) => entry.status !== "unchanged").length,
      findingsWithDiffStatus: findings,
      usePersistedRiskSummary,
      isWorkflowGate,
    });
  });

  // Open the advisory group when it carries context worth reading. Its title
  // stays quiet; repeating every nested section name in the summary made the
  // report header harder to scan than its contents.
  const reviewNotesOpen = useComputed(
    () =>
      reviewerSummaryVisible(ai.value) ||
      hasReleaseConsistencyNote(summary.value.releaseConsistency) ||
      Boolean(intentEnvelope.value) ||
      Boolean(verdict.value?.hasSignals),
  );

  const inspectFindings = () => focusReportSection("risk-signals");
  // AI findings carry no file anchor, and a finding can name a file the
  // current comparison does not contain; both fall back to the index.
  const canInspectFinding = (finding: ReviewFinding) =>
    finding.source !== "ai" && diffEntries.peek().some((entry) => entry.path === finding.file);
  const inspectFile = (path: string, finding: ReviewFinding | null = null) => {
    const entry = diffEntries.peek().find((item) => item.path === path);
    if (!entry) {
      inspectFindings();
      return;
    }
    batch(() => {
      fileFilter.value = "";
      if (entry.status === "unchanged") changedFilesOnly.value = false;
      // A fresh request also seeks the annotation when this file is already open.
      findingTarget.value = finding ? { ...finding } : null;
      model.selectPath(path);
    });
    focusReportSection("release-workbench");
  };
  const inspectFinding = (finding: ReviewFinding) => {
    if (!canInspectFinding(finding)) {
      inspectFindings();
      return;
    }
    inspectFile(finding.file, finding);
  };

  // A step-up prompt only appears for members who enrolled in 2FA.
  const requireTwoFactor = useComputed(() =>
    Boolean(sessionModel.session.value?.user.twoFactorEnabled),
  );

  const openDecision = () => (decisionDialogOpen.value = true);
  const openGate = () => (gateDialogOpen.value = true);
  const openDelete = () => (deleteDialogOpen.value = true);
  const openShare = () => {
    shareDialogOpen.value = true;
    void model.loadAttestationAvailability();
  };

  const gateReviewFailed = useComputed(() => model.detail.value?.scan.status === "failed");

  // npm scans become decidable once complete; gate scans are decidable while
  // pending after the review either completes or fails. Human decisions remain
  // allowed even when automated review fails; the retry action gives a safer
  // first move when the maintainer wants a fresh automated pass.
  const decideAction = useComputed<(() => void) | undefined>(() => {
    const detail = model.detail.value;
    const status = detail?.scan.status;
    if (model.isWorkflowGate.value) {
      const gate = model.gate.value;
      return gate?.status === "pending" && (status === "complete" || status === "failed")
        ? openGate
        : undefined;
    }
    return status === "complete" && detail?.scan.registryStatusSupersededAt == null
      ? openDecision
      : undefined;
  });

  const shareAction = useComputed<(() => void) | undefined>(() => {
    const detail = model.detail.value;
    return detail?.scan.status === "complete" && detail.scan.registryStatusSupersededAt == null
      ? openShare
      : undefined;
  });

  const deleteAction = useComputed<(() => void) | undefined>(() =>
    model.detail.value?.scan.status === "failed" ? openDelete : undefined,
  );

  const handleDecisionSubmit = async (decision: ScanDecision, reason: string | null) => {
    await model.setDecision(decision, reason);
    const saved = model.decisionStatus.peek() === "idle";
    if (saved) decisionDialogOpen.value = false;
    return saved;
  };

  const handleGateDecision = async (
    decision: WorkflowGateDecision,
    comment: string | null,
    totpCode: string | null,
  ) => {
    await model.decideGate(decision, comment, totpCode);
    if (model.gateDecisionStatus.peek() === "idle") gateDialogOpen.value = false;
  };

  const handleGateRetry = async () => {
    await model.retryGate();
    if (model.gateRetryStatus.peek() === "idle") location.route("/dashboard", true);
  };

  const handleDelete = async () => {
    const deleted = await model.deleteFailed();
    if (deleted) location.route(getDashboardReturnUrl(), true);
    return deleted;
  };

  return {
    fileFilter,
    changedFilesOnly,
    findingTarget,
    inspectFindings,
    canInspectFinding,
    inspectFile,
    inspectFinding,
    decisionDialogOpen,
    gateDialogOpen,
    deleteDialogOpen,
    shareDialogOpen,
    versions,
    summary,
    ai,
    intentEnvelope,
    diffEntries,
    findingsWithDiffStatus,
    selectedEntry: selected.entry,
    selectedFindings: selected.findings,
    findingCounts,
    ...fileContent,
    npmStagedPackagesUrl,
    verdict,
    reviewNotesOpen,
    requireTwoFactor,
    gateReviewFailed,
    decideAction,
    shareAction,
    deleteAction,
    handleDecisionSubmit,
    handleGateDecision,
    handleGateRetry,
    handleDelete,
  };
}

export type ScanDetailView = ReturnType<typeof useScanDetailView>;

function asPersistedSummary(value: unknown): PersistedSummary {
  if (!value || typeof value !== "object") return {};
  return value as PersistedSummary;
}

function asAiReview(value: unknown): AiReview | null {
  if (!value || typeof value !== "object") return null;
  return value as AiReview;
}
