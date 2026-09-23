import { useModel, useSignal, useSignalEffect, type ReadonlySignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { Alert } from "../../components/Alert";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Input } from "../../components/Input";
import { Menu, MenuItem } from "../../components/Menu";
import { EmptyLine, LoadingLine, SectionLabel } from "../../components/Typography";
import { formatDateTime } from "../../lib/format";
import {
  PublicationWatchesModel,
  type PublicationObservation,
  type PublicationWatch,
} from "../../models/publication-watches";

const statusLabels: Record<PublicationObservation["status"], string> = {
  approved_match: "Approved bytes published",
  published_without_approval: "Published without prior approval",
  published_despite_rejection: "Published despite rejection",
  artifact_mismatch: "Published different bytes",
  unknown: "Evidence unknown",
};

const checkErrors: Record<string, string> = {
  registry_evidence_unavailable:
    "Registry evidence could not be retrieved. Coverage is unknown until a successful check.",
  pending_release_backlog:
    "More releases are waiting to be checked. Existing observations are retained; coverage is incomplete.",
  invalid_version_metadata:
    "Some registry versions have invalid metadata and could not be checked. Coverage is incomplete.",
  artifact_too_large:
    "A published tarball exceeds the 16 MiB hashing limit, so that release cannot be compared with its reviews.",
  artifact_timeout:
    "A published tarball did not download in time. It is retried on the next check; coverage is incomplete.",
  artifact_unavailable:
    "A published tarball could not be downloaded. It is retried on the next check; coverage is incomplete.",
  artifact_identity_invalid:
    "A release's registry metadata does not name a valid tarball on npm, so its bytes cannot be compared.",
  monitoring_disabled: "Publication monitoring is switched off for this organization.",
  check_failed: "The latest check failed. It is retried on the next scheduled check.",
};

const sourceLabels: Record<PublicationWatch["source"], string> = {
  manual: "added by hand",
  staged_discovery: "from staged discovery",
  published_history: "from published review history",
};

function watchMetaLine(watch: PublicationWatch): string {
  const checked = watch.lastCheckedAt
    ? `checked ${formatDateTime(watch.lastCheckedAt)}`
    : "not checked yet";
  return `${sourceLabels[watch.source]} · watching since ${formatDateTime(watch.createdAt)} · ${checked}`;
}

