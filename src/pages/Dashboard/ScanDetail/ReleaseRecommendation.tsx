import type { ComponentChildren } from "preact";
import { countSeverities, highestFindingRisk, sortFindingsBySeverity } from "../../../lib/findings";
import { pluralize } from "../../../lib/format";
import { getReleaseRecommendation } from "../recommendation";
import type { AiFinding, DisplayedAiResult } from "../../../../server/lib/ai-review-types";
import type { PersistedScanDetail } from "../../../models/scan";
import { Badge, SectionLabel, SeverityBar } from "../../../components";
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
  const aiFindings: AiFinding[] = ai?.kind === "complete" ? ai.findings : [];
  const recommendation = getReleaseRecommendation(
    artifactRisk,
    releaseRisk,
    releaseFindingCount,
    isWorkflowGate ? "gate" : "npm",
  );
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
