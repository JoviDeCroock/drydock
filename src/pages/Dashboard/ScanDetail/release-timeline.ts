import type { PersistedScanDetail } from "../../../models/scan";
import type { PersistedSummary } from "./types";

type ReleaseTimelineEventKey =
  | "staged"
  | "queued"
  | "started"
  | "completed"
  | "registry_status"
  | "decided"
  | "superseded";

export interface ReleaseTimelineEvent {
  key: ReleaseTimelineEventKey;
  label: string;
  detail: string | null;
  /** Epoch milliseconds. */
  at: number;
}

type TimelineScan = Pick<
  PersistedScanDetail["scan"],
  | "status"
  | "createdAt"
  | "startedAt"
  | "completedAt"
  | "decision"
  | "decidedAt"
  | "decidedByName"
  | "registryVersionStatus"
  | "registryVersionStatusAt"
  | "registryStatusSupersededAt"
>;

// Phrasing follows docs/registry-version-status.md: `staged` is the state a
// maintainer can act on, `validating` is npm still working, and anything npm
// has not documented renders nothing rather than a guess.
const REGISTRY_STATUS_DETAIL: Record<string, string> = {
  validating: "npm is still validating",
  staged: "approvable on npm",
  published: "published on npm",
  blocked: "blocked by npm's validation",
  deleted: "removed from npm",
};

function epoch(value: string | number | Date | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Every dated event the persisted review knows about, oldest first. Events
 * without a timestamp are omitted rather than pinned to "now", so the deltas
 * between rows only ever describe recorded pipeline latency. Ties keep the
 * declared pipeline order (staged, queued, started, completed, ...).
 */
export function buildReleaseTimeline(
  scan: TimelineScan,
  summary: Pick<PersistedSummary, "stagedPublish">,
): ReleaseTimelineEvent[] {
  const superseded = scan.registryStatusSupersededAt != null;
  const stagedAt = summary.stagedPublish?.createdAt;
  const decision =
    scan.decision === "publish"
      ? "publish"
      : scan.decision === "no_publish"
        ? "do not publish"
        : null;
  const registryDetail = superseded
    ? null
    : (REGISTRY_STATUS_DETAIL[scan.registryVersionStatus ?? ""] ?? null);

  const candidates: Array<{
    key: ReleaseTimelineEventKey;
    label: string;
    detail: string | null;
    at: number | null;
  }> = [
    {
      key: "staged",
      label: "Staged on npm",
      detail: null,
      at: epoch(typeof stagedAt === "string" ? stagedAt : null),
    },
    { key: "queued", label: "Review queued", detail: null, at: epoch(scan.createdAt) },
    { key: "started", label: "Review started", detail: null, at: epoch(scan.startedAt) },
    {
      key: "completed",
      // A failed review stamps the same column when it gives up.
      label: scan.status === "failed" ? "Review failed" : "Review completed",
      detail: null,
      at: epoch(scan.completedAt),
    },
    {
      key: "registry_status",
      label: "npm status observed",
      detail: registryDetail,
      at: registryDetail ? epoch(scan.registryVersionStatusAt) : null,
    },
    {
      key: "decided",
      label: "Drydock decision",
      detail: decision
        ? scan.decidedByName
          ? `${decision} · by ${scan.decidedByName}`
          : decision
        : null,
      at: decision ? epoch(scan.decidedAt) : null,
    },
    {
      key: "superseded",
      label: "Superseded",
      detail: "a newer stage owns this release",
      at: epoch(scan.registryStatusSupersededAt),
    },
  ];

  return candidates
    .map((event, order) => ({ event, order }))
    .filter(
      (item): item is { event: typeof item.event & { at: number }; order: number } =>
        item.event.at !== null,
    )
    .sort((a, b) => a.event.at - b.event.at || a.order - b.order)
    .map(({ event }) => ({
      key: event.key,
      label: event.label,
      detail: event.detail,
      at: event.at,
    }));
}

/**
 * Compact elapsed-time caption between two timeline rows: `+42s`, `+12m`,
 * `+3h 05m`, `+2d 4h`. Sub-second gaps read as `+0s` so a row never goes
 * without its delta.
 */
export function formatDelta(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `+${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `+${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return `+${hours}h ${String(rest).padStart(2, "0")}m`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `+${days}d ${restHours}h` : `+${days}d`;
}
