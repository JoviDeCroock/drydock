import { WatchPackageDialog } from "../package-claims/PackageManagement";
import {
  useComputed,
  useModel,
  useSignal,
  useSignalEffect,
  type ReadonlySignal,
} from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { Alert } from "../../components/Alert";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Input } from "../../components/Input";
import { Menu, MenuItem } from "../../components/Menu";
import { EmptyLine, LoadingLine, SectionLabel } from "../../components/Typography";
import { packageReleasesPath } from "../../lib/package-releases-path";
import { PublicationWatchesModel } from "../../models/publication-watches";
import { watchMetaLine, watchProblemMessage } from "./copy";
import { CoverageGap } from "./CoverageGap";
import { ObservationList } from "./ObservationList";
import { StopWatchingDialog } from "./StopWatchingDialog";

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
  const watchTarget = useSignal<string | null>(null);
  const checkingId = useSignal<string | null>(null);
  const stopTarget = useSignal<{ id: string; packageName: string } | null>(null);
  const stopPackageName = useComputed(() => stopTarget.value?.packageName ?? null);
  const confirmStop = async () => {
    const target = stopTarget.peek();
    if (!target) return;
    await model.remove(target.id);
    stopTarget.value = null;
  };

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
            watchTarget.value = model.packageName.peek().trim();
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
                  onClick={() => {
                    watchTarget.value = suggestion.packageName;
                  }}
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
                    <a
                      href={packageReleasesPath(watch.packageName, null, watch.organizationId)}
                      class="min-w-0 truncate text-[14px] font-medium text-ink"
                    >
                      {watch.packageName}
                    </a>
                    <p class="m-0 font-mono text-[11px] text-ink-subtle">{watchMetaLine(watch)}</p>
                    {watch.unresolvedAlertCount > 0 || watch.unverifiedReleaseCount > 0 ? (
                      <div class="flex flex-wrap gap-1.5">
                        {watch.unresolvedAlertCount > 0 ? (
                          <Badge tone="critical">
                            {watch.unresolvedAlertCount} unacknowledged{" "}
                            {watch.unresolvedAlertCount === 1 ? "alert" : "alerts"}
                          </Badge>
                        ) : null}
                        {watch.unverifiedReleaseCount > 0 ? (
                          <Badge tone="medium">{watch.unverifiedReleaseCount} not verified</Badge>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <div class="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={watch.managementPending || watch.ownershipConflict || model.busy}
                      onClick={() => void check(watch.id)}
                      title="Fetch the latest releases from npm and compare them with recorded approvals"
                    >
                      {checking ? "Checking releases…" : "Check releases"}
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
                          onSelect={() => {
                            stopTarget.value = { id: watch.id, packageName: watch.packageName };
                          }}
                        >
                          Stop watching
                        </MenuItem>
                      ) : null}
                    </Menu>
                  </div>
                </div>
                {watch.lastError ? (
                  <div class="px-5 pb-3.5">
                    <Alert tone="warn">{watchProblemMessage(watch.lastError)}</Alert>
                  </div>
                ) : null}
                <CoverageGap watch={watch} />
                {expanded ? (
                  <ObservationList
                    watch={watch}
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
      <Show when={watchTarget}>
        {(name) => (
          <WatchPackageDialog
            key={name}
            packageName={name}
            onClose={() => {
              watchTarget.value = null;
            }}
            onChanged={() => void model.refresh()}
          />
        )}
      </Show>
      <StopWatchingDialog
        packageName={stopPackageName}
        busy={model.busy}
        onClose={() => {
          stopTarget.value = null;
        }}
        onConfirm={() => void confirmStop()}
      />
    </Card>
  );
}
