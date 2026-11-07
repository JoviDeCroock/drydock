import { Badge } from "../../components/Badge";
import type { DependencyReview } from "../../models/dependency-review";
import { reviewState } from "./wording";

/**
 * A review's state. Only the states that ask something of the reader (held
 * updates, a failed review) are Badges; the expected endings are plain text.
 */
export function ReviewStateMark({
  review,
}: {
  review: Pick<DependencyReview, "status" | "conclusion" | "heldCount">;
}) {
  const state = reviewState(review);
  if (state === "held") {
    return (
      <Badge tone="medium">{review.heldCount > 0 ? `${review.heldCount} held` : "held"}</Badge>
    );
  }
  if (state === "failed") return <Badge tone="critical">failed</Badge>;
  return (
    <span class="font-mono text-[12px] text-ink-muted whitespace-nowrap">
      {state === "reviewing" ? "reviewing…" : state}
    </span>
  );
}
