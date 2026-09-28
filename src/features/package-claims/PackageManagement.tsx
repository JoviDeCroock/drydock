import { Show } from "@preact/signals/utils";
import { useComputed, useModel, useSignal } from "@preact/signals";
import { useEffect, useId, useRef } from "preact/hooks";
import { PackageClaimModel } from "../../models/package-claim";
import { packageReleasesPath } from "../../lib/package-releases-path";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Dialog } from "../../components/Dialog";
import { Select } from "../../components/Select";
import { EmptyLine, LoadingLine } from "../../components/Typography";

type ClaimModel = InstanceType<typeof PackageClaimModel>;
type ChoiceResult = "kept" | "moved";

/**
 * The control that started a choice unmounts once it commits, so the result
 * takes focus; otherwise focus falls back to the document body.
 */
function useFocusOnMount<T extends HTMLElement>(enabled = true) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (enabled) ref.current?.focus();
  }, []);
  return ref;
}

function MovedNotice({ model, packageName }: { model: ClaimModel; packageName: string }) {
  const ref = useFocusOnMount<HTMLDivElement>();
  return (
    <Show when={model.movedTo}>
      {(destination) => (
        <div ref={ref} tabIndex={-1} class="focus-visible:outline-accent">
          <Alert tone="info">
            {destination.name} now manages this package; your existing reviews of it stay private in
            this workspace.{" "}
            <a class="underline" href={packageReleasesPath(packageName, "npm", destination.id)}>
              Manage in {destination.name}
            </a>
          </Alert>
        </div>
      )}
    </Show>
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

function ChoiceForm({
  model,
  includeKeep,
  onChanged,
}: {
  model: ClaimModel;
  /** A pending claim may stay here; a confirmed one only offers a move. */
  includeKeep: boolean;
  onChanged: (result: ChoiceResult) => void;
}) {
  const destinations = useComputed(() => model.management.value?.destinations ?? []);
  const selection = useComputed(() => {
    const id = model.selectedOrganizationId.value;
    const sourceId = model.organization.value?.id;
    return {
      keep: includeKeep && id === sourceId,
      target: destinations.value.find((org) => org.id === id) ?? null,
    };
  });
  const permanentMove = useComputed(() => selection.value.target?.name ?? null);
  const disabled = useComputed(
    () => model.busy.value || (!selection.value.keep && !selection.value.target),
  );
  const actionLabel = useComputed(() => {
    if (model.busy.value) return "Saving…";
    const { keep, target } = selection.value;
    if (keep) return "Keep in personal workspace";
    return target ? `Move to ${target.name}` : "Choose an organization";
  });
  const hasDestinations = useComputed(() => destinations.value.length > 0);
  return (
    <div class="flex flex-col gap-3">
      {/* With no shared organization to move into, keeping is the only choice
          and the button alone says so. */}
      <Show when={hasDestinations}>
        {() => (
          <Select
            aria-label="Managing organization"
            value={model.selectedOrganizationId}
            disabled={model.busy}
            onChange={(id) => {
              model.selectedOrganizationId.value = id;
            }}
          >
            {includeKeep ? (
              <option value={model.organization.value?.id ?? ""}>Keep in personal workspace</option>
            ) : null}
            {destinations.value.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </Select>
        )}
      </Show>
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
          const result = await model.choose();
          if (result) onChanged(result);
        }}
      >
        {actionLabel}
      </Button>
    </div>
  );
}

function ChoiceIntro() {
  return (
    <EmptyLine>
      Its monitoring and public badge stay off until you choose; existing reviews and npm
      credentials stay in this workspace.
    </EmptyLine>
  );
}

function PendingCard({
  model,
  onChanged,
}: {
  model: ClaimModel;
  onChanged: (result: ChoiceResult) => void;
}) {
  return (
    <Card class="flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <p class="m-0 text-[13px] font-medium">Choose where this package is managed</p>
        <ChoiceIntro />
      </div>
      <ChoiceForm model={model} includeKeep onChanged={onChanged} />
    </Card>
  );
}

function ManagedCard({
  model,
  onChanged,
}: {
  model: ClaimModel;
  onChanged: (result: ChoiceResult) => void;
}) {
  const choosing = useSignal(false);
  const panelId = useId();
  // Mounted by a keep in this session: confirm it where the choice was.
  const titleRef = useFocusOnMount<HTMLParagraphElement>(model.kept.peek());
  const movable = useComputed(() => (model.management.value?.destinations.length ?? 0) > 0);
  return (
    <Card class="flex flex-col gap-3">
      <div class="flex flex-wrap justify-between items-center gap-3">
        <p
          ref={titleRef}
          tabIndex={-1}
          class="m-0 text-[13px] font-medium focus-visible:outline-accent"
        >
          Managed in your personal workspace
        </p>
        <Show when={movable}>
          <Button
            variant="secondary"
            size="sm"
            aria-expanded={choosing}
            aria-controls={panelId}
            onClick={() => {
              const destinations = model.management.peek()?.destinations ?? [];
              if (!destinations.some((org) => org.id === model.selectedOrganizationId.peek()))
                model.selectedOrganizationId.value = destinations[0]?.id ?? "";
              choosing.value = !choosing.value;
            }}
          >
            Move to organization
          </Button>
        </Show>
      </div>
      <div id={panelId}>
        <Show when={() => choosing.value && movable.value}>
          {() => <ChoiceForm model={model} includeKeep={false} onChanged={onChanged} />}
        </Show>
      </div>
    </Card>
  );
}

/**
 * The caller's personal claim on an npm package: the Keep or Move choice while
 * it is pending, and the move afterwards when a shared organization can take
 * it. A confirmed claim with nowhere to move renders nothing, and neither does
 * a package this workspace does not manage.
 */
export function PackageManagement({
  model,
  packageName,
  onChanged,
}: {
  model: ClaimModel;
  packageName: string;
  onChanged: () => void;
}) {
  const view = useComputed<"moved" | "pending" | "managed" | null>(() => {
    const moved = model.movedTo.value;
    const pending = model.pending.value;
    const kept = model.kept.value;
    const management = model.management.value;
    if (moved) return "moved";
    if (pending) return "pending";
    const claim = management?.claim;
    if (claim?.kind !== "personal" || !claim.canManage) return null;
    return management!.destinations.length > 0 || kept ? "managed" : null;
  });
  // A read failure has nothing to choose from; LoadFailure reports it instead.
  const choiceError = useComputed(() => (model.management.value ? model.error.value : null));
  return (
    <>
      <LoadFailure model={model} />
      <Show when={() => view.value === "moved"}>
        {() => <MovedNotice model={model} packageName={packageName} />}
      </Show>
      <Show when={() => view.value === "pending"}>
        {() => <PendingCard model={model} onChanged={onChanged} />}
      </Show>
      <Show when={() => view.value === "managed"}>
        {() => <ManagedCard model={model} onChanged={onChanged} />}
      </Show>
      <Show when={choiceError}>{(error) => <Alert tone="critical">{error}</Alert>}</Show>
    </>
  );
}

/** For a page that needs no other view of the claim, such as a scan. */
export function StandalonePackageManagement({
  packageName,
  registryUrl,
  onChanged,
}: {
  packageName: string;
  registryUrl?: string;
  onChanged: () => void;
}) {
  const model = useModel(() => new PackageClaimModel(packageName, registryUrl));
  return <PackageManagement model={model} packageName={packageName} onChanged={onChanged} />;
}

/**
 * Watching a package this personal workspace holds a pending claim on needs the
 * Keep or Move choice first. Keeping hands back to the caller to watch it here;
 * moving leaves a link to the organization that now manages it.
 */
export function PackageManagementDialog({
  packageName,
  onClose,
  onKept,
  onMoved,
}: {
  packageName: string;
  onClose: () => void;
  onKept: () => void;
  onMoved: () => void;
}) {
  const model = useModel(() => new PackageClaimModel(packageName));
  // Keeping confirms the claim before its follow-up read lands and the caller
  // closes the dialog, so the form (showing "Saving…") stays until then.
  const choosing = useComputed(() => {
    const moved = model.movedTo.value;
    const pending = model.pending.value;
    const kept = model.kept.value;
    return !moved && (pending || kept);
  });
  // Only a claim that needed no choice when the dialog opened reads as settled.
  const settled = useComputed(() => {
    const loading = model.loading.value;
    const management = model.management.value;
    const busy = model.busy.value;
    const inChoice = choosing.value;
    const moved = model.movedTo.value;
    return !loading && management !== null && !busy && !inChoice && !moved;
  });
  const choiceError = useComputed(() =>
    model.management.value && !model.movedTo.value ? model.error.value : null,
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Choose where this package is managed"
      description={packageName}
    >
      <Show when={() => model.loading.value && !model.management.value}>
        <LoadingLine>Loading organizations</LoadingLine>
      </Show>
      <LoadFailure model={model} />
      <Show when={model.movedTo}>
        {() => <MovedNotice model={model} packageName={packageName} />}
      </Show>
      <Show when={choosing}>
        {() => (
          <>
            <ChoiceIntro />
            <ChoiceForm
              model={model}
              includeKeep
              onChanged={(result) => {
                if (result === "kept") onKept();
                else onMoved();
              }}
            />
          </>
        )}
      </Show>
      <Show when={settled}>
        <EmptyLine>This package no longer needs a management choice.</EmptyLine>
      </Show>
      <Show when={choiceError}>{(error) => <Alert tone="critical">{error}</Alert>}</Show>
    </Dialog>
  );
}
