import type { DisplayedAiResult } from "../../../../server/lib/ai-review/types";
import { SectionLabel } from "../../../components/Typography";

const REVIEWER_ASIDE = "advisory · may quote package text";

export function reviewerSummaryVisible(ai: DisplayedAiResult | null): boolean {
  return Boolean(ai && ai.model != null);
}

export function ReviewerSummary({ ai }: { ai: DisplayedAiResult | null }) {
  if (!reviewerSummaryVisible(ai) || !ai) return null;

  return (
    <section class="flex flex-col gap-2" aria-label="Reviewer summary">
      {/* The summary is model-authored prose shaped by hostile package input,
          rendered under a label that reads as authority. Say what it is where
          the eye lands, so a maintainer weighs it as a reviewer's note rather
          than a verdict and does not act on instructions it may have echoed. */}
      <SectionLabel as="h2" aside={REVIEWER_ASIDE}>
        Reviewer
      </SectionLabel>
      {ai.summary ? (
        <p class="m-0 text-[13px] leading-[1.6] text-ink-muted max-w-[720px]">{ai.summary}</p>
      ) : null}
    </section>
  );
}
