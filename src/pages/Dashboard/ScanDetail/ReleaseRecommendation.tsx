import type { ComponentChildren } from "preact";
import { countSeverities, highestFindingRisk, sortFindingsBySeverity } from "../../../lib/findings";
import { pluralize } from "../../../lib/format";
import { getReleaseRecommendation, type ReleaseRecommendationCopy } from "../recommendation";
import type { DisplayedAiResult } from "../../../../server/lib/ai-review/types";
import type { PersistedScanDetail } from "../../../models/scan";
import { Button } from "../../../components/Button";
import { RELEASE_PROCESS_FINDING_FILE } from "../../../../server/lib/release-fingerprint";
import { Badge, severityTone } from "../../../components/Badge";
import { SeverityBar } from "../../../components/SeverityBar";
import { SectionLabel } from "../../../components/Typography";
import { verdictTextClass } from "../../../features/review/verdict";
import type { FindingWithDiffStatus, ReviewFinding } from "../../../features/review/types";
import type { PersistedSummary } from "./types";

export interface ReleaseVerdict {
  recommendation: ReleaseRecommendationCopy;
  artifactRisk: string;
  releaseRisk: string;
  evidence: Array<{ label: string; value: ComponentChildren }>;
  findingGroups: ReleaseFindingGroup[];
  releaseChanges: string[];
  severityCounts: Record<string, number>;
  findingTotal: number;
  // Whether the evidence says anything beyond "nothing changed and nothing
  // fired". Drives whether the review notes open by default.
  hasSignals: boolean;
}

export function buildReleaseVerdict({
  detail,
  summary,
  diffCount,
  findingsWithDiffStatus,
  usePersistedRiskSummary,
  isWorkflowGate,
}: {
  detail: PersistedScanDetail;
  summary: PersistedSummary;
  diffCount: number;
  findingsWithDiffStatus: FindingWithDiffStatus[];
  usePersistedRiskSummary: boolean;
  isWorkflowGate: boolean;
}): ReleaseVerdict {
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
  const baselineComparisonSkipped = summary.baseline?.comparisonSkipped === "baseline-too-large";
  const recommendation = getReleaseRecommendation(
    artifactRisk,
    releaseRisk,
    releaseFindingCount,
    isWorkflowGate ? "gate" : "npm",
    baselineComparisonSkipped,
  );
  // `detail.findings` and `changedFindings` already include the AI reviewer's
  // findings (persisted as `source: "ai"` rows), so they are counted and shown
  // as evidence from that single source — concatenating `ai.findings` from the
  // review envelope on top would double-count every AI finding.
  const evidence = buildRecommendationEvidence(
    detail,
    summary,
    diffCount,
    changedFindings,
    baselineComparisonSkipped,
  );
  const severityCounts = countSeverities(detail.findings);
  const findingTotal = Object.values(severityCounts).reduce((sum, count) => sum + (count ?? 0), 0);
  const manifest = summary.packageJsonDiff;

  return {
    recommendation,
    artifactRisk,
    releaseRisk,
    evidence,
    findingGroups: groupReleaseFindings(changedFindings),
    releaseChanges: buildReleaseChanges(summary),
    severityCounts,
    findingTotal,
    hasSignals:
      baselineComparisonSkipped ||
      releaseFindingCount > 0 ||
      Boolean(manifest?.scripts.length) ||
      Boolean(manifest?.dependencies.length) ||
      Boolean(manifest?.entrypointsChanged),
  };
}

/**
 * The verdict line the page opens on, above the diff.
 *
 * Deliberately one row: the recommendation, the risk badges that qualify it,
 * the comparison picker, and the decision button. Below `sm` the decision
 * stays beside the verdict and the picker drops to its own full-width row,
 * so the primary action never trails the control it does not depend on. The
 * evidence behind the verdict moves below the workbench into the review notes,
 * because a reviewer reads the diff first and the reasoning second.
 */
export function ReleaseVerdictStrip({
  verdict,
  ai,
  comparison,
  decision,
}: {
  verdict: ReleaseVerdict;
  ai: DisplayedAiResult | null;
  comparison?: ComponentChildren;
  decision?: ComponentChildren;
}) {
  const { recommendation, artifactRisk, releaseRisk } = verdict;
  return (
    <section class="flex flex-wrap items-center gap-x-6 gap-y-3">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2 min-w-0 order-1">
        <h2
          class={`m-0 text-lg font-semibold tracking-[-0.01em] ${verdictTextClass(recommendation.tone)}`}
        >
          {capitalize(recommendation.label)}
        </h2>
        {artifactRisk !== releaseRisk ? (
          <Badge tone="neutral">artifact {artifactRisk}</Badge>
        ) : null}
        {ai?.model != null && ai.kind === "complete" && ai.requiresManualReview ? (
          <Badge tone="medium">manual review</Badge>
        ) : null}
        {/* The model reports the assessment and the manual-review flag
            independently, so a suspicious assessment without the flag must
            still surface here; only the clean reading stays quiet. */}
        {ai?.model != null &&
        ai.kind === "complete" &&
        ai.releaseAssessment !== "nothing_unusual" ? (
          <Badge tone="neutral">{ai.releaseAssessment.replaceAll("_", " ")}</Badge>
        ) : null}
        {ai?.model != null && ai.kind === "unavailable" ? (
          <Badge tone="neutral">assistant unavailable</Badge>
        ) : null}
      </div>
      {comparison ? (
        <div class="order-3 basis-full sm:order-2 sm:basis-auto sm:ml-auto">{comparison}</div>
      ) : null}
      {decision ? <div class="order-2 ml-auto sm:order-3 sm:ml-0">{decision}</div> : null}
    </section>
  );
}

