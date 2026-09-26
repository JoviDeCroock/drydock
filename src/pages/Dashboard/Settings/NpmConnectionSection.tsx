import { OrganizationModel } from "../../../models/organization";
import { Select } from "../../../components/Select";
import { useModel, useSignal, useComputed } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { formatTimestamp } from "../../../lib/format";
import { NpmConnectionModel, type PublicNpmConnection } from "../../../models/npm-connection";
import { Alert } from "../../../components/Alert";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { CollapsibleCard, SettingsCardBody } from "../../../components/Card";
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

  const onSave = async (event: Event) => {
    event.preventDefault();
    const active = organizations.active.peek();
    if (!active || (needsChoice.peek() && !npm.connection.peek())) return;
    // Rotating a token while the choice is still pending is not consent.
    await npm.save(active.isPersonal && !needsChoice.peek());
  };

  return (
    <CollapsibleCard title="npm access" defaultOpen={defaultOpen} aside={<NpmStatus npm={npm} />}>
      <SettingsCardBody>
        <Muted class="text-[13px] m-0 max-w-[760px]">
          Connect npm to review your organization's staged packages.
        </Muted>

        <Show when={() => npm.connection.value?.validationStatus === "invalid"}>
          <Alert tone="critical">
            Drydock can no longer reach the staging registry with this token, so staged-release
            reviews are paused. Rotate the token below to resume.
          </Alert>
        </Show>

        <Show when={needsChoice}>
          {() => (
            <WorkspaceChoice
              npm={npm}
              organizations={organizations}
              onSwitchOrganization={onSwitchOrganization}
              onKeepPersonal={() => {
                personalChosen.value = true;
              }}
            />
          )}
        </Show>

        <Show when={showForm}>{() => <NpmTokenForm npm={npm} onSubmit={onSave} />}</Show>

        <Show when={npm.error}>{(error) => <Alert tone="critical">{error}</Alert>}</Show>

        <Show<PublicNpmConnection | null> when={npm.connection}>
          {(connection) => (
            <>
              <details class="text-[13px] text-ink-muted">
                <summary class="cursor-pointer focus-visible:outline-accent">
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
                      connection.validatedAt ? formatTimestamp(connection.validatedAt) : "not yet"
                    }
                  />
                  <MetadataField
                    label="last used"
                    value={connection.lastUsedAt ? formatTimestamp(connection.lastUsedAt) : "never"}
                  />
                </dl>
              </details>
              <div class="flex items-center justify-end border-t border-border pt-4 gap-3">
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => void npm.remove()}
                  disabled={npm.busy}
                >
                  <Show when={() => npm.status.value === "deleting"} fallback="Disconnect npm">
                    Removing…
                  </Show>
                </Button>
              </div>
            </>
          )}
        </Show>
      </SettingsCardBody>
    </CollapsibleCard>
  );
}

function NpmStatus({ npm }: { npm: NpmModel }) {
  const connection = npm.connection.value;
  // Only a broken token earns colour; a valid or pending connection is the
  // expected state and reads as plain text.
  return connection?.validationStatus === "invalid" ? (
    <Badge tone="critical">invalid</Badge>
  ) : (
    <MonoLabel>{connection ? connection.validationStatus : "not connected"}</MonoLabel>
  );
}

function WorkspaceChoice({
  npm,
  organizations,
  onSwitchOrganization,
  onKeepPersonal,
}: {
  npm: NpmModel;
  organizations: Organizations;
  onSwitchOrganization: (id: string) => Promise<void>;
  onKeepPersonal: () => void;
}) {
  const destinations = useComputed(() =>
    organizations.organizations.value.filter(
      (org) => !org.isPersonal && (org.role === "owner" || org.role === "admin"),
    ),
  );
  // Shared organizations take precedence: the choice starts on the first one
  // the caller manages. The section is remounted per active organization, so a
  // snapshot of the active id is enough here.
  const activeId = organizations.active.peek()?.id ?? "";
  const selected = useSignal(destinations.peek()[0]?.id ?? "");
  const choiceLabel = useComputed(() =>
    selected.value === activeId
      ? npm.connection.value
        ? "Enable automatic scans in personal workspace"
        : "Continue in personal workspace"
      : `Open ${destinations.value.find((org) => org.id === selected.value)?.name ?? "organization"} settings`,
  );
  const disabled = useComputed(() => npm.busy.value || !selected.value);
  return (
    <div class="flex flex-col gap-3">
      <Alert tone="info">
        Choose where npm packages will be managed before enabling automatic scans.
        <Show when={npm.connection}>
          {" "}
          Automatic scans are waiting for this choice; you can still review stages manually and
          rotate or disconnect the token below.
        </Show>{" "}
        Existing reviews and credentials stay in this workspace.
      </Alert>
      <Select
        aria-label="npm connection organization"
        value={selected}
        onChange={(id) => {
          selected.value = id;
        }}
        disabled={npm.busy}
      >
        <option value="" disabled>
          Choose organization
        </option>
        {destinations.value.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
        <option value={activeId}>Keep in personal workspace</option>
      </Select>
      <Button
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
        <Button type="submit" disabled={submitDisabled} class="shrink-0 h-[38px]">
          {submitLabel}
        </Button>
      </form>

      <Muted class="text-xs">Tokens are encrypted and validated before use.</Muted>
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
      <dd class="font-mono text-xs text-ink-muted break-words m-0">{value}</dd>
    </div>
  );
}
