import { useModel } from "@preact/signals";
import { formatTimestamp } from "../../../lib/format";
import { NpmConnectionModel } from "../../../models/npm-connection";
import { Alert } from "../../../components/Alert";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { CollapsibleCard, SettingsCardBody } from "../../../components/Card";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { MonoLabel, Muted } from "../../../components/Typography";

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
          Add an npm token so reviews can fetch this organization's staged packages securely. We
          encrypt it, hide it after save, and use it only to retrieve release evidence.
        </Muted>

        {connection && connection.validationStatus === "invalid" ? (
          <Alert tone="critical">
            Drydock can no longer reach the staging registry with this token, so staged-release
            reviews are paused. Rotate the token below to resume.
          </Alert>
        ) : null}

        {connection ? (
          <dl class="grid grid-cols-2 sm:grid-cols-3 gap-x-8 gap-y-4 m-0">
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
              placeholder={
                connection ? "Paste a new read-only token to rotate" : "npm_... (read-only)"
              }
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

// The terms mirror the field names on npm's granular-token form, so a maintainer
// can read this top to bottom while filling that form in. Getting this wrong is
// the slowest part of onboarding: an over-scoped token is a needless credential
// risk, and an under-scoped one fails validation with a 403 they have to guess at.
function NpmTokenScopeGuide() {
  return (
    <div class="border border-border rounded-lg bg-surface-2 px-4 py-3 flex flex-col gap-3">
      <MonoLabel>token permissions to select</MonoLabel>
      <dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 m-0">
        <ScopeRow term="token type" detail="Granular access token" />
        <ScopeRow term="packages and scopes" detail="Read-only" />
        <ScopeRow
          term="select packages"
          detail="The packages you stage — or their scope, e.g. @nanostores"
        />
        <ScopeRow term="organizations" detail="No access" />
        <ScopeRow term="expiration" detail="Short, with planned rotation" />
      </dl>
      {/* Maintainers keep asking whether org-scoped packages need the Organizations
          permission. They do not — a scope is selectable under Packages and scopes. */}
      <Muted class="text-[12px] leading-[1.55] m-0">
        A scoped package such as{" "}
        <span class="font-mono text-[11px] text-ink-muted">@nanostores/i18n</span> is covered by
        picking the <span class="text-ink">@nanostores</span> scope under{" "}
        <span class="text-ink">Packages and scopes</span>; npm's separate{" "}
        <span class="text-ink">Organizations</span> permission grants member and settings
        management, which Drydock never reads. Read-only is all it uses — it lists staged releases
        and downloads the staged tarball, never publishes, and the token never reaches the sandbox
        that opens package bytes.
      </Muted>
      <p class="font-mono text-[11px] text-ink-subtle m-0">
        npmjs.com → Access Tokens → Generate New Token → Granular ·{" "}
        <a
          class="underline"
          href="https://docs.npmjs.com/creating-and-viewing-access-tokens/"
          target="_blank"
          rel="noreferrer"
        >
          npm docs
        </a>
      </p>
    </div>
  );
}

function ScopeRow({ term, detail }: { term: string; detail: string }) {
  // 160px holds the longest term ("packages and scopes") on one line at 11px mono
  // with 0.1em tracking; anything narrower wraps the label. On phones the term
  // stacks above the value instead — a fixed label column leaves the value too
  // narrow to read there.
  return (
    <div class="grid grid-cols-1 sm:grid-cols-[160px_minmax(0,1fr)] gap-x-3 gap-y-0.5 items-baseline text-[13px] min-w-0">
      <MonoLabel as="dt">{term}</MonoLabel>
      <dd class="m-0 text-ink-muted break-words">{detail}</dd>
    </div>
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
