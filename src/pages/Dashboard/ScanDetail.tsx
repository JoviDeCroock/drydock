import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { useComputed, useModel, useSignal, useSignalEffect } from "@preact/signals";
import { useLocation, useRoute } from "preact-iso";
import { getDashboardReturnUrl, useQuerySignal } from "../../lib/query-state";
import { getReleaseRecommendation } from "./recommendation";
import { sessionModel } from "../../models/auth";
import {
  ScanDetailModel,
  type DecisionStatus,
  type PersistedScanDetail,
  type ScanDecision,
} from "../../models/scan";
import type { AiFinding, AiReview, DisplayedAiResult } from "../../../server/lib/ai-review";
import { displayedAiResult } from "../../../server/lib/ai-review";
import {
  annotateFindingsWithDiffStatus as annotateReviewFindingsWithDiffStatus,
  createPackageDiff,
  normalizeFindingDiffStatus,
  type DiffEntry,
  type FindingDiffAnnotation,
  type FileRecord,
  type FindingDiffStatus,
} from "../../../server/lib/review";
import type { PackageJsonDiff } from "../../../server/types";
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  DiffView,
  EmptyLine,
  Field,
  FileTree,
  FindingCard,
  FindingRow,
  Input,
  LoadingLine,
  LoadingState,
  MonoDetail,
  Muted,
  PageShell,
  SectionLabel,
  SeverityBar,
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
    rulesVersion?: string;
  };
  packageJsonDiff?: PackageJsonDiff;
  diff?: DiffEntry[];
}

type PersistedFinding = PersistedScanDetail["findings"][number];

interface FindingWithDiffStatus {
  finding: PersistedFinding;
  diffStatus: FindingDiffStatus;
  releaseDelta: boolean;
}

