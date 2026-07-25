import {
  normalizeReleaseConsistency,
  type ReleaseConsistency,
} from "../../../../server/lib/scan/release-memory";
import { formatDateTime, pluralize } from "../../../lib/format";
import { Alert } from "../../../components/Alert";

// Advisory release-memory notice, rendered directly under the Recommendation.
// match/subset: a prominent positive banner — the maintainer already reviewed
// and published a release with this exact finding profile, so the same
// capability findings are not news. diverged: a quiet one-liner pointing at the
// count of genuinely new findings. It never changes risk and renders nothing
// when there is no approved prior scan (or the scan predates the field).
//
// An empty profile (zero deterministic findings) gets its own wording instead
// of "finding profile matches": a vacuous match must not read as reassurance
// about anything beyond deterministic checks — the diff and AI review still
// carry release-specific signal.
export type ReleaseConsistencyVariant = "match" | "subset" | "empty" | "diverged";

export function releaseConsistencyVariant(
  consistency: ReleaseConsistency,
): ReleaseConsistencyVariant | null {
  if (consistency.status === "none") return null;
  if (consistency.status === "diverged") return "diverged";
  return consistency.currentFindingCount === 0 ? "empty" : consistency.status;
}

export function ReleaseConsistencyNotice({ value }: { value: unknown }) {
  const consistency = normalizeReleaseConsistency(value);
  if (!consistency) return null;
  const variant = releaseConsistencyVariant(consistency);
  if (!variant) return null;

  if (variant === "diverged") {
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
  if (variant === "empty") {
    return (
      <Alert tone="ok">
        No deterministic findings —{" "}
        {consistency.priorFindingCount === 0 ? (
          <>
            none in {priorScanLink(consistency)} either{approvedOn}
          </>
        ) : (
          <>
            down from {consistency.priorFindingCount} in {priorScanLink(consistency)}
            {approvedOn}
          </>
        )}
        . Only deterministic checks are compared; the diff and AI review are specific to this
        release.
      </Alert>
    );
  }
  return (
    <Alert tone="ok">
      {variant === "match" ? (
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
