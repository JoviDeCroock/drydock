import type { ReadonlySignal } from "@preact/signals";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { EmptyLine } from "../../components/Typography";
import { formatDateTime } from "../../lib/format";
import { packageDiffPath } from "../../lib/package-diff-path";
import type { PublicationObservation, PublicationWatch } from "../../models/publication-watches";
import {
  declinedRemediation,
  emptyObservationsMessage,
  isAlertResolved,
  isPublicationAlert,
  observationReasonLabel,
  observationStatusLabels,
  observationTone,
  postReleaseReviewState,
  resolutionBadgeMessage,
  resolutionLabels,
  resolutionTone,
} from "./copy";

/**
 * One watch's observed releases, unacknowledged alerts first. Shared by the
 * dashboard card (expanded under its row) and the package page.
 *
 * An alert can be reviewed after the fact: **Scan** starts a review of the
 * published bytes against the version they follow, and deciding it resolves
 * the alert. The observation's own status stays what it was when observed;
 * the resolution is shown beside it, never instead of it.
 */
export function ObservationList({
  watch,
  observations,
  busy,
  acknowledge,
  review,
}: {
  watch: Pick<PublicationWatch, "packageName" | "lastCheckedAt" | "lastError">;
  observations: PublicationObservation[];
  busy: ReadonlySignal<boolean>;
  acknowledge: (observationId: string) => void;
  /** Start the alert's post-release review (or open the existing one). */
  review: (observationId: string) => void;
}) {
  if (observations.length === 0) {
    return (
      <div class="border-t border-border px-5 py-3.5">
        <EmptyLine>{emptyObservationsMessage(watch)}</EmptyLine>
      </div>
    );
  }
  return (
    <ul class="list-none m-0 border-t border-border px-5 py-3.5 flex flex-col gap-2">
      {observations.map((observation) => {
        const reason = observationReasonLabel(observation);
        const alert = isPublicationAlert(observation.status);
        const reviewState = postReleaseReviewState(observation);
        const badgeMessage = resolutionBadgeMessage(observation);
        return (
          <li key={observation.version} class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="font-mono text-[13px] font-medium break-all">{observation.version}</span>
            <Badge tone={observationTone(observation.status)}>
              {observationStatusLabels[observation.status]}
            </Badge>
            {observation.coverageGap ? (
              // A coverage gap, not a discrepancy: the comparison could not be made.
              <Badge tone="medium">not verified</Badge>
            ) : null}
            {reason ? <span class="text-[13px] text-ink-muted">{reason}</span> : null}
            <span class="font-mono text-[11px] text-ink-subtle">
              {observation.publishedAt
                ? `published ${formatDateTime(observation.publishedAt)}`
                : "publication time unknown"}
            </span>
            {observation.resolution ? (
              <>
                <Badge tone={resolutionTone(observation.resolution)}>
                  {resolutionLabels[observation.resolution]}
                </Badge>
                {observation.resolvedAt ? (
                  <span class="font-mono text-[11px] text-ink-subtle">
                    decided {formatDateTime(observation.resolvedAt)}
                  </span>
                ) : null}
              </>
            ) : reviewState ? (
              <Badge tone={reviewState.tone}>{reviewState.label}</Badge>
            ) : null}
            {observation.acknowledgedAt ? (
              <span class="font-mono text-[11px] text-ink-subtle">
                Acknowledged {formatDateTime(observation.acknowledgedAt)}
              </span>
            ) : alert && !isAlertResolved(observation) ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => acknowledge(observation.id)}
                title="Mark this publication alert as seen. Its evidence and approval status stay unchanged."
              >
                Acknowledge
              </Button>
            ) : null}
            {alert && !observation.reviewScanId ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => review(observation.id)}
                title="Review the published bytes against the version they follow, then approve or decline this release after it was published."
              >
                Scan
              </Button>
            ) : null}
            {observation.previousVersion ? (
              // What was actually published, read the product's way: the
              // release's public diff against the version it follows.
              <a
                href={packageDiffPath(
                  "npm",
                  watch.packageName,
                  observation.previousVersion,
                  observation.version,
                )}
                target="_blank"
                rel="noopener"
                class="text-[13px]"
                aria-label={`Open the public diff of ${observation.version} against ${observation.previousVersion} in a new tab`}
              >
                Diff vs {observation.previousVersion}
              </a>
            ) : null}
            {observation.scanId ? (
              <a
                href={`/dashboard/scans/${encodeURIComponent(observation.scanId)}`}
                class="text-[13px]"
              >
                Open review
              </a>
            ) : null}
            {observation.reviewScanId ? (
              <a
                href={`/dashboard/scans/${encodeURIComponent(observation.reviewScanId)}`}
                class="text-[13px]"
              >
                Open post-release review
              </a>
            ) : null}
            {observation.resolution === "declined_after_release" ? (
              <p class="m-0 basis-full text-[13px] text-ink-muted">
                {declinedRemediation(watch.packageName, observation.version)}
              </p>
            ) : null}
            {badgeMessage ? (
              <p class="m-0 basis-full font-mono text-[11px] text-ink-subtle">{badgeMessage}</p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
