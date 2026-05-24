import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { useComputed, useModel, useSignal, useSignalEffect } from "@preact/signals";
import { useLocation, useRoute } from "preact-iso";
import { sessionModel } from "../../models/auth";
import {
  ScanDetailModel,
  type DecisionStatus,
  type PersistedScanDetail,
  type ScanDecision,
} from "../../models/scan";
import type { AiFinding, AiReview } from "../../../server/lib/ai-review";
import { createPackageDiff, type DiffEntry, type FileRecord } from "../../../server/lib/review";
import type { PackageJsonDiff, ScanResult } from "../../../server/types";
import {
  Alert,
  Badge,
  Button,
  Card,
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
  safety?: ScanResult["safety"];
}

export default function ScanDetailPage() {
  const location = useLocation();
  const route = useRoute();
  const id = route.params.id;
  const model = useModel(() => new ScanDetailModel(id));
  const sessionChecked = useSignal(false);
  const fileFilter = useSignal("");
  const changedFilesOnly = useSignal(true);

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
  const ai = useComputed(() => asAiReview(model.detail.value?.scan.aiJson));

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

  return (
    <PageShell>
      <ScanDetailHeader detail={detail} />

      {error ? <Alert tone="critical">{error}</Alert> : null}
      {detail?.scan.status === "pending" || detail?.scan.status === "running" ? (
        <Alert tone="info">
          Review is {detail.scan.status}. This page refreshes automatically until the report is
          ready.
        </Alert>
      ) : null}
      {detail?.scan.status === "failed" ? (
        <ScanFailureAlert errorJson={detail.scan.errorJson} />
      ) : null}

      {!detail && !error ? (
        <LoadingState title="Loading saved review" detail="fetching report · normalizing diff" />
      ) : null}

      {detail ? (
        <>
          <ReleaseRecommendation
            detail={detail}
            summary={summary.value}
            diffCount={diffEntries.value.filter((entry) => entry.status !== "unchanged").length}
          />

          <ReportOverview
            detail={detail}
            summary={summary.value}
            ai={ai.value}
            findings={detail.findings}
            aiFindings={ai.value?.findings ?? []}
            diffCount={diffEntries.value.filter((entry) => entry.status !== "unchanged").length}
          />

          {detail.scan.status === "complete" ? (
            <DecisionPanel
              decision={detail.scan.decision}
              decisionReason={detail.scan.decisionReason}
              decidedAt={detail.scan.decidedAt}
              status={model.decisionStatus.value}
              error={model.decisionError.value}
              onSubmit={(decision, reason) => void model.setDecision(decision, reason)}
            />
          ) : null}

          <ScanTimeline events={detail.events ?? []} />

          {versions ? (
            <div class="flex flex-col gap-2 border-y border-border py-3">
              <VersionPicker
                options={versions.versions}
                selected={selectedVersion}
                defaultVersion={versions.defaultPreviousVersion}
                stagedVersion={versions.stagedVersion}
                onChange={(value) => model.selectVersion(value)}
                disabled={compareLoading}
              />
              {compareLoading ? (
                <LoadingLine size="inline">Fetching {selectedVersion} via sandbox</LoadingLine>
              ) : null}
              {compareError ? <Alert tone="warn">{compareError}</Alert> : null}
            </div>
          ) : compareError ? (
            <Alert tone="warn">{compareError}</Alert>
          ) : null}

          <section class={workbenchGridClass}>
            <Card as="aside" class="p-0 overflow-hidden flex flex-col">
              <div class="px-4 py-3 border-b border-border flex flex-col gap-3">
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
              </div>
              <div class="flex flex-col overflow-y-auto h-[640px] py-2">
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
            <section class="flex flex-col gap-3">
              <SectionLabel>Risk signals</SectionLabel>
              <ul class="list-none p-0 m-0 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {sortFindingsBySeverity(detail.findings).map((finding) => (
                  <FindingCard
                    key={finding.id}
                    severity={finding.severity}
                    file={finding.file}
                    ruleId={finding.ruleId}
                  >
                    <FindingRow label="evidence" value={finding.evidence} />
                    <FindingRow label="reason" value={finding.reason} />
                  </FindingCard>
                ))}
              </ul>
            </section>
          ) : null}

          <PersistedReportSections summary={summary.value} ai={ai.value} />
        </>
      ) : null}
    </PageShell>
  );
}

