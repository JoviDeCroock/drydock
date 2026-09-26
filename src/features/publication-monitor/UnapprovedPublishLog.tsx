import { useModel, useSignalEffect, type ReadonlySignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { Alert } from "../../components/Alert";
import { Badge } from "../../components/Badge";
import { EmptyLine, LoadingLine } from "../../components/Typography";
import { packageReleasesPath } from "../../lib/package-releases-path";
import { PublicationAlertLogModel } from "../../models/publication-alert-log";
import {
  alertLogMetaLine,
  observationStatusLabels,
  resolutionLabels,
  resolutionTone,
} from "./copy";

/**
 * Every release of a watched package that npm published without this
 * organization's approval, across packages and watch windows. `refreshKey`
 * changes whenever the watch list reloads (a check, an acknowledgment, a
 * stop), so the log follows what the rows above just did.
 */
export function UnapprovedPublishLog({ refreshKey }: { refreshKey: ReadonlySignal<unknown> }) {
  const log = useModel(PublicationAlertLogModel);
  useSignalEffect(() => {
    if (refreshKey.value === undefined) return;
    void log.refresh();
  });

  return (
    <div class="border-t border-border px-5 py-3.5 flex flex-col gap-3">
      <div class="flex flex-col gap-0.5">
        <h3 class="m-0 text-[13px] font-medium text-ink">Unapproved publishes</h3>
        <p class="m-0 text-[13px] text-ink-muted">
          Releases of watched packages that npm published without an approval in this organization.
          Scan one from its release list to decide it after the fact.
        </p>
      </div>
      <Show when={log.error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>
      <Show when={() => !log.loaded.value}>
        <LoadingLine>Loading unapproved publishes</LoadingLine>
      </Show>
      <Show when={() => log.loaded.value && !log.error.value && log.alerts.value.length === 0}>
        <EmptyLine>No watched package has been published without an approval.</EmptyLine>
      </Show>
      <ul class="list-none m-0 p-0 flex flex-col gap-2">
        {log.alerts.value.map((entry) => (
          <li
            key={`${entry.packageName}@${entry.version}`}
            class="flex flex-wrap items-center gap-x-3 gap-y-1"
          >
            <a
              href={packageReleasesPath(entry.packageName, "npm")}
              class="min-w-0 break-all font-mono text-[13px] font-medium text-ink"
            >
              {entry.packageName}@{entry.version}
            </a>
            <Badge tone="critical">{observationStatusLabels[entry.status]}</Badge>
            {entry.resolution ? (
              <Badge tone={resolutionTone(entry.resolution)}>
                {resolutionLabels[entry.resolution]}
              </Badge>
            ) : null}
            <span class="font-mono text-[11px] text-ink-subtle">{alertLogMetaLine(entry)}</span>
          </li>
        ))}
      </ul>
      <Show when={log.more}>
        <p class="m-0 text-[13px] text-ink-muted">
          Showing the latest {log.alerts.value.length}; older entries are kept but not listed here.
        </p>
      </Show>
    </div>
  );
}
