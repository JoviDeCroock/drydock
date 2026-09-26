import { Show } from "@preact/signals/utils";
import { useComputed, useModel, useSignal } from "@preact/signals";
import { useId } from "preact/hooks";
import { PackageClaimModel, type PackageClaimManagement } from "../../models/package-claim";
import type { Organization } from "../../models/organization";
import { packageReleasesPath } from "../../lib/package-releases-path";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Dialog } from "../../components/Dialog";
import { Select } from "../../components/Select";
import { EmptyLine, LoadingLine } from "../../components/Typography";

type ClaimModel = InstanceType<typeof PackageClaimModel>;
type Destination = { id: string; name: string; transferred: boolean };
type ManagedClaim = NonNullable<PackageClaimManagement["claim"]>;

function DestinationLink({
  model,
  destination,
  packageName,
}: {
  model: ClaimModel;
  destination: Destination;
  packageName: string;
}) {
  return (
    <>
      <Alert tone="info">
        {destination.transferred
          ? `Managed in ${destination.name}. Your existing reviews remain private in this workspace; its badge and monitoring are inactive here.`
          : `Continue in ${destination.name} to watch this package. Nothing has changed in this workspace.`}{" "}
        <a class="underline" href={packageReleasesPath(packageName, "npm", destination.id)}>
          Manage in {destination.name}
        </a>
      </Alert>
      <Show when={model.error}>{(error) => <Alert tone="warn">{error}</Alert>}</Show>
    </>
  );
}

/** The initial read failed, so there is nothing to choose from; offer a retry. */
function LoadFailure({ model }: { model: ClaimModel }) {
  const message = useComputed(() =>
    !model.loading.value && !model.management.value ? model.error.value : null,
  );
  return (
    <Show when={message}>
      {(error) => (
        <Alert tone="warn">
          <div class="flex flex-wrap items-center gap-3">
            <span>Package management could not be loaded: {error}</span>
            <Button variant="secondary" size="sm" onClick={() => void model.load()}>
              Retry
            </Button>
          </div>
        </Alert>
      )}
    </Show>
  );
}

function OrganizationChoice({
  model,
  watch,
  onChanged,
}: {
  model: ClaimModel;
  watch: boolean;
  onChanged: (result: "watched" | "kept" | "moved") => void;
}) {
  const view = useComputed(() => {
    const data = model.management.value;
    const source = model.organization.value;
    return data && source ? { data, source } : null;
  });
  return (
    <Show when={view}>
      {({ data, source }) => (
        <ChoiceForm model={model} data={data} source={source} watch={watch} onChanged={onChanged} />
      )}
    </Show>
  );
}

