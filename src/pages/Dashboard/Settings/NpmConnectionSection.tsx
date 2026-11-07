import { OrganizationModel } from "../../../models/organization";
import { Select } from "../../../components/Select";
import { type ReadonlySignal, useModel, useSignal, useComputed } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { formatDateTimeExact } from "../../../lib/format";
import { NpmConnectionModel, type PublicNpmConnection } from "../../../models/npm-connection";
import { Alert } from "../../../components/Alert";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { CollapsibleCard, SettingsCardBody } from "../../../components/Card";
import { ConfirmDialog } from "../../../components/Dialog";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { MonoLabel, Muted } from "../../../components/Typography";

type NpmModel = ReturnType<typeof useModel<typeof NpmConnectionModel.prototype>>;
type Organizations = InstanceType<typeof OrganizationModel>;

export function NpmConnectionSection({
  npm,
  organizations,
  onSwitchOrganization,
  defaultOpen = false,
}: {
  npm: NpmModel;
  organizations: Organizations;
  onSwitchOrganization: (id: string) => Promise<void>;
  defaultOpen?: boolean;
}) {
  const personalChosen = useSignal(false);
  const needsChoice = useComputed(
    () =>
      organizations.active.value?.isPersonal === true &&
      !npm.connection.value?.personalOrganizationConfirmedAt &&
      !personalChosen.value,
  );
  // A pending workspace choice must not strand an existing connection: its
  // token stays rotatable (e.g. after it turns invalid) and removable.
  const showForm = useComputed(() => !needsChoice.value || npm.connection.value !== null);
  const invalid = useComputed(() => npm.connection.value?.validationStatus === "invalid");
  // A working token makes rotation optional upkeep, so it folds away; a broken
  // or not-yet-validated one keeps the form in view as the thing to fix.
  const rotationFolded = useComputed(() => npm.connection.value?.validationStatus === "valid");
  const confirmingDisconnect = useSignal(false);
  const deleting = useComputed(() => npm.status.value === "deleting");
  const workspaceChoice = (
    <Show when={needsChoice}>
      {() => (
        <WorkspaceChoice
          npm={npm}
          organizations={organizations}
          onSwitchOrganization={onSwitchOrganization}
          primary={!invalid.value}
          onKeepPersonal={() => {
            personalChosen.value = true;
          }}
        />
      )}
    </Show>
  );

  const onSave = async (event: Event) => {
    event.preventDefault();
    const active = organizations.active.peek();
    if (!active || (needsChoice.peek() && !npm.connection.peek())) return;
    // Rotating a token while the choice is still pending is not consent.
    await npm.save(active.isPersonal && !needsChoice.peek());
  };

  return (
    <CollapsibleCard
      title="npm access"
      defaultOpen={defaultOpen}
      aside={<NpmStatus npm={npm} choicePending={needsChoice} />}
    >
      <SettingsCardBody>
        <Muted class="text-[13px] m-0 max-w-[760px]">
          <span class="font-medium text-ink">Stage Watchtower — advisory.</span> Connect npm to
          review your organization's staged packages.
        </Muted>

        {/* A broken token is the one thing to fix first: its alert sits on the
            token form, and the workspace choice follows as the next step. */}
        <Show when={invalid}>
          <Alert tone="critical">
            Drydock cannot access npm staging with this token; rotate it below to resume
            staged-release reviews.
          </Alert>
        </Show>

        <Show when={() => !invalid.value}>{workspaceChoice}</Show>

        <Show when={() => showForm.value && !rotationFolded.value}>
          {() => <NpmTokenForm npm={npm} onSubmit={onSave} />}
        </Show>

        <Show when={invalid}>{workspaceChoice}</Show>

        <Show when={npm.error}>{(error) => <Alert tone="critical">{error}</Alert>}</Show>

        <Show<PublicNpmConnection | null> when={npm.connection}>
          {(connection) => (
            <div class="flex flex-col gap-4 border-t border-border pt-4">
              <Show when={rotationFolded}>
                <details class="group/rotate min-w-0">
                  <summary class="cursor-pointer list-none text-[13px] text-ink-muted hover:text-ink focus-visible:outline-accent">
                    <span aria-hidden class="mr-1.5 font-mono text-ink-subtle">
                      <span class="group-open/rotate:hidden">▸</span>
                      <span class="hidden group-open/rotate:inline">▾</span>
                    </span>
                    Rotate token
                  </summary>
                  <div class="flex flex-col gap-4 pt-4">
                    <NpmTokenForm npm={npm} onSubmit={onSave} />
                  </div>
                </details>
              </Show>
              <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
                <details class="group/details text-[13px] text-ink-muted min-w-0 flex-1">
                  <summary class="cursor-pointer list-none hover:text-ink focus-visible:outline-accent">
                    <span aria-hidden class="mr-1.5 font-mono text-ink-subtle">
                      <span class="group-open/details:hidden">▸</span>
                      <span class="hidden group-open/details:inline">▾</span>
                    </span>
                    Connection details
                  </summary>
                  <dl class="grid grid-cols-1 sm:grid-cols-3 gap-x-8 gap-y-4 m-0 pt-4">
                    <MetadataField label="label" value={connection.label} />
                    <MetadataField label="registry" value={connection.registryUrl} />
                    <MetadataField
                      label="token"
                      value={`•••• ${connection.tokenLast4 || "stored"}`}
                    />
                    <MetadataField
                      label="validated"
                      value={
                        connection.validatedAt
                          ? formatDateTimeExact(connection.validatedAt)
                          : "not yet"
                      }
                    />
                    <MetadataField
                      label="last used"
                      value={
                        connection.lastUsedAt ? formatDateTimeExact(connection.lastUsedAt) : "never"
                      }
                    />
                  </dl>
                </details>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => (confirmingDisconnect.value = true)}
                  disabled={npm.busy}
                  class="shrink-0"
                >
                  Disconnect npm
                </Button>
                <ConfirmDialog
                  open={confirmingDisconnect}
                  onClose={() => (confirmingDisconnect.value = false)}
                  title="Disconnect npm?"
                  description="Drydock deletes the stored token and stops checking npm for staged releases until a new token is saved."
                  busy={deleting}
                  busyLabel="Disconnecting…"
                  confirmLabel="Disconnect npm"
                  onConfirm={() => void npm.remove()}
                >
                  <Show when={npm.error}>{(error) => <Alert tone="critical">{error}</Alert>}</Show>
                </ConfirmDialog>
              </div>
            </div>
          )}
        </Show>
      </SettingsCardBody>
    </CollapsibleCard>
  );
}