export default function ScanDetailPage() {
  const location = useLocation();
  const route = useRoute();
  const id = route.params.id;
  const model = useModel(() => new ScanDetailModel(id));
  const sessionChecked = useSignal(false);
  const fileFilter = useSignal("");
  const changedFilesOnly = useSignal(true);
  const decisionDialogOpen = useSignal(false);

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

  // Fetch version metadata as soon as the scan is complete with a package name.
  useSignalEffect(() => {
    if (model.status.value !== "complete") return;
    if (!model.detail.value?.scan.packageName) return;
    if (model.versions.value) return;
    void model.loadVersions();
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

  const handleDecisionSubmit = async (decision: ScanDecision, reason: string | null) => {
    await model.setDecision(decision, reason);
    if (model.decisionStatus.peek() === "idle") {
      decisionDialogOpen.value = false;
    }
  };

  return (
    <PageShell>
      <ScanDetailHeader
        detail={detail}
        onDecideClick={
          detail?.scan.status === "complete" ? () => (decisionDialogOpen.value = true) : undefined
        }
      />

      {error ? <Alert tone="critical">{error}</Alert> : null}
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

      {detail && detail.scan.status === "complete" ? (
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
    </PageShell>
  );
}

function ReleaseRecommendation({
  detail,
  summary,
  ai,
  diffCount,
  findingsWithDiffStatus,
  usePersistedRiskSummary,
}: {
  detail: PersistedScanDetail;
  summary: PersistedSummary;
  ai: DisplayedAiResult | null;
  diffCount: number;
  findingsWithDiffStatus: FindingWithDiffStatus[];
  usePersistedRiskSummary: boolean;
}) {
  if (detail.scan.status !== "complete") return null;

  const changedFindings = findingsWithDiffStatus
    .filter((item) => item.releaseDelta)
    .map((item) => item.finding);
  const artifactRisk = detail.riskSummary?.artifactRisk ?? detail.scan.risk;
  const releaseRisk =
    usePersistedRiskSummary && detail.riskSummary
      ? detail.riskSummary.releaseRisk
      : highestFindingRisk(changedFindings);
  const releaseFindingCount =
    usePersistedRiskSummary && detail.riskSummary
      ? detail.riskSummary.releaseFindingCount
      : changedFindings.length;
  const aiFindings: AiFinding[] = ai?.kind === "complete" ? ai.findings : [];
  const recommendation = getReleaseRecommendation(artifactRisk, releaseRisk, releaseFindingCount);
  const evidence = buildRecommendationEvidence(
    detail,
    summary,
    diffCount,
    changedFindings,
    aiFindings,
  );
  const severityCounts = countSeverities([...detail.findings, ...aiFindings]);
  const findingTotal = Object.values(severityCounts).reduce((sum, count) => sum + (count ?? 0), 0);

  return (
    <section class="flex flex-col gap-3">
      <SectionLabel>Recommendation</SectionLabel>
      <div class="flex flex-wrap items-center gap-2">
        <Badge tone={recommendation.tone}>{recommendation.label}</Badge>
        {artifactRisk !== releaseRisk ? (
          <Badge tone="neutral">artifact {artifactRisk}</Badge>
        ) : null}
        {ai?.model != null &&
          (ai.kind === "complete" ? (
            <>
              <Badge tone={ai.requiresManualReview ? "medium" : "ok"}>
                {ai.requiresManualReview ? "manual review" : "no extra review"}
              </Badge>
              <Badge tone="neutral">{ai.releaseAssessment.replaceAll("_", " ")}</Badge>
            </>
          ) : (
            <Badge tone="neutral">assistant unavailable</Badge>
          ))}
      </div>
      {recommendation.copy ? (
        <p class="m-0 max-w-[760px] text-[14px] leading-[1.55] text-ink-muted">
          {recommendation.copy}
        </p>
      ) : null}
      <ul class="list-none p-0 m-0 flex flex-col gap-2">
        {evidence.map((item, index) => (
          <li
            key={`${item.label}-${index}`}
            class="grid grid-cols-[112px_minmax(0,1fr)] gap-3 text-[13px]"
          >
            <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
              {item.label}
            </span>
            <span class="min-w-0 text-ink-muted">{item.value}</span>
          </li>
        ))}
      </ul>
      {findingTotal ? <SeverityBar counts={severityCounts} class="max-w-[520px]" /> : null}
    </section>
  );
}

function buildRecommendationEvidence(
  detail: PersistedScanDetail,
  summary: PersistedSummary,
  diffCount: number,
  changedFindings: PersistedFinding[],
  assistantFindings: AiFinding[],
): Array<{ label: string; value: ComponentChildren }> {
  const evidence: Array<{ label: string; value: ComponentChildren }> = [];
  const releaseFindings: RecommendationFinding[] = [...changedFindings, ...assistantFindings];
  const topFindings = sortFindingsBySeverity(
    releaseFindings.length ? releaseFindings : detail.findings,
  ).slice(0, 3);
  for (const finding of topFindings) {
    evidence.push({
      label: releaseFindings.length ? (finding.severity ?? "signal") : "existing",
      value: (
        <>
          <code>{finding.file}</code>: {finding.reason}
        </>
      ),
    });
  }

  const manifest = summary.packageJsonDiff;
  if (manifest?.scripts.length) {
    evidence.push({
      label: "scripts",
      value: `${manifest.scripts.length} lifecycle or package script ${pluralize(
        "change",
        manifest.scripts.length,
      )}.`,
    });
  }
  if (manifest?.dependencies.length) {
    evidence.push({
      label: "deps",
      value: `${manifest.dependencies.length} dependency ${pluralize(
        "change",
        manifest.dependencies.length,
      )}.`,
    });
  }
  if (manifest?.entrypointsChanged) {
    evidence.push({ label: "entrypoints", value: "Package entrypoints changed." });
  }
  if (evidence.length === 0) {
    const changed =
      diffCount ||
      summary.diff?.filter((entry) => entry.status !== "unchanged").length ||
      detail.files.filter((file) => file.status !== "unchanged").length;
    evidence.push({
      label: "evidence",
      value: `${changed} changed ${pluralize("file", changed)} and no deterministic risk signals.`,
    });
  }

  return evidence.slice(0, 5);
}

type RecommendationFinding = {
  severity?: string;
  file: string;
  reason: string;
};

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
      {onDecideClick ? (
        <div class="flex flex-wrap items-start gap-3">
          {decision ? (
            <div class="flex flex-col items-end gap-1">
              <Badge tone={decision === "publish" ? "ok" : "critical"}>
                {decision === "publish" ? "approved" : "blocked"}
              </Badge>
              {decidedAt ? (
                <span class="font-mono text-[11px] text-ink-subtle">{formatDate(decidedAt)}</span>
              ) : null}
            </div>
          ) : null}
          <Button variant={decision ? "secondary" : "primary"} onClick={onDecideClick}>
            {decision ? "Update decision" : "Decide"}
          </Button>
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

function DiffWorkbench({
  entry,
  staged,
  previousMeta,
  previousContent,
  compareReady,
  selectedVersion,
  stagedVersion,
}: {
  entry: DiffEntry | null;
  staged: PersistedScanDetail["files"][number] | null;
  previousMeta: FileRecord | null;
  previousContent: FileRecord | null;
  compareReady: boolean;
  selectedVersion: string | null;
  stagedVersion: string | null | undefined;
}) {
  if (!entry) {
    return <EmptyLine>Select a file from the tree to diff.</EmptyLine>;
  }

  const needsPrevious = entry.status !== "added";
  const isBinaryPrev = Boolean(previousMeta?.flags?.includes("binary"));

  if (needsPrevious && !compareReady && entry.status !== "unchanged") {
    return <LoadingLine>Loading previous version metadata</LoadingLine>;
  }

  if (needsPrevious && previousMeta && !isBinaryPrev && !previousContent) {
    return <LoadingLine size="inline">Loading file</LoadingLine>;
  }

  if (!staged && !previousContent && !previousMeta) {
    return <EmptyLine>No file content available.</EmptyLine>;
  }

  return (
    <DiffView
      path={entry.path}
      status={entry.status}
      beforeLabel={selectedVersion ? `previous (${selectedVersion})` : "previous"}
      afterLabel={`staged (${stagedVersion ?? "current"})`}
      before={
        previousContent
          ? toDiffSide(previousContent)
          : previousMeta
            ? toDiffSide(previousMeta)
            : null
      }
      after={staged ? scanFileToDiffSide(staged) : null}
    />
  );
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

function DecisionDialog({
  open,
  onClose,
  decision,
  decisionReason,
  decidedAt,
  status,
  error,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  decision?: string | null;
  decisionReason?: string | null;
  decidedAt?: string | number | Date | null;
  status: DecisionStatus;
  error: string | null;
  onSubmit: (decision: ScanDecision, reason: string | null) => void | Promise<void>;
}) {
  const reasonDraft = useSignal("");
  const saving = status === "saving";

  useEffect(() => {
    if (open) {
      reasonDraft.value = decisionReason ?? "";
    }
  }, [open, decisionReason]);

  const submit = (next: ScanDecision) => {
    if (saving) return;
    const trimmed = reasonDraft.value.trim();
    void onSubmit(next, trimmed.length ? trimmed : null);
  };

  const handleClose = () => {
    if (saving) return;
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Publish decision"
      description="Record whether this staged publish is approved to go live. The decision is part of the audit trail. It doesn't publish or cancel the release on npm — that still requires you to confirm or cancel with 2FA there."
    >
      {decision ? (
        <div class="flex flex-col gap-2 border border-border rounded-md p-3">
          <div class="flex flex-wrap items-center gap-2">
            <Badge tone={decision === "publish" ? "ok" : "critical"}>
              {decision === "publish" ? "currently approved" : "currently blocked"}
            </Badge>
            {decidedAt ? (
              <span class="font-mono text-[11px] text-ink-subtle">{formatDate(decidedAt)}</span>
            ) : null}
          </div>
          {decisionReason ? (
            <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">{decisionReason}</p>
          ) : null}
        </div>
      ) : null}

      <Field label="Reason (optional)" for="decisionReason">
        <Input
          id="decisionReason"
          type="text"
          value={reasonDraft.value}
          placeholder="e.g. minor patch, no risk signals"
          onInput={(e) => (reasonDraft.value = (e.target as HTMLInputElement).value)}
          disabled={saving}
          maxLength={500}
          autoComplete="off"
          spellcheck={false}
        />
      </Field>

      <div class="flex flex-wrap gap-2">
        <Button onClick={() => submit("publish")} disabled={saving}>
          {saving ? "Saving…" : "Approve publish"}
        </Button>
        <Button variant="danger" onClick={() => submit("no_publish")} disabled={saving}>
          {saving ? "Saving…" : "Block publish"}
        </Button>
      </div>
      {error ? <Alert tone="critical">{error}</Alert> : null}
    </Dialog>
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

function RiskSignalsSection({ findings }: { findings: FindingWithDiffStatus[] }) {
  const changedFindings = sortFindingItemsBySeverity(findings.filter((item) => item.releaseDelta));
  const contextualFindings = sortFindingItemsBySeverity(
    findings.filter((item) => !item.releaseDelta),
  );
  const contextLabel = `${contextualFindings.length} context ${pluralize(
    "signal",
    contextualFindings.length,
  )}`;

  return (
    <section class="flex flex-col gap-3">
      <SectionLabel>Risk signals</SectionLabel>
      <div class="flex flex-wrap items-center gap-2">
        <Badge tone={changedFindings.length ? "medium" : "ok"}>
          {changedFindings.length
            ? `${changedFindings.length} changed-file ${pluralize(
                "signal",
                changedFindings.length,
              )}`
            : "no changed-file signals"}
        </Badge>
        {contextualFindings.length ? <Badge tone="neutral">{contextLabel}</Badge> : null}
      </div>
      <Muted class="m-0 text-[13px] leading-[1.55] max-w-[760px]">
        Deterministic rules scan the full staged artifact; unchanged signals are retained as package
        context and separated from this release's changed files.
      </Muted>

      {changedFindings.length ? (
        <FindingGrid findings={changedFindings} />
      ) : (
        <EmptyLine>No deterministic risk signals point at this release delta.</EmptyLine>
      )}

      {contextualFindings.length ? (
        <details class="group border-y border-border py-3">
          <summary class="cursor-pointer list-none flex flex-wrap items-center justify-between gap-3">
            <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
              Package context
            </span>
            <span class="font-mono text-[11px] text-ink-subtle">
              {contextualFindings.length} {pluralize("signal", contextualFindings.length)}
            </span>
          </summary>
          <div class="pt-3">
            <FindingGrid findings={contextualFindings} />
          </div>
        </details>
      ) : null}
    </section>
  );
}

function FindingGrid({ findings }: { findings: FindingWithDiffStatus[] }) {
  return (
    <ul class="list-none p-0 m-0 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {findings.map(({ finding, diffStatus }) => (
        <FindingCard
          key={finding.id}
          severity={finding.severity}
          file={finding.file}
          line={finding.line}
          diffStatus={diffStatus === "unknown" ? null : diffStatus}
          diffLabel={findingDiffStatusLabel(diffStatus)}
          ruleId={finding.ruleId}
        >
          <FindingRow label="evidence" value={finding.evidence} />
          <FindingRow label="reason" value={finding.reason} />
        </FindingCard>
      ))}
    </ul>
  );
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

function sortFindingItemsBySeverity(items: FindingWithDiffStatus[]): FindingWithDiffStatus[] {
  return items.slice().sort((a, b) => {
    const severity = compareSeverity(a.finding.severity, b.finding.severity);
    return severity || a.finding.file.localeCompare(b.finding.file);
  });
}

function findingDiffStatusLabel(status: FindingDiffStatus): string | null {
  if (status === "unknown") return null;
  if (status === "unchanged") return "existing";
  return status;
}

const SEVERITY_RANK: Record<SeverityKey, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
  ok: 5,
};

function sortFindingsBySeverity<T extends { severity?: string }>(findings: T[]): T[] {
  return findings.slice().sort((a, b) => {
    return compareSeverity(a.severity, b.severity);
  });
}

function compareSeverity(a: string | undefined, b: string | undefined): number {
  const aRank = SEVERITY_RANK[normalizeSeverityKey(a) ?? "info"] ?? SEVERITY_RANK.info;
  const bRank = SEVERITY_RANK[normalizeSeverityKey(b) ?? "info"] ?? SEVERITY_RANK.info;
  return aRank - bRank;
}

function highestFindingRisk(findings: Array<{ severity?: string }>): string {
  if (findings.some((finding) => finding.severity === "critical")) return "critical";
  if (findings.some((finding) => finding.severity === "high")) return "high";
  if (findings.some((finding) => finding.severity === "medium")) return "medium";
  return "low";
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

function PersistedReportSections({
  summary,
  ai,
}: {
  summary: PersistedSummary;
  ai: DisplayedAiResult | null;
}) {
  return (
    <section class="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-6">
      <ReportSection title="Manifest changes" class="lg:col-span-2">
        {summary.packageJsonDiff ? (
          <PackageJsonDiffView diff={summary.packageJsonDiff} />
        ) : (
          <EmptyLine>No manifest changes were saved for this review.</EmptyLine>
        )}
      </ReportSection>

      {ai != null && ai.model != null && (
        <ReportSection title="Reviewer notes" class="lg:col-span-2">
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
      </div>
    </div>
  );
}

function InlineMeta({ label, value }: { label: string; value: string }) {
  return (
    <div class="flex items-baseline gap-2 min-w-0">
      <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle flex-shrink-0">
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
      <div class="px-3 py-2 bg-surface-2 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
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

function pluralize(word: string, count: number) {
  return count === 1 ? word : `${word}s`;
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
