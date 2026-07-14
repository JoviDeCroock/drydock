import {
  normalizeReleaseConsistency,
  type ReleaseConsistency,
} from "../../../../server/lib/release-memory";
import { formatDateTime, pluralize } from "../../../lib/format";
import { Alert } from "../../../components/Alert";

// Advisory release-memory notice, rendered directly under the Recommendation.
// match/subset: a prominent positive banner — the maintainer already reviewed
// and published a release with this exact finding profile, so the same
// capability findings are not news. diverged: a quiet one-liner pointing at the
// count of genuinely new findings. It never changes risk and renders nothing
// when there is no approved prior scan (or the scan predates the field).
export function ReleaseConsistencyNotice({ value }: { value: unknown }) {
  const consistency = normalizeReleaseConsistency(value);
  if (!consistency || consistency.status === "none") return null;

  if (consistency.status === "diverged") {
    const count = consistency.newFindingCount;
    return (
      <p class="m-0 text-[13px] text-ink-muted">
        {count} {pluralize("finding", count)} {count === 1 ? "is" : "are"} new since the last
        approved release
        {consistency.priorVersion || consistency.priorScanId ? (
          <> ({priorScanLink(consistency)})</>
        ) : null}
        .
      </p>
    );
  }

  const approvedOn = consistency.decidedAt
    ? `, approved on ${formatDateTime(consistency.decidedAt)}`
    : "";
  return (
    <Alert tone="ok">
      {consistency.status === "match" ? (
        <>
          Finding profile matches {priorScanLink(consistency)}
          {approvedOn}. The same deterministic findings were already reviewed and published.
        </>
      ) : (
        <>
          No new findings since {priorScanLink(consistency)}
          {approvedOn}. Every current finding was already reviewed and published.
        </>
      )}
    </Alert>
  );
}

function priorScanLink(consistency: ReleaseConsistency) {
  const label = consistency.priorVersion
    ? `v${consistency.priorVersion}`
    : "the last approved release";
  if (!consistency.priorScanId) return <>{label}</>;
  return (
    <a href={`/dashboard/scans/${encodeURIComponent(consistency.priorScanId)}`} class="underline">
      {label}
    </a>
  );
}
