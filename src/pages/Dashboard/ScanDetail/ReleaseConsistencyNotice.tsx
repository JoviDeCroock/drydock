import {
  normalizeReleaseConsistency,
  type ReleaseConsistency,
} from "../../../../server/lib/scan/release-memory";
import { formatDateTime, pluralize } from "../../../lib/format";
import { Alert } from "../../../components/Alert";

const QUIET_LINE = "m-0 text-[13px] leading-[1.55] text-ink-muted";

export type ReleaseConsistencyVariant = "match" | "subset" | "empty" | "diverged";

export function releaseConsistencyVariant(
  consistency: ReleaseConsistency,
): ReleaseConsistencyVariant | null {
  if (consistency.status === "none") return null;
  if (consistency.status === "diverged") return "diverged";
  return consistency.currentFindingCount === 0 ? "empty" : consistency.status;
}

/** Whether release memory asks for attention: findings new since the last approved release. */
export function releaseConsistencyDiverged(value: unknown): boolean {
  const consistency = normalizeReleaseConsistency(value);
  return Boolean(consistency && releaseConsistencyVariant(consistency) === "diverged");
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

  // Emphasis goes to the one variant that asks for attention. Release memory
  // agreeing with the last approved release is the expected case, so it reads
  // as a quiet line; a green Alert there out-ranked the findings it vouches for.
  if (variant === "diverged") {
    const count = consistency.newFindingCount;
    return (
      <Alert tone="warn">
        {count} {pluralize("finding", count)} {count === 1 ? "is" : "are"} new since the last
        approved release
        {consistency.priorVersion || consistency.priorScanId ? (
          <> ({priorScanLink(consistency)})</>
        ) : null}
        .{scoringNote}
      </Alert>
    );
  }

  const approvedOn = consistency.decidedAt
    ? `, approved on ${formatDateTime(consistency.decidedAt)}`
    : "";
  if (variant === "empty") {
    return (
      <p class={QUIET_LINE}>
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
      </p>
    );
  }
  return (
    <p class={QUIET_LINE}>
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
    </p>
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
