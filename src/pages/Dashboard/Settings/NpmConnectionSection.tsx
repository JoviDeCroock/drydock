import { useModel } from "@preact/signals";
import { formatTimestamp } from "../../../lib/format";
import { NpmConnectionModel } from "../../../models/npm-connection";
import { Alert } from "../../../components/Alert";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { CollapsibleCard, SettingsCardBody } from "../../../components/Card";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { Muted } from "../../../components/Typography";

export function NpmConnectionSection({
  npm,
  defaultOpen = false,
}: {
  npm: ReturnType<typeof useModel<typeof NpmConnectionModel.prototype>>;
  defaultOpen?: boolean;
}) {
  const connection = npm.connection.value;
  const status = npm.status.value;
  const busy = npm.busy.value;
  const validated = npm.validated.value;
  const token = npm.token.value;
  const label = npm.label.value;
  const registry = npm.registry.value;
  const error = npm.error.value;

  const onSave = async (event: Event) => {
    event.preventDefault();
    await npm.save();
  };

  return (
    <CollapsibleCard
      title="npm access"
      defaultOpen={defaultOpen}
      aside={
        connection ? (
          <Badge
            tone={
              validated ? "ok" : connection.validationStatus === "invalid" ? "critical" : "info"
            }
          >
            {connection.validationStatus}
          </Badge>
        ) : (
          <Badge tone="info">not connected</Badge>
        )
      }
    >
      <SettingsCardBody>
        <Muted class="text-[13px] m-0 max-w-[760px]">
          Connect npm to review your organization's staged packages.
        </Muted>

        {connection && connection.validationStatus === "invalid" ? (
          <Alert tone="critical">
            Drydock can no longer reach the staging registry with this token, so staged-release
            reviews are paused. Rotate the token below to resume.
          </Alert>
        ) : null}

        <NpmTokenScopeGuide />

        <form
          class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)_auto] gap-3 items-end"
          onSubmit={onSave}
        >
          <Field label="Connection name" for="npmLabel">
            <Input
              id="npmLabel"
              type="text"
              value={label}
              onInput={(e) => (npm.label.value = (e.target as HTMLInputElement).value)}
              disabled={busy}
            />
          </Field>
          <Field label="Registry" for="npmRegistry">
            <Input
              id="npmRegistry"
              type="url"
              value={registry}
              onInput={(e) => (npm.registry.value = (e.target as HTMLInputElement).value)}
              disabled={busy}
            />
          </Field>
          <Field label={connection ? "New npm token" : "npm token"} for="npmToken">
            <Input
              id="npmToken"
              type="password"
              value={token}
              placeholder={connection ? "Paste a new read-only token" : "npm_... (read-only)"}
              onInput={(e) => (npm.token.value = (e.target as HTMLInputElement).value)}
              disabled={busy}
              autoComplete="off"
              spellcheck={false}
            />
          </Field>
          {/* h-[38px] matches the Input control height (13px × 1.55 line-height + padding + border); Button's leading-none makes it shorter otherwise. */}
          <Button type="submit" disabled={busy || !token.trim()} class="shrink-0 h-[38px]">
            {status === "saving"
              ? "Saving…"
              : status === "validating"
                ? "Checking…"
                : connection
                  ? "Rotate"
                  : "Save"}
          </Button>
        </form>

        <Muted class="text-xs">Tokens are encrypted and validated before use.</Muted>

        {error ? <Alert tone="critical">{error}</Alert> : null}

        {connection ? (
          <details class="text-[13px] text-ink-muted">
            <summary class="cursor-pointer focus-visible:outline-accent">
              Connection details
            </summary>
            <dl class="grid grid-cols-1 sm:grid-cols-3 gap-x-8 gap-y-4 m-0 pt-4">
              <MetadataField label="label" value={connection.label} />
              <MetadataField label="registry" value={connection.registryUrl} />
              <MetadataField label="token" value={`•••• ${connection.tokenLast4 || "stored"}`} />
              <MetadataField
                label="validated"
                value={connection.validatedAt ? formatTimestamp(connection.validatedAt) : "not yet"}
              />
              <MetadataField
                label="last used"
                value={connection.lastUsedAt ? formatTimestamp(connection.lastUsedAt) : "never"}
              />
            </dl>
          </details>
        ) : null}

        {connection ? (
          <div class="flex items-center justify-end border-t border-border pt-4 gap-3">
            <Button variant="danger" size="sm" onClick={() => void npm.remove()} disabled={busy}>
              {status === "deleting" ? "Removing…" : "Disconnect npm"}
            </Button>
          </div>
        ) : null}
      </SettingsCardBody>
    </CollapsibleCard>
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
