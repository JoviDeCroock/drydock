import type { ReadonlySignal } from "@preact/signals";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { EmptyLine } from "../../components/Typography";
import { formatDateTime } from "../../lib/format";
import type { PublicationObservation } from "../../models/publication-watches";
import {
  isPublicationAlert,
  observationStatusLabels,
  observationTone,
  unknownReasonLabel,
} from "./copy";

/**
 * One watch's observed releases, unacknowledged alerts first. Shared by the
 * dashboard card (expanded under its row) and the package page.
 */
export function ObservationList({
  observations,
  busy,
  acknowledge,
}: {
  observations: PublicationObservation[];
  busy: ReadonlySignal<boolean>;
  acknowledge: (observationId: string) => void;
}) {
  if (observations.length === 0) {
    return (
      <div class="border-t border-border px-5 py-3.5">
        <EmptyLine>No releases since enrollment. Earlier releases are not checked.</EmptyLine>
      </div>
    );
  }
  return (
    <ul class="list-none m-0 border-t border-border px-5 py-3.5 flex flex-col gap-2">
      {observations.map((observation) => {
        const reason =
          observation.status === "unknown" ? unknownReasonLabel(observation.reason) : null;
        return (
          <li key={observation.version} class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="font-mono text-[13px] font-medium break-all">{observation.version}</span>
            <Badge tone={observationTone(observation.status)}>
              {observationStatusLabels[observation.status]}
            </Badge>
            {reason ? <span class="text-[13px] text-ink-muted">{reason}</span> : null}
            <span class="font-mono text-[11px] text-ink-subtle">
              {observation.publishedAt
                ? `published ${formatDateTime(observation.publishedAt)}`
                : "publication time unknown"}
            </span>
            {observation.acknowledgedAt ? (
              <span class="font-mono text-[11px] text-ink-subtle">
                Acknowledged {formatDateTime(observation.acknowledgedAt)}
              </span>
            ) : isPublicationAlert(observation.status) ? (
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
            {observation.scanId ? (
              <a
                href={`/dashboard/scans/${encodeURIComponent(observation.scanId)}`}
                class="text-[13px]"
              >
                Open review
              </a>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