// Same header/row anatomy as the dashboard's Recent reviews card, so the two
// lists read as one surface rather than a second feature bolted underneath.
export function PublicationMonitor({
  reviews,
  canStop,
}: {
  reviews: ReadonlySignal<unknown>;
  /** Stopping deletes alert history, so only integration managers may. */
  canStop: boolean;
}) {
  const model = useModel(PublicationWatchesModel);
  const lastReviews = useSignal(reviews.peek());
  useSignalEffect(() => {
    const next = reviews.value;
    if (next === lastReviews.peek()) return;
    lastReviews.value = next;
    void model.refresh();
  });
  // Only the row whose check is in flight relabels its button; the model's
  // single `busy` flag disables everything else.
  const checkingId = useSignal<string | null>(null);

  async function check(id: string) {
    checkingId.value = id;
    try {
      await model.show(id, true);
    } finally {
      checkingId.value = null;
    }
  }

  return (
    <Card as="section" padding="none" class="overflow-hidden">
      <div class="px-5 py-4 flex flex-col gap-3 md:flex-row md:items-center">
        <div class="flex-1 min-w-0 flex flex-col gap-1">
          <SectionLabel as="h2" class="after:hidden">
            Publication monitor
          </SectionLabel>
          <p class="m-0 font-mono text-[11px] text-ink-subtle">
            advisory · public npm only · checks releases after they publish
          </p>
        </div>
        <form
          class="flex items-center gap-2 shrink-0"
          onSubmit={(event) => {
            event.preventDefault();
            void model.enroll();
          }}
        >
          <Input
            class="flex-1 min-w-0 md:flex-none md:w-64"
            aria-label="Public npm package"
            value={model.packageName}
            onInput={(event) => {
              model.packageName.value = event.currentTarget.value;
            }}
            placeholder="@scope/package"
            required
            disabled={model.busy}
          />
          <Button type="submit" size="sm" class="whitespace-nowrap" disabled={model.busy}>
            Watch package
          </Button>
        </form>
      </div>
      <Show when={model.error}>
        {(message) => (
          <div class="px-5 pb-4">
            <Alert tone="critical">{message}</Alert>
          </div>
        )}
      </Show>
      <Show when={() => model.autoEnrollment.value.deferred || undefined}>
        {(deferred) => (
          <div class="px-5 pb-4">
            <Alert tone="warn">
              Automatic enrollment is deferred for {deferred} packages because this organization has
              reached its 20-package monitoring limit.
            </Alert>
          </div>
        )}
      </Show>
      <Show<Array<{ packageName: string }> | null>
        when={() =>
          model.autoEnrollment.value.suggestions.length
            ? model.autoEnrollment.value.suggestions
            : null
        }
      >
        {(suggestions) => (
          <div class="border-t border-border px-5 py-3.5 flex flex-col gap-2">
            <p class="m-0 text-[13px] text-ink-muted">
              These workflow-gate packages need an explicit choice to monitor their public npm
              releases.
            </p>
            <div class="flex flex-wrap gap-2">
              {suggestions.map((suggestion) => (
                <Button
                  key={suggestion.packageName}
                  variant="secondary"
                  size="sm"
                  disabled={model.busy}
                  onClick={() => void model.enroll(suggestion.packageName)}
                >
                  Watch {suggestion.packageName}
                </Button>
              ))}
            </div>
          </div>
        )}
      </Show>
      <div class="border-t border-border">
        <Show when={() => !model.loaded.value}>
          <div class="p-5">
            <LoadingLine>Loading watched packages</LoadingLine>
          </div>
        </Show>
        <Show when={() => model.loaded.value && model.watches.value.length === 0}>
          <div class="p-5">
            <EmptyLine>
              No packages watched yet. Add a public npm package to be told when a release lands
              without a prior approval.
            </EmptyLine>
          </div>
        </Show>
        <ul class="list-none p-0 m-0">
          {model.watches.value.map((watch) => {
            const detail = model.detail.value;
            const expanded = detail?.watch.id === watch.id ? detail : null;
            const checking = checkingId.value === watch.id;
            return (
              <li key={watch.id} class="border-b border-border last:border-b-0">
                <div class="px-5 py-3.5 flex flex-wrap items-start justify-between gap-x-4 gap-y-2 transition-colors duration-150 hover:bg-surface-2">
                  <div class="flex min-w-0 flex-col gap-1.5">
                    <span class="min-w-0 truncate text-[14px] font-medium">
                      {watch.packageName}
                    </span>
                    <p class="m-0 font-mono text-[11px] text-ink-subtle">{watchMetaLine(watch)}</p>
                    {watch.unresolvedAlertCount > 0 ? (
                      <div>
                        <Badge tone="critical">
                          {watch.unresolvedAlertCount} unacknowledged{" "}
                          {watch.unresolvedAlertCount === 1 ? "alert" : "alerts"}
                        </Badge>
                      </div>
                    ) : null}
                  </div>
                  <div class="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={model.busy}
                      onClick={() => void check(watch.id)}
                      title="Fetch the latest releases from npm and compare them with recorded approvals"
                    >
                      {checking ? "Checking npm…" : "Check npm"}
                    </Button>
                    <Menu
                      align="end"
                      triggerAriaLabel={`More actions for ${watch.packageName}`}
                      triggerClass="inline-flex items-center justify-center h-7 w-7 rounded-md border border-transparent text-ink-muted hover:bg-surface-2 hover:text-ink transition-colors duration-150"
                      trigger={() => (
                        <span aria-hidden="true" class="text-[13px] leading-none">
                          ⋯
                        </span>
                      )}
                    >
                      <MenuItem
                        disabled={model.busy}
                        onSelect={() => {
                          if (expanded) model.detail.value = null;
                          else void model.show(watch.id);
                        }}
                      >
                        {expanded ? "Hide releases" : "Show releases"}
                      </MenuItem>
                      {canStop ? (
                        <MenuItem
                          tone="danger"
                          disabled={model.busy}
                          onSelect={() => void model.remove(watch.id)}
                        >
                          Stop watching
                        </MenuItem>
                      ) : null}
                    </Menu>
                  </div>
                </div>
                {watch.lastError ? (
                  <div class="px-5 pb-3.5">
                    <Alert tone="warn">
                      {checkErrors[watch.lastError] ??
                        "Latest check incomplete. Coverage is unknown until a successful check."}
                    </Alert>
                  </div>
                ) : null}
                {expanded ? (
                  <ObservationList
                    observations={expanded.observations}
                    busy={model.busy}
                    acknowledge={(observationId) => void model.acknowledge(watch.id, observationId)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}

function observationTone(status: PublicationObservation["status"]) {
  if (status === "approved_match") return "ok";
  if (status === "unknown") return "neutral";
  return "critical";
}

function ObservationList({
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
      {observations.map((observation) => (
        <li key={observation.version} class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="font-mono text-[13px] font-medium break-all">{observation.version}</span>
          <Badge tone={observationTone(observation.status)}>
            {statusLabels[observation.status]}
          </Badge>
          <span class="font-mono text-[11px] text-ink-subtle">
            {observation.publishedAt
              ? `published ${formatDateTime(observation.publishedAt)}`
              : "publication time unknown"}
          </span>
          {observation.acknowledgedAt ? (
            <span class="font-mono text-[11px] text-ink-subtle">
              Acknowledged {formatDateTime(observation.acknowledgedAt)}
            </span>
          ) : observation.status === "published_without_approval" ||
            observation.status === "published_despite_rejection" ||
            observation.status === "artifact_mismatch" ? (
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
      ))}
    </ul>
  );
}
