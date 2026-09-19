import type { DisplayedAiResult } from "../../../../server/lib/ai-review/types";
import { Badge } from "../../../components/Badge";
import { SectionLabel } from "../../../components/Typography";
import { compareSeverity, sortFindingsBySeverity } from "../../../lib/findings";
import { pluralize } from "../../../lib/format";
import type { ReviewFinding } from "../../../features/review/types";

const REVIEWER_ASIDE = "advisory";

export function reviewerSummaryVisible(ai: DisplayedAiResult | null): boolean {
  return Boolean(ai && ai.model != null);
}

const ASSESSMENT_LABELS = {
  nothing_unusual: "AI reports nothing unusual",
  review_recommended: "AI recommends further review",
  suspicious: "AI reports suspicious behavior",
  blocked: "AI recommends blocking this release",
};

export function deterministicAssessmentNote(
  ai: DisplayedAiResult,
  findings: ReviewFinding[],
): string | null {
  const highest = sortFindingsBySeverity(
    findings.filter((finding) => finding.source === "rule"),
  )[0];
  if (!highest) return null;
  const disagrees =
    ai.kind === "complete" &&
    (ai.releaseAssessment === "nothing_unusual" || compareSeverity(ai.risk, highest.severity) > 0);
  return disagrees
    ? `The AI assessment does not clear the deterministic findings. Their highest severity remains ${highest.severity}.`
    : `Deterministic findings retain their severity (${highest.severity} at highest). AI advice does not override them.`;
}

export function ReviewerSummary({
  ai,
  findings = [],
  onInspectFindings,
}: {
  ai: DisplayedAiResult | null;
  findings?: ReviewFinding[];
  onInspectFindings?: () => void;
}) {
  if (!reviewerSummaryVisible(ai) || !ai) return null;
  const deterministicNote = deterministicAssessmentNote(ai, findings);

  return (
    <section class="flex flex-col gap-3" aria-label="AI assessment">
      <SectionLabel as="h3" aside={REVIEWER_ASIDE}>
        AI assessment
      </SectionLabel>
      <p class="m-0 text-[12px] text-ink-muted">May quote package text.</p>
      <div class="flex flex-wrap items-center gap-2">
        <p class="m-0 text-[14px] font-medium text-ink">
          {ai.kind === "complete"
            ? ASSESSMENT_LABELS[ai.releaseAssessment]
            : "AI assessment unavailable"}
        </p>
        {ai.kind === "complete" && ai.requiresManualReview ? (
          <Badge tone="medium">manual review requested</Badge>
        ) : null}
      </div>
      {ai.kind === "complete" ? (
        <p class="m-0 text-[13px] text-ink-muted">
          AI risk: {ai.risk} · {ai.findings.length} AI {pluralize("finding", ai.findings.length)}
        </p>
      ) : (
        <p class="m-0 text-[13px] text-ink-muted">
          The AI review did not complete. Inspect the release evidence before deciding.
        </p>
      )}
      {deterministicNote ? (
        <div class="border-l-2 border-border-strong pl-3 max-w-[680px]">
          <p class="m-0 text-[13px] leading-[1.55] text-ink">{deterministicNote}</p>
          {onInspectFindings ? (
            <button
              type="button"
              onClick={onInspectFindings}
              class="mt-1 p-0 border-0 bg-transparent text-[13px] text-accent hover:underline cursor-pointer"
            >
              Inspect deterministic findings
            </button>
          ) : null}
        </div>
      ) : null}
      {ai.summary ? (
        <details>
          <summary class="cursor-pointer text-[13px] text-ink-muted hover:text-ink">
            Read full AI assessment
          </summary>
          {/* Model prose can quote hostile package text; it stays inert and is
              never parsed into a product verdict or a false-positive claim. */}
          <p class="m-0 mt-3 text-[13px] leading-[1.6] text-ink-muted max-w-[680px] whitespace-pre-wrap break-words">
            {ai.summary}
          </p>
        </details>
      ) : null}
    </section>
  );
}
