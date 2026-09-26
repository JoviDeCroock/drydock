import { Show } from "@preact/signals/utils";
import { useModel, useSignal } from "@preact/signals";
import { PackageClaimModel } from "../../models/package-claim";
import { packageReleasesPath } from "../../lib/package-releases-path";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Dialog } from "../../components/Dialog";
import { Select } from "../../components/Select";
import { EmptyLine, LoadingLine } from "../../components/Typography";

type ClaimModel = InstanceType<typeof PackageClaimModel>;

function DestinationLink({ model, packageName }: { model: ClaimModel; packageName: string }) {
  const destination = model.movedTo.value;
  if (!destination) return null;
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

function OrganizationChoice({
  model,
  watch,
  onChanged,
}: {
  model: ClaimModel;
  watch: boolean;
  onChanged: (result: "watched" | "kept" | "moved") => void;
}) {
  const data = model.management.value;
  const source = model.organization.value;
  if (!data || !source) return null;
  const personal = source.isPersonal;
  const targetId = model.selectedOrganizationId.value;
  const target = data.destinations.find((item) => item.id === targetId);
  const same = targetId === source.id;
  return (
    <div class="flex flex-col gap-3">
      <EmptyLine>
        Choose the workspace responsible for this package’s future reviews, monitoring, and public
        badge. Existing reviews and npm credentials stay where they are.
      </EmptyLine>
      {!data.claim ? (
        <EmptyLine>
          Watching public releases does not assign package ownership. The first staged review
          assigns it.
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
        <option value={source.id}>{personal ? "Keep in personal workspace" : source.name}</option>
      </Select>
      <Button
        disabled={model.busy.value || !targetId}
        onClick={async () => {
          const result = await model.choose(watch);
          if (result) onChanged(result);
        }}
      >
        {model.busy.value
          ? "Saving…"
          : same
            ? watch
              ? personal
                ? "Keep here and watch package"
                : "Watch package"
              : "Keep in personal workspace"
            : data.claim?.canManage
              ? `Move to ${target?.name ?? "organization"}`
              : `Open ${target?.name ?? "organization"}`}
      </Button>
    </div>
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
  const choosing = useSignal(false);
  const claim = model.management.value?.claim;
  if (model.movedTo.value) return <DestinationLink model={model} packageName={packageName} />;
  if (model.loading.value || claim?.kind !== "personal" || !claim.canManage) return null;
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
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            choosing.value = !choosing.value;
          }}
        >
          {claim.managementConfirmed ? "Move to organization" : "Choose organization"}
        </Button>
      </div>
      {model.error.value ? <Alert tone="critical">{model.error}</Alert> : null}
      <Show when={choosing}>
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
    </Card>
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
  return (
    <Dialog
      open
      onClose={onClose}
      title="Choose where to watch this package"
      description={packageName}
    >
      {model.loading.value ? (
        <LoadingLine>Loading organizations</LoadingLine>
      ) : model.movedTo.value ? (
        <DestinationLink model={model} packageName={packageName} />
      ) : (
        <OrganizationChoice
          model={model}
          watch
          onChanged={(result) => {
            onChanged();
            if (result === "watched" && !model.error.peek()) onClose();
          }}
        />
      )}
      <Show when={() => !model.movedTo.value && model.error.value}>
        {(error) => <Alert tone="critical">{error}</Alert>}
      </Show>
    </Dialog>
  );
}