/** Why the verdict reads the way it does. Lives in the review notes group. */
export function ReleaseVerdictEvidence({
  verdict,
  onSelectFinding,
  onInspectFindings,
  consistencyNote,
  canInspectFinding,
}: {
  verdict: ReleaseVerdict;
  onSelectFinding?: (finding: ReviewFinding) => void;
  onInspectFindings?: () => void;
  consistencyNote?: ComponentChildren;
  canInspectFinding?: (finding: ReviewFinding) => boolean;
}) {
  const { recommendation, evidence, findingGroups, severityCounts, findingTotal } = verdict;
  const firstFinding = findingGroups[0]?.findings[0];
  const inspect =
    firstFinding &&
    canSelectFinding(firstFinding) &&
    (canInspectFinding?.(firstFinding) ?? true) &&
    onSelectFinding
      ? () => onSelectFinding(firstFinding)
      : onInspectFindings;
  return (
    <section class="flex flex-col gap-4">
      <SectionLabel as="h3">Why this verdict</SectionLabel>
      <div class="flex flex-wrap items-start gap-x-6 gap-y-3">
        {recommendation.copy ? (
          <p class="m-0 max-w-[680px] text-[14px] leading-[1.55] text-ink">{recommendation.copy}</p>
        ) : null}
        {firstFinding && inspect ? (
          <Button variant="secondary" size="sm" onClick={inspect}>
            Inspect {firstFinding.severity} findings
          </Button>
        ) : null}
      </div>
      {evidence.length ? (
        <ul class="list-none p-0 m-0 flex flex-col gap-2 max-w-[680px]">
          {evidence.map((item, index) => (
            <li key={`${item.label}-${index}`} class="text-[13px] leading-[1.55] text-ink-muted">
              {item.value}
            </li>
          ))}
        </ul>
      ) : null}
      {findingGroups.length ? (
        <ul class="list-none p-0 m-0 divide-y divide-border">
          {findingGroups.map((group) => (
            <ReleaseFindingGroupRow
              key={group.key}
              group={group}
              onSelectFinding={onSelectFinding}
              canInspectFinding={canInspectFinding}
            />
          ))}
        </ul>
      ) : null}
      {findingTotal ? <SeverityBar counts={severityCounts} class="max-w-[520px]" /> : null}
      {consistencyNote ? <div class="max-w-[680px]">{consistencyNote}</div> : null}
    </section>
  );
}

interface ReleaseFindingGroup {
  key: string;
  findings: ReviewFinding[];
}

export function groupReleaseFindings(findings: ReviewFinding[]): ReleaseFindingGroup[] {
  const groups = new Map<string, ReleaseFindingGroup>();
  for (const finding of sortFindingsBySeverity(findings)) {
    // A shared rule identity does not make AI evidence deterministic, or make
    // occurrences with different severity equivalent. Unknown rules stay separate.
    const key = JSON.stringify(
      finding.ruleId ? [finding.ruleId, finding.severity, finding.source] : [null, finding.id],
    );
    const group = groups.get(key);
    if (group) group.findings.push(finding);
    else groups.set(key, { key, findings: [finding] });
  }
  return [...groups.values()];
}

function canSelectFinding(finding: ReviewFinding): boolean {
  return finding.source !== "ai" && finding.file !== RELEASE_PROCESS_FINDING_FILE;
}

