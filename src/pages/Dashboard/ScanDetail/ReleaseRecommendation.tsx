import type { ComponentChildren } from "preact";
import { countSeverities, highestFindingRisk, sortFindingsBySeverity } from "../../../lib/findings";
import { pluralize } from "../../../lib/format";
import { getReleaseRecommendation, type ReleaseRecommendationCopy } from "../recommendation";
import type { DisplayedAiResult } from "../../../../server/lib/ai-review/types";
import type { PersistedScanDetail } from "../../../models/scan";
import { Badge } from "../../../components/Badge";
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
 * and — through `actions` — the version picker and the decision button. The
 * evidence behind the verdict moves below the workbench into the review notes,
 * because a reviewer reads the diff first and the reasoning second.
 */
export function ReleaseVerdictStrip({
  verdict,
  ai,
  actions,
}: {
  verdict: ReleaseVerdict;
  ai: DisplayedAiResult | null;
  actions?: ComponentChildren;
}) {
  const { recommendation, artifactRisk, releaseRisk } = verdict;
  return (
    <section class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2 min-w-0">
        <h2
          class={`m-0 text-lg font-semibold tracking-[-0.01em] ${verdictTextClass(recommendation.tone)}`}
        >
          {capitalize(recommendation.label)}
        </h2>
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
      {actions ? <div class="flex flex-wrap items-center gap-3">{actions}</div> : null}
    </section>
  );
}

/** Why the verdict reads the way it does. Lives in the review notes group. */
export function ReleaseVerdictEvidence({ verdict }: { verdict: ReleaseVerdict }) {
  const { recommendation, evidence, severityCounts, findingTotal } = verdict;
  return (
    <section class="flex flex-col gap-3">
      <SectionLabel as="h3">Why this verdict</SectionLabel>
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
            <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
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
  const releaseFindings = changedFindings;
  if (releaseFindings.length) {
    const topFindings = sortFindingsBySeverity(releaseFindings).slice(0, 3);
    for (const finding of topFindings) {
      evidence.push({
        label: finding.severity ?? "signal",
        value: (
          <>
            <code>{finding.file}</code>: {finding.reason}
          </>
        ),
      });
    }
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