function NpmStatus({
  npm,
  choicePending,
}: {
  npm: NpmModel;
  choicePending: ReadonlySignal<boolean>;
}) {
  const connection = npm.connection.value;
  // Only a problem earns colour: a broken token, or a personal connection
  // whose automatic scans wait for the workspace choice. A valid or pending
  // validation is the expected state and reads as plain text.
  if (connection?.validationStatus === "invalid") return <Badge tone="critical">invalid</Badge>;
  if (connection && choicePending.value) return <Badge tone="medium">automatic scans off</Badge>;
  return <MonoLabel>{connection ? connection.validationStatus : "not connected"}</MonoLabel>;
}

function WorkspaceChoice({
  npm,
  organizations,
  onSwitchOrganization,
  primary,
  onKeepPersonal,
}: {
  npm: NpmModel;
  organizations: Organizations;
  onSwitchOrganization: (id: string) => Promise<void>;
  // Secondary while a broken token needs rotating first.
  primary: boolean;
  onKeepPersonal: () => void;
}) {
  const destinations = useComputed(() =>
    organizations.organizations.value.filter(
      (org) => !org.isPersonal && (org.role === "owner" || org.role === "admin"),
    ),
  );
  // Shared organizations take precedence: the choice starts on the first one
  // the caller manages, or on this workspace when it is the only option. The
  // section is remounted per active organization, so snapshots suffice here.
  const activeId = organizations.active.peek()?.id ?? "";
  const hasDestinations = destinations.peek().length > 0;
  const selected = useSignal(destinations.peek()[0]?.id ?? activeId);
  const choiceLabel = useComputed(() => {
    if (selected.value === activeId)
      return npm.connection.value
        ? "Enable automatic scans in personal workspace"
        : "Continue in personal workspace";
    const target = destinations.value.find((org) => org.id === selected.value);
    return target ? `Open ${target.name} settings` : "Choose an organization";
  });
  const disabled = useComputed(() => npm.busy.value || !selected.value);
  return (
    <div class="flex flex-col gap-3">
      <p class="m-0 text-[13px] leading-[1.55] text-ink max-w-[680px]">
        {hasDestinations
          ? "Automatic scans start after you choose where to review your npm packages. Existing reviews and credentials stay in this workspace."
          : "Automatic scans start after you confirm this personal workspace for your npm packages."}
      </p>
      {/* A one-option picker is noise: without a shared organization the
          button alone makes the choice. */}
      {hasDestinations ? (
        <Field label="Review workspace" for="npmReviewWorkspace" class="max-w-[420px]">
          <Select
            id="npmReviewWorkspace"
            value={selected}
            onChange={(id) => {
              selected.value = id;
            }}
            disabled={npm.busy}
          >
            {destinations.value.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
            <option value={activeId}>Keep in personal workspace</option>
          </Select>
        </Field>
      ) : null}
      <div>
        <Button
          variant={primary ? "primary" : "secondary"}
          disabled={disabled}
          onClick={async () => {
            const target = selected.peek();
            if (target === activeId) {
              // Recording consent never waits on npm: validation can fail for
              // reasons unrelated to the workspace choice.
              if (!npm.connection.peek() || (await npm.confirmPersonalOrganization()))
                onKeepPersonal();
            } else {
              npm.token.value = "";
              await onSwitchOrganization(target);
            }
          }}
        >
          {choiceLabel}
        </Button>
      </div>
    </div>
  );
}

function NpmTokenForm({ npm, onSubmit }: { npm: NpmModel; onSubmit: (event: Event) => void }) {
  const submitDisabled = useComputed(() => npm.busy.value || !npm.token.value.trim());
  const submitLabel = useComputed(() =>
    npm.status.value === "saving"
      ? "Saving…"
      : npm.status.value === "validating"
        ? "Checking…"
        : npm.connection.value
          ? "Rotate"
          : "Save",
  );
  // Rotating a working token is optional upkeep; only a missing or broken one
  // makes saving the section's next step.
  const submitVariant = useComputed(() => {
    const connection = npm.connection.value;
    return !connection || connection.validationStatus === "invalid" ? "primary" : "secondary";
  });
  const tokenLabel = useComputed(() => (npm.connection.value ? "New npm token" : "npm token"));
  const tokenPlaceholder = useComputed(() =>
    npm.connection.value ? "Paste a new read-only token" : "npm_... (read-only)",
  );
  return (
    <>
      <NpmTokenScopeGuide />

      <form
        class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)_auto] gap-3 items-end"
        onSubmit={onSubmit}
      >
        <Field label="Connection name" for="npmLabel">
          <Input
            id="npmLabel"
            type="text"
            value={npm.label}
            onInput={(e) => (npm.label.value = (e.target as HTMLInputElement).value)}
            disabled={npm.busy}
          />
        </Field>
        <Field label="Registry" for="npmRegistry">
          <Input
            id="npmRegistry"
            type="url"
            value={npm.registry}
            onInput={(e) => (npm.registry.value = (e.target as HTMLInputElement).value)}
            disabled={npm.busy}
          />
        </Field>
        <Field label={tokenLabel.value} for="npmToken">
          <Input
            id="npmToken"
            type="password"
            value={npm.token}
            placeholder={tokenPlaceholder}
            onInput={(e) => (npm.token.value = (e.target as HTMLInputElement).value)}
            disabled={npm.busy}
            autoComplete="off"
            spellcheck={false}
          />
        </Field>
        {/* h-[38px] matches the Input control height (13px × 1.55 line-height + padding + border); Button's leading-none makes it shorter otherwise. */}
        <Button
          type="submit"
          variant={submitVariant.value}
          disabled={submitDisabled}
          class="shrink-0 h-[38px]"
        >
          {submitLabel}
        </Button>
      </form>

      <Muted class="text-[12px]">Tokens are encrypted and validated before use.</Muted>
    </>
  );
}

function NpmTokenScopeGuide() {
  return (
    <Muted class="text-[13px] m-0 max-w-[680px]">
      Use a granular access token with <span class="text-ink">Read-only</span> access to the
      packages or scopes you want to review. Set <span class="text-ink">Organizations</span> to{" "}
      <span class="text-ink">No access</span>.{" "}
      <a
        class="underline"
        href="https://docs.npmjs.com/creating-and-viewing-access-tokens/"
        target="_blank"
        rel="noreferrer"
      >
        Create a token
      </a>
    </Muted>
  );
}

function MetadataField({ label, value }: { label: string; value: string }) {
  return (
    <div class="flex flex-col gap-1 min-w-0">
      <dt class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">{label}</dt>
      <dd class="font-mono text-[12px] text-ink-muted break-words m-0">{value}</dd>
    </div>
  );
}
