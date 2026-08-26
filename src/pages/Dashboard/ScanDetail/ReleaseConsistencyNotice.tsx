import {
  normalizeReleaseConsistency,
  type ReleaseConsistency,
} from "../../../../server/lib/scan/release-memory";
import { formatDateTime, pluralize } from "../../../lib/format";
import { Alert } from "../../../components/Alert";

export type ReleaseConsistencyVariant = "match" | "subset" | "empty" | "diverged";

export function releaseConsistencyVariant(
  consistency: ReleaseConsistency,
): ReleaseConsistencyVariant | null {
  if (consistency.status === "none") return null;
  if (consistency.status === "diverged") return "diverged";
  return consistency.currentFindingCount === 0 ? "empty" : consistency.status;
}

export function ReleaseConsistencyNotice({
  value,
  approvedContextCount = 0,
}: {
  value: unknown;
  approvedContextCount?: number;
}) {
  const consistency = normalizeReleaseConsistency(value);
  if (!consistency) return null;
  const variant = releaseConsistencyVariant(consistency);
  if (!variant) return null;
  const scoringNote =
    approvedContextCount > 0 ? (
      <>
        {" "}
        {approvedContextCount} package-context {pluralize("finding", approvedContextCount)}{" "}
        {approvedContextCount === 1 ? "is" : "are"} listed below but no longer{" "}
        {approvedContextCount === 1 ? "raises" : "raise"} this release&rsquo;s risk. Findings on
        changed files always do.
      </>
    ) : null;

  if (variant === "diverged") {
    const count = consistency.newFindingCount;
    return (
      <p class="m-0 text-[13px] text-ink-muted">
        {count} {pluralize("finding", count)} {count === 1 ? "is" : "are"} new since the last
        approved release
        {consistency.priorVersion || consistency.priorScanId ? (
          <> ({priorScanLink(consistency)})</>
        ) : null}
        .{scoringNote}
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
      {scoringNote}
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
