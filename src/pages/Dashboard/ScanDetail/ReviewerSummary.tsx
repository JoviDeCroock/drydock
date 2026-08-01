import type { DisplayedAiResult } from "../../../../server/lib/ai-review/types";
import { LoadingLine, SectionLabel } from "../../../components/Typography";

// The reviewer's narrative verdict, directly under the Recommendation.
//
// This used to render at the very bottom of the page as "Reviewer notes", below
// the diff, the risk signals, the manifest diff, and provenance. It is the one
// part of the report that answers "what is this release?" in a sentence — "a
// routine patch that moves a user-agent check earlier so a timer isn't
// scheduled unnecessarily" — which is the question a maintainer opens the page
// with. Reading order now goes: should I publish (recommendation) → what is
// this (here) → have I seen these findings before (consistency) → the diff.
//
// Findings are deliberately not rendered here. They persist as scan_findings
// rows and appear once, as assistant-badged cards in Risk signals, so a finding
// is never shown twice on the page.
/**
 * A null model means the reviewer is switched off for this organization — there
 * is nothing to report. A non-null model with a non-complete result means it was
 * attempted and failed, which is load-bearing and must stay visible:
 * `computeScanRisk` floors that scan at medium so a crashed reviewer cannot read
 * as clean, and the page has to say why.
 *
 * Exported so the move out of `ReportSections` is provably behaviour-preserving
 * — this is the same predicate that section used.
 */
export function reviewerSummaryVisible(ai: DisplayedAiResult | null): boolean {
  // A pending review has no model yet — it has not picked one — but the reader
  // still has to be told the advisory pass is on its way, otherwise a report
  // whose reviewer section appears minutes later looks like it changed itself.
  return Boolean(ai && (ai.model != null || ai.kind === "pending"));
}

export function ReviewerSummary({
  ai,
  polling = true,
}: {
  ai: DisplayedAiResult | null;
  /** False once the page has stopped checking for a review that never landed. */
  polling?: boolean;
}) {
  if (!reviewerSummaryVisible(ai) || !ai) return null;

  return (
    <section class="flex flex-col gap-2" aria-label="Reviewer summary">
      {/* No badges here. The Recommendation card immediately above already
          renders the manual-review, release-assessment, and
          assistant-unavailable badges under the identical `ai.model != null`
          gate; repeating them one card-gap later just prints "no extra review"
          twice. The narrative is the part that was missing from the top of the
          page, so the narrative is all this adds. */}
      <SectionLabel as="h2">Reviewer</SectionLabel>
      {ai.kind === "pending" ? (
        polling ? (
          <LoadingLine size="inline">Assistant review running</LoadingLine>
        ) : (
          // Nothing is watching for it any more, so the pulsing line would be a
          // promise the page cannot keep. Reload picks it up if it did land.
          <p class="m-0 font-mono text-[12px] text-ink-subtle">
            Assistant review has not reported back. Reload to check again.
          </p>
        )
      ) : null}
      {ai.summary ? (
        <p class="m-0 text-[13px] leading-[1.6] text-ink-muted max-w-[720px]">{ai.summary}</p>
      ) : null}
    </section>
  );
}