function ReleaseRecommendation({
  detail,
  summary,
  diffCount,
}: {
  detail: PersistedScanDetail;
  summary: PersistedSummary;
  diffCount: number;
}) {
  if (detail.scan.status !== "complete") return null;

  const recommendation = getReleaseRecommendation(detail.scan.risk);
  const evidence = buildRecommendationEvidence(detail, summary, diffCount);

  return (
    <section class="flex flex-col gap-3 border-y border-border py-4">
      <SectionLabel>Recommendation</SectionLabel>
      <div class="flex flex-wrap items-center gap-2">
        <Badge tone={recommendation.tone}>{recommendation.label}</Badge>
        <Badge tone={severityTone(detail.scan.risk)}>{detail.scan.risk}</Badge>
      </div>
      <p class="m-0 max-w-[760px] text-[14px] leading-[1.55] text-ink-muted">
        {recommendation.copy}
      </p>
      <ul class="list-none p-0 m-0 flex flex-col gap-2">
        {evidence.map((item) => (
          <li
            key={`${item.label}-${item.value}`}
            class="grid grid-cols-[112px_minmax(0,1fr)] gap-3 text-[13px]"
          >
            <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
              {item.label}
            </span>
            <span class="min-w-0 text-ink-muted">{item.value}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function getReleaseRecommendation(risk: string): {
  label: string;
  tone: "critical" | "high" | "medium" | "ok" | "neutral";
  copy: string;
} {
  if (risk === "critical" || risk === "high") {
    return {
      label: "block manual approval",
      tone: risk,
      copy: "Do not approve this staged publish until the highlighted release evidence has been reviewed and resolved outside this tool.",
    };
  }
  if (risk === "medium") {
    return {
      label: "review carefully",
      tone: "medium",
      copy: "Pause before approving and inspect the highest-impact findings, manifest changes, and changed files below.",
    };
  }
  return {
    label: "likely safe",
    tone: "ok",
    copy: "No blocking deterministic signals were found; approval still remains a maintainer action in npm.",
  };
}

function buildRecommendationEvidence(
  detail: PersistedScanDetail,
  summary: PersistedSummary,
  diffCount: number,
): Array<{ label: string; value: ComponentChildren }> {
  const evidence: Array<{ label: string; value: ComponentChildren }> = [];
  const topFindings = sortFindingsBySeverity(detail.findings).slice(0, 3);
  for (const finding of topFindings) {
    evidence.push({
      label: finding.severity,
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

function ScanTimeline({ events }: { events: PersistedScanDetail["events"] }) {
  const visibleEvents = events.filter((event) => event.type !== "scan.viewed");

  return (
    <section class="flex flex-col gap-3">
      <SectionLabel>Review timeline</SectionLabel>
      {visibleEvents.length ? (
        <ol class="list-none p-0 m-0 border-y border-border divide-y divide-border">
          {visibleEvents.map((event) => {
            const item = describeTimelineEvent(event);
            return (
              <li
                key={event.id}
                class="grid grid-cols-1 md:grid-cols-[128px_180px_minmax(0,1fr)] gap-2 px-0 py-2.5 text-[13px]"
              >
                <time class="font-mono text-[11px] text-ink-subtle">
                  {formatDate(event.createdAt)}
                </time>
                <div class="flex items-center gap-2">
                  <Badge tone={item.tone}>{item.label}</Badge>
                </div>
                <span class="text-ink-muted min-w-0">{item.detail}</span>
              </li>
            );
          })}
        </ol>
      ) : (
        <EmptyLine>No lifecycle events were saved for this review.</EmptyLine>
      )}
    </section>
  );
}

function describeTimelineEvent(event: PersistedScanDetail["events"][number]): {
  label: string;
  tone: "critical" | "medium" | "info" | "ok" | "neutral";
  detail: ComponentChildren;
} {
  const metadata = asRecord(event.metadataJson);
  switch (event.type) {
    case "scan.queued":
      return { label: "queued", tone: "info", detail: "Queued for background review." };
    case "scan.backgrounded":
      return { label: "queued", tone: "info", detail: "Started local background review." };
    case "scan.started":
      return {
        label: "started",
        tone: "info",
        detail: `Review attempt ${readNumber(metadata.attempt) ?? 1} started.`,
      };
    case "npm_connection.used": {
      const registryUrl = readString(metadata.registryUrl);
      return {
        label: "npm access",
        tone: "neutral",
        detail: registryUrl
          ? `Fetched release evidence from ${registryUrl}.`
          : "Fetched release evidence with the organization npm token.",
      };
    }
    case "scan.retryable_failed": {
      const error = asRecord(metadata.error);
      const message = readString(error.message);
      return {
        label: "retry",
        tone: "medium",
        detail: message
          ? `${message} Attempt ${readNumber(metadata.attempt) ?? 1} will retry if attempts remain.`
          : "A retryable review failure was recorded.",
      };
    }
    case "scan.failed": {
      const error = asRecord(metadata.error);
      return {
        label: "failed",
        tone: "critical",
        detail:
          readString(error.message) ?? "The review failed before a report could be generated.",
      };
    }
    case "scan.completed":
      return { label: "complete", tone: "ok", detail: "Report generated and saved." };
    case "scan.decided": {
      const decision = readString(metadata.decision);
      const reason = readString(metadata.reason);
      const approved = decision === "publish";
      const blocked = decision === "no_publish";
      return {
        label: approved ? "approved" : blocked ? "blocked" : "decision",
        tone: approved ? "ok" : blocked ? "critical" : "neutral",
        detail: reason ? `Decision recorded: ${reason}` : "Publish decision recorded.",
      };
    }
    default:
      return {
        label: event.type.replace(/^scan\./, "").replaceAll("_", " "),
        tone: "neutral",
        detail: readString(metadata.stageId)
          ? `Stage ${readString(metadata.stageId)}.`
          : "Lifecycle event recorded.",
      };
  }
}

function ScanDetailHeader({ detail }: { detail?: PersistedScanDetail | null } = {}) {
  return (
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
            <span key="version">
              {detail.scan.previousVersion || "—"} → {detail.scan.stagedVersion || "—"}
            </span>,
            <Badge key="risk" tone={severityTone(detail.scan.risk)}>
              {detail.scan.risk}
            </Badge>,
            <span key="scan-id">scan {detail.scan.id.slice(0, 12)}</span>,
          ]}
        />
      ) : (
        <LoadingLine size="inline">Loading saved review</LoadingLine>
      )}
    </header>
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

function DecisionPanel({
  decision,
  decisionReason,
  decidedAt,
  status,
  error,
  onSubmit,
}: {
  decision?: string | null;
  decisionReason?: string | null;
  decidedAt?: string | number | Date | null;
  status: DecisionStatus;
  error: string | null;
  onSubmit: (decision: ScanDecision, reason: string | null) => void;
}) {
  const editing = useSignal(!decision);
  const reasonDraft = useSignal("");
  const expanded = useSignal(false);
  const saving = status === "saving";

  useSignalEffect(() => {
    if (!decision) {
      editing.value = true;
      return;
    }
    editing.value = false;
    reasonDraft.value = "";
  });

  const submit = (next: ScanDecision) => {
    const trimmed = reasonDraft.value.trim();
    onSubmit(next, trimmed.length ? trimmed : null);
  };

  const showForm = editing.value || !decision;
  const isExpanded = expanded.value || Boolean(error);

  return (
    <Card class="p-5 flex flex-col gap-4 border-accent/40">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-3">
          <SectionLabel>Publish decision</SectionLabel>
          {decision ? (
            <Badge tone={decision === "publish" ? "ok" : "critical"}>
              {decision === "publish" ? "approved" : "blocked"}
            </Badge>
          ) : (
            <Badge tone="neutral">undecided</Badge>
          )}
          {!isExpanded && decision && decidedAt ? (
            <span class="font-mono text-[11px] text-ink-subtle">{formatDate(decidedAt)}</span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => (expanded.value = !expanded.value)}
          class="bg-transparent border-0 p-0 cursor-pointer font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle hover:text-ink"
          aria-expanded={isExpanded}
        >
          {isExpanded ? "Collapse" : "Expand"}
        </button>
      </div>

      {isExpanded ? (
        <>
          <Muted class="text-[13px] max-w-[640px]">
            Record whether this staged publish is approved to go live. The decision is part of the
            audit trail. It doesn't publish or cancel the release on npm — that still requires you
            to confirm or cancel with 2FA there.
          </Muted>

          {decision && !editing.value ? (
            <div class="flex flex-col gap-2">
              <MonoDetail
                parts={[
                  <span key="kind">
                    {decision === "publish" ? "approved publish" : "blocked publish"}
                  </span>,
                  <span key="at">{decidedAt ? formatDate(decidedAt) : "just now"}</span>,
                ]}
              />
              {decisionReason ? (
                <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">{decisionReason}</p>
              ) : null}
              <div class="flex">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    reasonDraft.value = decisionReason ?? "";
                    editing.value = true;
                  }}
                >
                  Change decision
                </Button>
              </div>
            </div>
          ) : null}

          {showForm ? (
            <div class="flex flex-col gap-3">
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
                {decision ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      editing.value = false;
                      reasonDraft.value = "";
                    }}
                    disabled={saving}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
              {error ? <Alert tone="critical">{error}</Alert> : null}
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
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
  const changed =
    diffCount ||
    summary.diff?.filter((entry) => entry.status !== "unchanged").length ||
    detail.files.filter((file) => file.status !== "unchanged").length;
  const severityCounts = countSeverities([...findings, ...aiFindings]);
  const findingTotal = Object.values(severityCounts).reduce((sum, count) => sum + (count ?? 0), 0);
  const aiComplete = ai?.status === "complete";

  return (
    <section class="flex flex-col gap-3 border-y border-border py-4">
      <div class="flex flex-wrap items-center gap-2">
        <Badge tone={severityTone(detail.scan.risk)}>{detail.scan.risk}</Badge>
        {/* eslint-disable-next-line no-constant-binary-expression -- AI review intentionally disabled; JSX preserved for paid-tier re-introduction. */}
        {false &&
          (aiComplete ? (
            <>
              <Badge tone={ai!.requiresManualReview ? "medium" : "ok"}>
                {ai!.requiresManualReview ? "manual review" : "no extra review"}
              </Badge>
              <Badge tone="neutral">{ai!.releaseAssessment.replaceAll("_", " ")}</Badge>
            </>
          ) : (
            <Badge tone="neutral">assistant unavailable</Badge>
          ))}
        <Badge tone={findingTotal ? "medium" : "ok"}>
          {findingTotal ? `${findingTotal} ${pluralize("finding", findingTotal)}` : "no findings"}
        </Badge>
      </div>
      <MonoDetail
        parts={[
          detail.scan.status,
          <span key="stage">stage {detail.scan.stageId}</span>,
          <span key="file-count">
            {detail.files.length} {pluralize("file", detail.files.length)}
          </span>,
          <span key="changed">{changed} changed</span>,
          <span key="report-version">
            {summary.report?.version ? `report v${summary.report.version}` : "legacy report"}
          </span>,
        ]}
      />
      {findingTotal ? <SeverityBar counts={severityCounts} class="max-w-[520px]" /> : null}
    </section>
  );
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
    const aRank = SEVERITY_RANK[normalizeSeverityKey(a.severity) ?? "info"] ?? SEVERITY_RANK.info;
    const bRank = SEVERITY_RANK[normalizeSeverityKey(b.severity) ?? "info"] ?? SEVERITY_RANK.info;
    return aRank - bRank;
  });
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
  ai: AiReview | null;
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

      {/* eslint-disable-next-line no-constant-binary-expression -- AI review intentionally disabled; JSX preserved for paid-tier re-introduction. */}
      {false && (
        <ReportSection title="Reviewer notes">
          {ai ? (
            ai!.status === "complete" ? (
              <>
                <div class="flex flex-wrap gap-2">
                  <Badge tone={severityTone(ai!.risk)}>{ai!.risk}</Badge>
                  <Badge tone={ai!.requiresManualReview ? "medium" : "ok"}>
                    {ai!.requiresManualReview ? "manual review" : "no extra review"}
                  </Badge>
                  <Badge tone="neutral">
                    {ai!.releaseAssessment?.replaceAll("_", " ") || "assessment stored"}
                  </Badge>
                </div>
                {ai!.summary ? (
                  <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">{ai!.summary}</p>
                ) : null}
                {ai!.findings?.length ? (
                  <AiFindingList findings={ai!.findings} />
                ) : (
                  <EmptyLine>No assistant findings.</EmptyLine>
                )}
              </>
            ) : (
              <>
                <div class="flex flex-wrap gap-2">
                  <Badge tone="neutral">assistant unavailable</Badge>
                </div>
                {ai!.summary ? (
                  <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">{ai!.summary}</p>
                ) : null}
              </>
            )
          ) : (
            <EmptyLine>No reviewer notes were saved for this review.</EmptyLine>
          )}
        </ReportSection>
      )}

      <ReportSection title="Report fingerprint">
        {summary.report ? (
          <div class="flex flex-col gap-2 text-[13px]">
            <MetadataRow label="version" value={String(summary.report.version ?? "unknown")} />
            <MetadataRow
              label="digest"
              value={`${summary.report.digestAlgorithm || "sha256"}:${summary.report.digest || "missing"}`}
            />
            <MetadataRow
              label="generated"
              value={
                summary.report.generatedAt ? formatDate(summary.report.generatedAt) : "unknown"
              }
            />
            <MetadataRow label="rules" value={`v${summary.report.rulesVersion ?? "unknown"}`} />
          </div>
        ) : (
          <EmptyLine>This older review does not include a report fingerprint.</EmptyLine>
        )}
        {summary.safety ? (
          <details class="group mt-1">
            <summary class="cursor-pointer font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle list-none">
              Safety model
            </summary>
            <pre class="bg-surface-2 rounded-lg p-3 overflow-x-auto text-xs leading-[1.5] mt-3 mb-0">
              {JSON.stringify(summary.safety, null, 2)}
            </pre>
          </details>
        ) : null}
      </ReportSection>
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
    <ul class="list-none p-0 m-0 flex flex-col gap-2">
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
      <div class="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-2">
        <MetadataRow label="package" value={diff.name || "unknown"} />
        <MetadataRow
          label="version"
          value={`${diff.previousVersion || "—"} → ${diff.stagedVersion || "—"}`}
        />
        <MetadataRow
          label="entrypoints"
          value={diff.entrypointsChanged ? "changed" : "unchanged"}
        />
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <ChangeList title="scripts" rows={diff.scripts} />
        <ChangeList title="dependencies" rows={diff.dependencies} />
      </div>
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
              class="grid grid-cols-1 md:grid-cols-[120px_minmax(0,1fr)] gap-2 px-3 py-2 text-[13px]"
            >
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
        <div class="px-3 py-3">
          <EmptyLine>No {title} changes.</EmptyLine>
        </div>
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
