import { useModel } from "@preact/signals";
import { formatTimestamp } from "../../../lib/format";
import { NpmConnectionModel } from "../../../models/npm-connection";
import {
  Alert,
  Badge,
  Button,
  CollapsibleCard,
  Field,
  Input,
  LinkButton,
  Muted,
} from "../../../components";

export function NpmConnectionSection({
  npm,
}: {
  npm: ReturnType<typeof useModel<typeof NpmConnectionModel.prototype>>;
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
      <div class="p-5 flex flex-col gap-5">
        <Muted class="text-[13px] m-0 max-w-[760px]">
          Add an organization npm token so reviews can fetch staged packages securely. We encrypt
          it, hide it after save, and use it only to retrieve release evidence.
        </Muted>

        {connection ? (
          <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-x-6 gap-y-2 border-y border-border py-3">
            <CompactMetadataRow label="label" value={connection.label} />
            <CompactMetadataRow label="registry" value={connection.registryUrl} />
            <CompactMetadataRow label="token" value={`•••• ${connection.tokenLast4 || "stored"}`} />
            <CompactMetadataRow
              label="validated"
              value={connection.validatedAt ? formatTimestamp(connection.validatedAt) : "not yet"}
            />
            <CompactMetadataRow
              label="last used"
              value={connection.lastUsedAt ? formatTimestamp(connection.lastUsedAt) : "never"}
            />
          </div>
        ) : null}

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
              placeholder={connection ? "Paste a new token to rotate" : "npm_..."}
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

        <Muted class="text-xs">
          After save, Drydock validates the token before any review uses it.
        </Muted>

        {error ? <Alert tone="critical">{error}</Alert> : null}

        {connection ? (
          <div class="flex items-center justify-between border-t border-border pt-4 gap-3">
            <LinkButton variant="ghost" size="sm" href="/dashboard">
              Back to dashboard
            </LinkButton>
            <Button variant="danger" size="sm" onClick={() => void npm.remove()} disabled={busy}>
              {status === "deleting" ? "Removing…" : "Disconnect npm"}
            </Button>
          </div>
        ) : null}
      </div>
    </CollapsibleCard>
  );
}

function CompactMetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div class="grid grid-cols-[92px_minmax(0,1fr)] gap-3 text-[13px] min-w-0">
      <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">{label}</span>
      <code class="text-xs text-ink-muted break-all">{value}</code>
    </div>
  );
}