function ChoiceForm({
  model,
  data,
  source,
  watch,
  onChanged,
}: {
  model: ClaimModel;
  data: PackageClaimManagement;
  source: Organization;
  watch: boolean;
  onChanged: (result: "watched" | "kept" | "moved") => void;
}) {
  // Derivations read the model's signals rather than the snapshot props, so
  // they stay current without re-rendering this form.
  const selection = useComputed(() => {
    const targetId = model.selectedOrganizationId.value;
    const management = model.management.value;
    const target = management?.destinations.find((item) => item.id === targetId);
    return {
      same: targetId === model.organization.value?.id,
      target,
      transfers: target !== undefined && management?.claim?.canManage === true,
    };
  });
  const permanentMove = useComputed(() =>
    selection.value.transfers ? (selection.value.target?.name ?? null) : null,
  );
  const disabled = useComputed(() => model.busy.value || !model.selectedOrganizationId.value);
  const actionLabel = useComputed(() => {
    const { same, target, transfers } = selection.value;
    const busy = model.busy.value;
    const personal = model.organization.value?.isPersonal === true;
    if (busy) return "Saving…";
    if (same) {
      if (!watch) return "Keep in personal workspace";
      return personal ? "Keep here and watch package" : "Watch package";
    }
    return `${transfers ? "Move to" : "Open"} ${target?.name ?? "organization"}`;
  });
  return (
    <div class="flex flex-col gap-3">
      <EmptyLine>
        Choose the workspace responsible for this package’s future reviews, monitoring, and public
        badge. Existing reviews and npm credentials stay where they are.
      </EmptyLine>
      {!data.claim ? (
        // A missing claim may also mean another organization manages the
        // package; the API deliberately does not say which, so neither does this.
        <EmptyLine>
          Watching public releases does not change which workspace manages this package.
        </EmptyLine>
      ) : null}
      <Select
        aria-label="Managing organization"
        value={model.selectedOrganizationId}
        disabled={model.busy}
        onChange={(id) => {
          model.selectedOrganizationId.value = id;
        }}
      >
        <option value="" disabled>
          Choose organization
        </option>
        {data.destinations.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
        <option value={source.id}>
          {source.isPersonal ? "Keep in personal workspace" : source.name}
        </option>
      </Select>
      <Show when={permanentMove}>
        {(name) => (
          <Alert tone="warn">
            Moving is permanent: {name} manages this package’s monitoring and public badge from now
            on, and its badge needs a new review there. Your existing reviews stay private in this
            workspace.
          </Alert>
        )}
      </Show>
      <Button
        disabled={disabled}
        onClick={async () => {
          const result = await model.choose(watch);
          if (result) onChanged(result);
        }}
      >
        {actionLabel}
      </Button>
    </div>
  );
}

function ManagedCard({
  model,
  claim,
  onChanged,
}: {
  model: ClaimModel;
  claim: ManagedClaim;
  onChanged: () => void;
}) {
  const choosing = useSignal(false);
  const panelId = useId();
  // With no shared destination, a confirmed claim has nothing left to choose.
  const canChoose = useComputed(() => {
    const management = model.management.value;
    return !management?.claim?.managementConfirmed || management.destinations.length > 0;
  });
  return (
    <Card class="flex flex-col gap-3">
      <div class="flex flex-wrap justify-between items-center gap-3">
        <div>
          <p class="m-0 text-[13px] font-medium">Managed in your personal workspace</p>
          {!claim.managementConfirmed ? (
            <EmptyLine>
              Choose an organization before enabling this package’s monitoring and public badge.
            </EmptyLine>
          ) : null}
        </div>
        <Show when={canChoose}>
          <Button
            variant="secondary"
            size="sm"
            aria-expanded={choosing}
            aria-controls={panelId}
            onClick={() => {
              choosing.value = !choosing.value;
            }}
          >
            {claim.managementConfirmed ? "Move to organization" : "Choose organization"}
          </Button>
        </Show>
      </div>
      <Show when={model.error}>{(error) => <Alert tone="critical">{error}</Alert>}</Show>
      <div id={panelId}>
        <Show when={() => choosing.value && canChoose.value}>
          {() => (
            <OrganizationChoice
              model={model}
              watch={false}
              onChanged={() => {
                choosing.value = false;
                onChanged();
              }}
            />
          )}
        </Show>
      </div>
    </Card>
  );
}

export function PackageManagement({
  packageName,
  registryUrl,
  onChanged,
}: {
  packageName: string;
  registryUrl?: string;
  onChanged: () => void;
}) {
  const model = useModel(() => new PackageClaimModel(packageName, registryUrl));
  const managed = useComputed(() => {
    const claim = model.management.value?.claim;
    return !model.loading.value && claim?.kind === "personal" && claim.canManage ? claim : null;
  });
  return (
    <Show
      when={model.movedTo}
      fallback={
        <>
          <LoadFailure model={model} />
          <Show when={managed}>
            {(claim) => <ManagedCard model={model} claim={claim} onChanged={onChanged} />}
          </Show>
        </>
      }
    >
      {(destination) => (
        <DestinationLink model={model} destination={destination} packageName={packageName} />
      )}
    </Show>
  );
}

export function WatchPackageDialog({
  packageName,
  onClose,
  onChanged,
}: {
  packageName: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const model = useModel(() => new PackageClaimModel(packageName));
  const choiceError = useComputed(() =>
    !model.movedTo.value && model.management.value ? model.error.value : null,
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Choose where to watch this package"
      description={packageName}
    >
      <Show
        when={model.loading}
        fallback={
          <Show
            when={model.movedTo}
            fallback={
              <OrganizationChoice
                model={model}
                watch
                onChanged={(result) => {
                  onChanged();
                  if (result === "watched" && !model.error.peek()) onClose();
                }}
              />
            }
          >
            {(destination) => (
              <DestinationLink model={model} destination={destination} packageName={packageName} />
            )}
          </Show>
        }
      >
        <LoadingLine>Loading organizations</LoadingLine>
      </Show>
      <LoadFailure model={model} />
      <Show when={choiceError}>{(error) => <Alert tone="critical">{error}</Alert>}</Show>
    </Dialog>
  );
}
