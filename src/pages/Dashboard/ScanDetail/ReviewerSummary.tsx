import type { DisplayedAiResult } from "../../../../server/lib/ai-review/types";
import { SectionLabel } from "../../../components/Typography";

export function reviewerSummaryVisible(ai: DisplayedAiResult | null): boolean {
  return Boolean(ai && ai.model != null);
}

export function ReviewerSummary({ ai }: { ai: DisplayedAiResult | null }) {
  if (!reviewerSummaryVisible(ai) || !ai) return null;

  return (
    <section class="flex flex-col gap-2" aria-label="Reviewer summary">
      <SectionLabel as="h2">Reviewer</SectionLabel>
      {ai.summary ? (
        <p class="m-0 text-[13px] leading-[1.6] text-ink-muted max-w-[720px]">{ai.summary}</p>
      ) : null}
    </section>
  );
}
