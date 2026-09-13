import { useModel } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { Alert } from "../../components/Alert";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Input } from "../../components/Input";
import { Muted, SectionLabel } from "../../components/Typography";
import { formatDateTime } from "../../lib/format";
import {
  PublicationWatchesModel,
  type PublicationObservation,
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
};

export function PublicationMonitor() {
  const model = useModel(PublicationWatchesModel);
  return (
    <Card padding="compact" class="flex flex-col gap-4">
      <SectionLabel as="h2" aside="advisory · after publication">
        Publication monitor
      </SectionLabel>
      <Muted class="m-0 text-[13px]">
        Watch public npm packages for releases that bypass prior approval, including packages with
        no review history. Monitoring starts when enrolled; it does not block publication or judge
        malware. Private packages and custom registries are not supported.
      </Muted>
      <form
        class="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void model.enroll();
        }}
      >
        <label class="flex-1 min-w-48 text-[13px] text-ink-muted">
          Public npm package
          <Input
            class="mt-1"
            value={model.packageName}
            onInput={(event) => {
              model.packageName.value = event.currentTarget.value;
            }}
            placeholder="@scope/package"
            required
            disabled={model.busy}
          />
        </label>
        <Button type="submit" disabled={model.busy}>
          Watch package
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={model.busy}
          onClick={() => void model.refresh()}
        >
          Refresh list
        </Button>
      </form>
      <Show when={() => model.busy.value && model.loaded.value}>
        <Muted class="m-0 text-[13px]">Updating publication watches…</Muted>
      </Show>
      <Show when={model.error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>
      <Show when={() => !model.loaded.value}>
        <Muted class="m-0 text-[13px]">Loading publication watches…</Muted>
      </Show>
      <Show
        when={() => model.loaded.value && model.watches.value.length === 0 && !model.error.value}
      >
        <Muted class="m-0 text-[13px]">No packages watched yet.</Muted>
      </Show>
      <ul class="list-none p-0 m-0 divide-y divide-border">
        {model.watches.value.map((watch) => (
          <li key={watch.id} class="py-3 flex flex-col gap-2">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="m-0 font-mono text-[13px] break-all">{watch.packageName}</p>
                <p class="m-0 mt-1 font-mono text-[11px] text-ink-subtle">
                  Monitoring since {formatDateTime(watch.createdAt)} ·{" "}
                  {watch.lastCheckedAt
                    ? `checked ${formatDateTime(watch.lastCheckedAt)}`
                    : "not checked yet"}
                </p>
              </div>
              <div class="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={model.busy}
                  onClick={() => void model.show(watch.id)}
                >
                  View releases
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={model.busy}
                  onClick={() => void model.show(watch.id, true)}
                >
                  Check npm
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={model.busy}
                  onClick={() => void model.remove(watch.id)}
                >
                  Stop watching
                </Button>
              </div>
            </div>
            {watch.lastError ? (
              <Alert tone="warn">
                {checkErrors[watch.lastError] ??
                  "Latest check incomplete. Coverage is unknown until a successful check."}
              </Alert>
            ) : null}
          </li>
        ))}
      </ul>
      <Show when={model.detail}>
        {(detail) => (
          <div class="flex flex-col gap-3">
            <SectionLabel as="h3">
              Latest observed releases · {detail.watch.packageName}
            </SectionLabel>
            <Muted class="m-0 text-[13px]">Showing up to 100 observations since enrollment.</Muted>
            {detail.observations.length === 0 ? (
              <Muted class="m-0 text-[13px]">
                No releases observed since enrollment. This is not evidence of complete coverage.
              </Muted>
            ) : (
              <ul class="list-none p-0 m-0 flex flex-col gap-3">
                {detail.observations.map((observation) => (
                  <li
                    key={observation.version}
                    class="flex flex-wrap items-center gap-2 text-[13px]"
                  >
                    <span class="font-mono break-all">{observation.version}</span>
                    <Badge
                      tone={
                        observation.status === "approved_match"
                          ? "ok"
                          : observation.status === "unknown"
                            ? "neutral"
                            : "critical"
                      }
                    >
                      {statusLabels[observation.status]}
                    </Badge>
                    <span class="text-ink-muted">
                      {observation.publishedAt
                        ? `published ${formatDateTime(observation.publishedAt)}`
                        : "publication time unknown"}
                    </span>
                    {observation.scanId ? (
                      <a href={`/dashboard/scans/${encodeURIComponent(observation.scanId)}`}>
                        Open review
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Show>
    </Card>
  );
}