function ReleaseFindingGroupRow({
  group,
  onSelectFinding,
  canInspectFinding,
}: {
  group: ReleaseFindingGroup;
  onSelectFinding?: (finding: ReviewFinding) => void;
  canInspectFinding?: (finding: ReviewFinding) => boolean;
}) {
  const first = group.findings[0];
  const title = first.ruleId
    ? capitalize(
        first.ruleId
          .replace(/^(?:code|file)\./, "")
          .replaceAll(".", " ")
          .replaceAll("-", " "),
      )
    : "Finding";
  const sharedReason = group.findings.every((finding) => finding.reason === first.reason);
  return (
    <li class="py-3 first:pt-0 last:pb-0 min-w-0">
      <details class="group">
        <summary class="cursor-pointer text-[13px] text-ink marker:text-ink-subtle">
          <span class="inline-flex flex-wrap items-center gap-x-2 gap-y-1 align-middle">
            <Badge tone={severityTone(first.severity)}>{first.severity}</Badge>
            <span class="font-medium">{title}</span>
            <span class="text-ink-muted">
              · {group.findings.length} {pluralize("location", group.findings.length)}
            </span>
            {first.source === "ai" ? <Badge tone="neutral">AI · advisory</Badge> : null}
          </span>
        </summary>
        <div class="pt-3 pl-4 flex flex-col gap-3">
          {first.ruleId ? (
            <code class="text-[11px] text-ink-subtle break-all">{first.ruleId}</code>
          ) : null}
          <ul class="list-none p-0 m-0 flex flex-col gap-3">
            {group.findings.map((finding) => (
              <li key={finding.id} class="flex flex-col gap-1 min-w-0">
                {onSelectFinding &&
                canSelectFinding(finding) &&
                (canInspectFinding?.(finding) ?? true) ? (
                  <button
                    type="button"
                    onClick={() => onSelectFinding(finding)}
                    class="text-left font-mono text-[13px] text-accent hover:underline break-all cursor-pointer bg-transparent border-0 p-0"
                    title={`Inspect ${finding.file}${finding.line ? ` at line ${finding.line}` : ""}`}
                  >
                    {finding.file}
                    {finding.line ? `:${finding.line}` : ""}
                  </button>
                ) : (
                  <code class="text-[13px] text-ink-muted break-all">
                    {finding.file}
                    {finding.line ? `:${finding.line}` : ""}
                  </code>
                )}
                {!sharedReason ? (
                  <p class="m-0 max-w-[680px] text-[13px] leading-[1.55] text-ink-muted">
                    {finding.reason}
                  </p>
                ) : null}
                <p class="m-0 max-w-[680px] text-[12px] leading-[1.55] text-ink-muted break-words">
                  {finding.evidence}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </details>
      {sharedReason ? (
        <p class="m-0 mt-2 max-w-[680px] text-[13px] leading-[1.55] text-ink-muted">
          {first.reason}
        </p>
      ) : null}
    </li>
  );
}

export function ReleaseChangesSummary({
  verdict,
  onInspectChanges,
}: {
  verdict: ReleaseVerdict;
  onInspectChanges?: () => void;
}) {
  if (!verdict.releaseChanges.length) return null;
  return (
    <section class="flex flex-col gap-2">
      <SectionLabel as="h3">Release changes</SectionLabel>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <p class="m-0 text-ink-muted">{verdict.releaseChanges.join(" · ")}</p>
        {onInspectChanges ? (
          <button
            type="button"
            onClick={onInspectChanges}
            class="p-0 border-0 bg-transparent text-accent hover:underline cursor-pointer"
          >
            View manifest changes
          </button>
        ) : null}
      </div>
    </section>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// The verdict heading carries severity meaning, so it uses the `-text` severity
// variants (text role), never the saturated tokens. Neutral verdicts stay --ink.

function buildRecommendationEvidence(
  detail: PersistedScanDetail,
  summary: PersistedSummary,
  diffCount: number,
  changedFindings: ReviewFinding[],
  baselineComparisonSkipped: boolean,
): Array<{ label: string; value: ComponentChildren }> {
  const evidence: Array<{ label: string; value: ComponentChildren }> = [];
  // Lead with the missing comparison: it explains why there are no release
  // deltas below, which would otherwise read as an all-clear.
  if (baselineComparisonSkipped) {
    const version = summary.baseline?.version;
    evidence.push({
      label: "baseline",
      value: version
        ? `Published ${version} exceeded the download budget, so no file was compared against it.`
        : "The published release exceeded the download budget, so no file was compared against it.",
    });
  }
  if (evidence.length === 0 && changedFindings.length === 0) {
    const changed =
      diffCount ||
      summary.diff?.filter((entry) => entry.status !== "unchanged").length ||
      detail.files.filter((file) => file.status !== "unchanged").length;
    evidence.push({
      label: "evidence",
      value: `${changed} changed ${pluralize("file", changed)}; no findings in this release delta.${detail.findings.length ? " Package findings remain below." : ""}`,
    });
  }

  return evidence;
}

function buildReleaseChanges(summary: PersistedSummary): string[] {
  const changes: string[] = [];
  const manifest = summary.packageJsonDiff;
  if (manifest?.scripts.length)
    changes.push(
      `${manifest.scripts.length} lifecycle or package script ${pluralize("change", manifest.scripts.length)}`,
    );
  if (manifest?.dependencies.length)
    changes.push(
      `${manifest.dependencies.length} dependency ${pluralize("change", manifest.dependencies.length)}`,
    );
  if (manifest?.entrypointsChanged) changes.push("Package entrypoints changed");
  return changes;
}
