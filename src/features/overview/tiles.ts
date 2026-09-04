/**
 * What each overview tile says, derived from the aggregate. Kept apart from the
 * component so the copy and the number formatting can be pinned in tests.
 */
import { pluralize } from "../../lib/format";
import type { ScanDecisionFilter } from "../../models/scan";
import type { ScanOverview } from "../../models/scan-overview";

export interface OverviewTile {
  id: "waiting" | "validating" | "published" | "decided";
  label: string;
  value: string;
  detail: string;
  filter: ScanDecisionFilter;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Compact mono duration: `<1m`, `42m`, `3h`, `5d`. */
export function formatCompactDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < MINUTE_MS) return "<1m";
  if (clamped < HOUR_MS) return `${Math.floor(clamped / MINUTE_MS)}m`;
  if (clamped < 2 * DAY_MS) return `${Math.floor(clamped / HOUR_MS)}h`;
  return `${Math.floor(clamped / DAY_MS)}d`;
}

export function overviewTiles(overview: ScanOverview, now: number): OverviewTile[] {
  const { waiting, validating, publishedWithoutDecision, decided, windowDays } = overview;
  const oldestWaiting = waiting.oldestCompletedAt ? Date.parse(waiting.oldestCompletedAt) : null;
  return [
    {
      id: "waiting",
      label: "Waiting on you",
      value: String(waiting.count),
      detail:
        waiting.count === 0
          ? "nothing to decide"
          : `oldest ${formatCompactDuration(now - (oldestWaiting ?? now))} · decide before approving`,
      filter: "undecided",
    },
    {
      id: "validating",
      label: "npm still scanning",
      value: String(validating.count),
      detail:
        validating.count === 0
          ? "nothing in npm validation"
          : `${validating.reviewReady} of ${validating.count} Drydock ${pluralize("review", validating.count)} ready first`,
      filter: "undecided",
    },
    {
      id: "published",
      label: "Published, no decision",
      value: String(publishedWithoutDecision.count),
      detail:
        publishedWithoutDecision.count === 0
          ? `none in ${windowDays}d`
          : `went live unreviewed · ${windowDays}d`,
      filter: "published_without_decision",
    },
    {
      id: "decided",
      label: `Decided · ${windowDays}d`,
      value: String(decided.count),
      detail:
        decided.count === 0
          ? "no decisions yet"
          : `${decided.approved} approved · ${decided.rejected} rejected${
              decided.medianDecisionMs === null
                ? ""
                : ` · median ${formatCompactDuration(decided.medianDecisionMs)}`
            }`,
      filter: "all",
    },
  ];
}

export function overviewTileHref(filter: ScanDecisionFilter): string {
  return filter === "undecided" ? "/dashboard" : `/dashboard?filter=${filter}`;
}
