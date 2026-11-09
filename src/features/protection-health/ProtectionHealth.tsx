import { useComputed, useModel, useSignalEffect } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { activeOrganizationId } from "../../models/active-organization";
import { ProtectionHealthModel, type ProtectionHealthTarget } from "../../models/protection-health";
import type { ReleaseTargetsModel } from "../../models/release-targets";
import { formatDateTimeExact } from "../../lib/format";
import { Alert } from "../../components/Alert";
import { Badge, type BadgeTone } from "../../components/Badge";
import { Button } from "../../components/Button";
import { SettingsCardBody, SettingsCardHeader } from "../../components/Card";
import { LoadingLine, MonoDetail, Muted } from "../../components/Typography";

type HealthModel = InstanceType<typeof ProtectionHealthModel>;

const STATES: Record<string, { label: string; tone: BadgeTone }> = {
  verified: { label: "Configured controls verified", tone: "ok" },
  at_risk: { label: "Needs attention", tone: "medium" },
  unknown: { label: "Not verified", tone: "neutral" },
  stale: { label: "Evidence stale", tone: "neutral" },
};

export function ProtectionHealth({
  targets,
}: {
  targets: InstanceType<typeof ReleaseTargetsModel>;
}) {
  const model = useModel(ProtectionHealthModel);
  useSignalEffect(() => {
    void activeOrganizationId.value;
    void targets.releaseTargets.value;
    void model.load();
  });
  return (
    <section aria-label="Protection health">
      <SettingsCardHeader title="Protection health" />
      <SettingsCardBody inset="belowHeader" gap="compact">
        <Muted class="text-[13px] m-0">
          Checks the mapped publishing environment and the repository's default-branch dependency
          check. Evidence expires after one hour and is checked periodically. It does not verify
          other branches, registry settings or interactive publishing paths.
        </Muted>
        <Show when={() => !model.loaded.value}>
          <LoadingLine size="inline">Loading protection evidence…</LoadingLine>
        </Show>
        <Show when={model.error}>
          {(message) => <Alert tone="warn">Could not load protection evidence: {message}</Alert>}
        </Show>
        <Show
          when={() => model.loaded.value && !model.error.value && model.targets.value.length === 0}
        >
          <Muted class="text-[13px] m-0">
            No protection evidence is available for the mapped targets.
          </Muted>
        </Show>
        <ul class="list-none p-0 m-0 divide-y divide-border">
          {model.targets.value.map((target) => (
            <TargetHealth key={target.releaseTargetId} target={target} model={model} />
          ))}
        </ul>
      </SettingsCardBody>
    </section>
  );
}

function TargetHealth({ target, model }: { target: ProtectionHealthTarget; model: HealthModel }) {
  const state = STATES[model.states.value[target.releaseTargetId] ?? "unknown"]!;
  const refreshError = model.refreshErrors.value[target.releaseTargetId];
  return (
    <li class="py-4 first:pt-0 last:pb-0">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex flex-col gap-2 min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-mono text-[13px] break-all">{target.repositoryFullName}</span>
            <Badge tone={state.tone}>{state.label}</Badge>
          </div>
          <MonoDetail
            parts={[
              <span key="env">env {target.environment}</span>,
              <span key="branch">branch {target.defaultBranch ?? "unknown"}</span>,
              target.checkedAt ? (
                <time key="time" dateTime={target.checkedAt}>
                  Checked {formatDateTimeExact(target.checkedAt)}
                </time>
              ) : (
                <span key="time">Not checked yet</span>
              ),
              model.staleEvidence.value[target.releaseTargetId] ? (
                <span key="age">Evidence older than one hour</span>
              ) : null,
            ]}
          />
        </div>
        <Show when={model.canRefresh}>
          <RefreshButton targetId={target.releaseTargetId} model={model} />
        </Show>
      </div>
      {refreshError ? (
        <div class="mt-3">
          <Alert tone="warn">Could not refresh this target: {refreshError}</Alert>
        </div>
      ) : null}
      <details class="mt-3">
        <summary class="cursor-pointer text-[13px] text-ink-muted">View protection checks</summary>
        <ul class="list-none m-0 pt-3 pl-0 flex flex-col gap-3">
          {target.checks.map((check) => (
            <li key={check.id}>
              <div class="flex flex-wrap items-center gap-2 text-[13px]">
                <span>{check.label}</span>
                <Badge tone={check.status === "failed" ? "medium" : "neutral"}>
                  {check.status}
                </Badge>
              </div>
              <Muted class="text-[13px] m-0 mt-1">{check.detail}</Muted>
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

function RefreshButton({ targetId, model }: { targetId: string; model: HealthModel }) {
  const refreshing = useComputed(() => model.refreshing.value.includes(targetId));
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={refreshing}
      onClick={() => void model.refresh(targetId)}
    >
      <Show when={refreshing} fallback="Check now">
        Checking…
      </Show>
    </Button>
  );
}
