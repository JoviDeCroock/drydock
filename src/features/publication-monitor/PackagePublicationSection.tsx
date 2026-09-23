import { useComputed, useModel, useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { Alert } from "../../components/Alert";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmptyLine, LoadingLine, SectionLabel } from "../../components/Typography";
import { formatDateTime, pluralize } from "../../lib/format";
import {
  PackagePublicationModel,
  type PackagePublication,
  type PublicationAlertRecord,
  type PublicationEnrollment,
} from "../../models/package-publication";
import { observationStatusLabels, watchMetaLine, watchProblemMessage } from "./copy";
import { CoverageGap } from "./CoverageGap";
import { ObservationList } from "./ObservationList";
import { StopWatchingDialog } from "./StopWatchingDialog";

type Model = ReturnType<typeof useModel<typeof PackagePublicationModel.prototype>>;

function notWatchedReason(packageName: string, enrollment: PublicationEnrollment): string {
  switch (enrollment.state) {
    case "stopped":
      return `Not watched. Monitoring was stopped on ${formatDateTime(enrollment.stoppedAt)}, so automatic enrollment will not restore it.`;
    case "suggested":
      return "Not watched. A workflow gate reviewed it, but nothing has confirmed it is public on npm.";
    case "pending":
      return "Not watched yet. It enrolls automatically the next time the monitor reconciles.";
    case "deferred":
      return "Not watched. Automatic enrollment is waiting for a free slot under the 20-package limit.";
    default:
      return `Not watched. No public npm release of ${packageName} has been reviewed in this organization.`;
  }
}

/**
 * The package page's view of the publication monitor for one npm package:
 * the same watch, observations and actions as the dashboard card, scoped to
 * this package. Self-contained so the page mounts it with one line.
 */
