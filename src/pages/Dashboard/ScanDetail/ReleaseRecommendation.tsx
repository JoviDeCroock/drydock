import type { ComponentChildren } from "preact";
import { countSeverities, highestFindingRisk, sortFindingsBySeverity } from "../../../lib/findings";
import { pluralize } from "../../../lib/format";
import { getReleaseRecommendation } from "../recommendation";
import type { DisplayedAiResult } from "../../../../server/lib/ai-review-types";
import type { PersistedScanDetail } from "../../../models/scan";
import { Badge } from "../../../components/Badge";
import { Card } from "../../../components/Card";
import { SeverityBar } from "../../../components/SeverityBar";
import { SectionLabel } from "../../../components/Typography";
import type { FindingWithDiffStatus, PersistedFinding, PersistedSummary } from "./types";

export function ReleaseRecommendation({
  detail,
  summary,
  ai,
  diffCount,
  findingsWithDiffStatus,
  usePersistedRiskSummary,
  isWorkflowGate,
}: {
  detail: PersistedScanDetail;
  summary: PersistedSummary;
  ai: DisplayedAiResult | null;
  diffCount: number;
  findingsWithDiffStatus: FindingWithDiffStatus[];
  usePersistedRiskSummary: boolean;
  isWorkflowGate: boolean;
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

  // The recommendation is the report's verdict, so it gets the only elevated
  // (carded) section among the supplementary bare sections below it, plus a
  // headline-scale verdict in the matching severity text color. Elevation +
  // scale make it out-rank Risk signals / Manifest / Reviewer notes, which all
  // share the flat SectionLabel altitude.
  return (
    <Card class="p-5 sm:p-6 flex flex-col gap-4">
      <div class="flex flex-col gap-2">
        <SectionLabel as="h2">Recommendation</SectionLabel>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h3
            class={`m-0 text-lg font-semibold tracking-[-0.01em] ${verdictColor(recommendation.tone)}`}
          >
            {capitalize(recommendation.label)}
          </h3>
          <div class="flex flex-wrap items-center gap-2">
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
        </div>
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
            <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
              {item.label}
            </span>
            <span class="min-w-0 text-ink-muted">{item.value}</span>
          </li>
        ))}
      </ul>
      {findingTotal ? <SeverityBar counts={severityCounts} class="max-w-[520px]" /> : null}
    </Card>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// The verdict heading carries severity meaning, so it uses the `-text` severity
// variants (text role), never the saturated tokens. Neutral verdicts stay --ink.
function verdictColor(tone: string): string {
  if (tone === "critical" || tone === "high") return "text-danger-text";
  if (tone === "medium") return "text-warn-text";
  if (tone === "ok") return "text-ok-text";
  return "text-ink";
}

function buildRecommendationEvidence(
  detail: PersistedScanDetail,
  summary: PersistedSummary,
  diffCount: number,
  changedFindings: PersistedFinding[],
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
  const releaseFindings: RecommendationFinding[] = changedFindings;
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

type RecommendationFinding = {
  severity?: string;
  file: string;
  reason: string;
};
