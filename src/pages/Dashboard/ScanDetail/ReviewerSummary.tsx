import type {
  AiDeterministicAssessment,
  DisplayedAiResult,
} from "../../../../server/lib/ai-review/types";
import { Badge } from "../../../components/Badge";
import { MonoLabel, SectionLabel } from "../../../components/Typography";
import { compareSeverity, sortFindingsBySeverity } from "../../../lib/findings";
import { pluralize } from "../../../lib/format";
import type { ReviewFinding } from "../../../features/review/types";

const REVIEWER_ASIDE = "advisory";

export function reviewerSummaryVisible(ai: DisplayedAiResult | null): boolean {
  return Boolean(ai && ai.model != null);
}

/**
 * Whether the assistant's reading is worth opening the review notes for. It
 * runs by default, so its mere presence cannot be the trigger: a clean
 * "nothing unusual" reading stays folded, one that flags the release opens,
 * and so does an attempted review that could not complete — that floors the
 * scan's risk at medium, and the notes are where the page says why.
 */
export function assistantFlagsRelease(ai: DisplayedAiResult | null): boolean {
  if (!ai || !reviewerSummaryVisible(ai)) return false;
  if (ai.kind === "unavailable") return true;
  return ai.requiresManualReview || ai.releaseAssessment !== "nothing_unusual";
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

const VERDICT_LABELS: Record<AiDeterministicAssessment["verdict"], string> = {
  confirmed: "Confirmed",
  disputed: "Disputed",
};

/**
 * The reviewer's notes that name a deterministic finding this scan actually
 * reported (same rule id and file). A note about a rule that never fired would
 * read as the scanner's own finding being disputed, so it is dropped.
 */
export function matchedDeterministicAssessments(
  assessments: AiDeterministicAssessment[],
  findings: ReviewFinding[],
): AiDeterministicAssessment[] {
  const reported = new Set(
    findings
      .filter((finding) => finding.source === "rule" && finding.ruleId)
      .map((finding) => `${finding.ruleId}\u0000${finding.file}`),
  );
  return assessments.filter((assessment) =>
    reported.has(`${assessment.ruleId}\u0000${assessment.file}`),
  );
}

// Every field is model output that may quote hostile package text, so each one
// renders as a plain text child: no markup parsing, and no link built from the
// file path.
function DeterministicAssessmentNotes({
  assessments,
}: {
  assessments: AiDeterministicAssessment[];
}) {
  if (assessments.length === 0) return null;
  return (
    <div class="flex flex-col gap-2 min-w-0 max-w-[680px]">
      <MonoLabel as="p">AI notes on deterministic findings</MonoLabel>
      <p class="m-0 text-[12px] leading-[1.5] text-ink-muted">
        These notes do not change any finding or the release risk.
      </p>
      <ul class="list-none p-0 m-0 flex flex-col gap-3">
        {assessments.map((assessment, index) => (
          <li
            key={`${index}:${assessment.ruleId}:${assessment.file}`}
            class="flex flex-col gap-1 min-w-0"
          >
            <p class="m-0 text-[13px] text-ink break-words">
              <span class="font-medium">{VERDICT_LABELS[assessment.verdict]}</span>
              <span class="text-ink-subtle"> · </span>
              <code class="text-[12px] text-ink-muted break-all">
                {assessment.ruleId} · {assessment.file}
              </code>
            </p>
            <p class="m-0 text-[13px] leading-[1.55] text-ink-muted whitespace-pre-wrap break-words">
              {assessment.note}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
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
      {ai.kind === "complete" ? (
        <DeterministicAssessmentNotes
          assessments={matchedDeterministicAssessments(ai.deterministicAssessments, findings)}
        />
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