export function PackagePublicationSection({ packageName }: { packageName: string }) {
  const model = useModel(() => new PackagePublicationModel(packageName));
  return (
    <section class="flex flex-col gap-3" aria-label="Publication monitor">
      <SectionLabel as="h2" aside={<MonitorAside model={model} />}>
        publication monitor
      </SectionLabel>
      <Show when={model.error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>
      <Card padding="none" class="overflow-hidden">
        <Show
          when={model.publication}
          fallback={
            <div class="p-5">
              <LoadingLine>Loading publication monitoring</LoadingLine>
            </div>
          }
        >
          {(publication) => (
            <>
              <PublicationBody model={model} publication={publication} />
              <EarlierAlerts publication={publication} />
            </>
          )}
        </Show>
      </Card>
    </section>
  );
}

/**
 * Alerts from the organization's ledger that the release list above does not
 * show: those raised in earlier watch windows (stopping a watch removes its
 * observations but not its alert ledger), and older ones from this watch that
 * fall beyond the list's cap. The ledger page is the latest 50 alerts.
 */
function EarlierAlerts({ publication }: { publication: PackagePublication }) {
  const listed = new Set(publication.observations.map((observation) => observation.version));
  const unlisted = publication.alerts.filter((alert) => !listed.has(alert.version));
  const groups: [string, PublicationAlertRecord[]][] = [
    [
      "Alerts from earlier watches of this package",
      unlisted.filter((alert) => !alert.inCurrentWatch),
    ],
    ["Older alerts from this watch", unlisted.filter((alert) => alert.inCurrentWatch)],
  ];
  if (unlisted.length === 0 && !publication.moreAlerts) return null;
  return (
    <div class="border-t border-border px-5 py-3.5 flex flex-col gap-3">
      {groups.map(([heading, alerts]) =>
        alerts.length ? (
          <div key={heading} class="flex flex-col gap-2">
            <p class="m-0 text-[13px] text-ink-muted">{heading}</p>
            <ul class="list-none m-0 p-0 flex flex-col gap-2">
              {alerts.map((alert) => (
                <li key={alert.version} class="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span class="font-mono text-[13px] font-medium break-all">{alert.version}</span>
                  <Badge tone="critical">{observationStatusLabels[alert.status]}</Badge>
                  <span class="font-mono text-[11px] text-ink-subtle">
                    {alert.acknowledgedAt
                      ? `acknowledged ${formatDateTime(alert.acknowledgedAt)}`
                      : `raised ${formatDateTime(alert.createdAt)} · not acknowledged`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
      {publication.moreAlerts ? (
        <p class="m-0 text-[13px] text-ink-muted">
          Showing the latest {publication.alerts.length} alerts for this package; older ones are
          kept but not listed here.
        </p>
      ) : null}
    </div>
  );
}

function MonitorAside({ model }: { model: Model }) {
  return (
    <Show<PackagePublication | null> when={model.publication}>
      {(publication) =>
        publication.ownershipConflict || publication.watch?.ownershipConflict ? (
          <Badge tone="neutral">monitoring inactive</Badge>
        ) : publication.watch ? (
          publication.watch.unresolvedAlertCount > 0 ? (
            <Badge tone="critical">
              {publication.watch.unresolvedAlertCount} unacknowledged{" "}
              {pluralize("alert", publication.watch.unresolvedAlertCount)}
            </Badge>
          ) : (
            <Badge tone="ok">watching</Badge>
          )
        ) : (
          <Badge tone="neutral">not watched</Badge>
        )
      }
    </Show>
  );
}

function PublicationBody({
  model,
  publication,
}: {
  model: Model;
  publication: PackagePublication;
}) {
  // Stopping hides alert history and opts the package out, so the server
  // allows it only to integration managers; the button mirrors that.
  const stopDisabled = useComputed(() => model.busy.value || !model.canStop.value);
  const confirmingStop = useSignal(false);
  const stopPackageName = useComputed(() =>
    confirmingStop.value ? publication.packageName : null,
  );
  const { watch } = publication;
  if (!watch) {
    return (
      <div class="px-5 py-4 flex flex-wrap items-center justify-between gap-3">
        <EmptyLine>
          {publication.ownershipConflict
            ? "Monitoring inactive because this package is assigned to another organization. Previous observations remain available."
            : notWatchedReason(publication.packageName, publication.enrollment)}
        </EmptyLine>
        <Button
          variant="secondary"
          size="sm"
          disabled={publication.ownershipConflict || model.busy}
          onClick={() => void model.start()}
          title="Compare this package's public npm releases with this organization's approvals"
        >
          Watch package
        </Button>
      </div>
    );
  }
  return (
    <>
      <div class="px-5 py-3.5 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div class="flex min-w-0 flex-col gap-1.5">
          <p class="m-0 font-mono text-[11px] text-ink-subtle">{watchMetaLine(watch)}</p>
          {publication.viewer.canStop ? null : (
            <p class="m-0 text-[13px] text-ink-muted">
              Only organization owners and admins can stop watching a package.
            </p>
          )}
        </div>
        <div class="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={publication.ownershipConflict || watch.ownershipConflict || model.busy}
            onClick={() => void model.check()}
            title="Fetch the latest releases from npm and compare them with recorded approvals"
          >
            Check releases
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={stopDisabled}
            onClick={() => {
              confirmingStop.value = true;
            }}
          >
            Stop watching
          </Button>
        </div>
      </div>
      {watch.lastError ? (
        <div class="px-5 pb-3.5">
          <Alert tone="warn">{watchProblemMessage(watch.lastError)}</Alert>
        </div>
      ) : null}
      <CoverageGap watch={watch} />
      <ObservationList
        watch={watch}
        observations={publication.observations}
        busy={model.busy}
        acknowledge={(observationId) => void model.acknowledge(observationId)}
      />
      <StopWatchingDialog
        packageName={stopPackageName}
        busy={model.busy}
        onClose={() => {
          confirmingStop.value = false;
        }}
        onConfirm={() => {
          void model.stop().then(() => {
            confirmingStop.value = false;
          });
        }}
      />
    </>
  );
}
