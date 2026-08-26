import type { DisplayedAiResult } from "../../../../server/lib/ai-review/types";
import { SectionLabel } from "../../../components/Typography";

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
// Findings are deliberately not rendered here. They come from the scan's report
// artifact and appear once, as assistant-badged cards in Risk signals, so a
// finding is never shown twice on the page.
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
  return Boolean(ai && ai.model != null);
}

export function ReviewerSummary({ ai }: { ai: DisplayedAiResult | null }) {
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
      {ai.summary ? (
        <p class="m-0 text-[13px] leading-[1.6] text-ink-muted max-w-[720px]">{ai.summary}</p>
      ) : null}
    </section>
  );
}
