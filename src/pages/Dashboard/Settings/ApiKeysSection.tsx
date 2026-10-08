import { useModel } from "@preact/signals";
import { ApiKeysModel, type ApiKeyAccess, type OrganizationApiKey } from "../../../models/api-keys";
import { Alert } from "../../../components/Alert";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { CollapsibleCard, SettingsCardBody } from "../../../components/Card";
import { CopyButton } from "../../../components/CopyButton";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { Select } from "../../../components/Select";
import { LoadingLine, MonoLabel, Muted } from "../../../components/Typography";
import { formatDateTime } from "../../../lib/format";

const ACCESS_LABELS: Record<ApiKeyAccess, string> = {
  read: "Read only",
  scan: "Read and start reviews",
};

export function ApiKeysSection({
  apiKeys,
  defaultOpen = false,
}: {
  apiKeys: ReturnType<typeof useModel<typeof ApiKeysModel.prototype>>;
  defaultOpen?: boolean;
}) {
  const list = apiKeys.keys.value;
  const status = apiKeys.status.value;
  const busy = apiKeys.busy.value;
  const error = apiKeys.error.value;
  const revealed = apiKeys.revealed.value;
  const atLimit = apiKeys.atLimit.value;
  const draftName = apiKeys.draftName.value;
  const draftAccess = apiKeys.draftAccess.value;

  const onCreate = async (event: Event) => {
    event.preventDefault();
    await apiKeys.create();
  };

  return (
    <CollapsibleCard
      title="API keys"
      defaultOpen={defaultOpen}
      aside={
        list.length ? (
          <MonoLabel>
            {list.length} {list.length === 1 ? "key" : "keys"}
          </MonoLabel>
        ) : null
      }
    >
      <SettingsCardBody>
        <Muted class="text-[13px] m-0 max-w-[760px]">
          Keys for scripts and the Drydock CLI. A key reads this organization's reviews, reports,
          release receipts, and gate status. A key created with "Read and start reviews" can also
          start reviews and check npm. No key can record a decision or change settings. Keys expire,
          and a key is deleted when the member who created it leaves the organization.
        </Muted>

        {revealed ? (
          <Alert tone="warn">
            <div class="flex flex-col gap-2">
              <span>
                Copy <strong>{revealed.name}</strong> now. Drydock stores only a hash of it and
                cannot show it again.
              </span>
              <div class="flex items-center gap-2 min-w-0">
                <code class="text-[13px] break-all select-all min-w-0">{revealed.token}</code>
                <CopyButton text={revealed.token} label="Copy key" />
              </div>
              <div>
                <Button variant="ghost" size="sm" onClick={() => apiKeys.dismissRevealed()}>
                  I've saved it
                </Button>
              </div>
            </div>
          </Alert>
        ) : null}

        {!apiKeys.loaded.value ? (
          <LoadingLine>loading API keys</LoadingLine>
        ) : list.length > 0 ? (
          <ul class="flex flex-col gap-3 m-0 p-0 list-none">
            {list.map((key: OrganizationApiKey) => (
              <ApiKeyRow
                key={key.id}
                apiKey={key}
                busy={busy}
                revoking={status === "revoking"}
                onRevoke={() => void apiKeys.revoke(key.id)}
              />
            ))}
          </ul>
        ) : (
          <Muted class="text-[13px] m-0">No API keys yet.</Muted>
        )}

        <form
          class="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-3 items-end"
          onSubmit={onCreate}
        >
          <Field label="Key name" for="apiKeyName">
            <Input
              id="apiKeyName"
              value={draftName}
              placeholder="release-ci"
              maxLength={64}
              onInput={(e) => (apiKeys.draftName.value = (e.target as HTMLInputElement).value)}
              disabled={busy || atLimit}
              autoComplete="off"
              spellcheck={false}
            />
          </Field>
          <Field label="Expires after" for="apiKeyExpiry">
            <Select
              id="apiKeyExpiry"
              value={String(apiKeys.draftExpiryDays.value)}
              onChange={(value) => (apiKeys.draftExpiryDays.value = Number(value))}
              disabled={busy || atLimit}
            >
              {apiKeys.expiryChoices.value.map((days: number) => (
                <option key={days} value={String(days)}>
                  {days} days
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Access" for="apiKeyAccess">
            <Select
              id="apiKeyAccess"
              value={draftAccess}
              onChange={(value) => (apiKeys.draftAccess.value = value as ApiKeyAccess)}
              disabled={busy || atLimit}
            >
              {(Object.keys(ACCESS_LABELS) as ApiKeyAccess[]).map((access) => (
                <option key={access} value={access}>
                  {ACCESS_LABELS[access]}
                </option>
              ))}
            </Select>
          </Field>
          {/* h-[38px] matches the Input control height, like the sibling settings forms. */}
          <Button
            type="submit"
            disabled={busy || atLimit || !draftName.trim()}
            class="shrink-0 h-[38px]"
          >
            {status === "creating" ? "Creating…" : "Create key"}
          </Button>
        </form>
        {draftAccess === "scan" && !atLimit ? (
          <Muted class="text-[13px] m-0">
            This key can also start reviews and check npm, as the member who creates it. It never
            approves a release.
          </Muted>
        ) : null}
        {atLimit ? (
          <Muted class="text-[13px] m-0">
            This organization holds the maximum of {apiKeys.limit.value} keys. Revoke one to create
            another.
          </Muted>
        ) : null}

        {error ? <Alert tone="critical">{error}</Alert> : null}
      </SettingsCardBody>
    </CollapsibleCard>
  );
}

function ApiKeyRow({
  apiKey,
  busy,
  revoking,
  onRevoke,
}: {
  apiKey: OrganizationApiKey;
  busy: boolean;
  revoking: boolean;
  onRevoke: () => void;
}) {
  const expired = new Date(apiKey.expiresAt).getTime() <= Date.now();
  const creator = apiKey.createdBy.email ?? apiKey.createdBy.name ?? "a former member";
  return (
    <li class="flex items-start justify-between gap-3">
      <div class="flex flex-col gap-1 min-w-0">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-[13px] font-medium text-ink truncate">{apiKey.name}</span>
          <code class="text-[12px] text-ink-muted">{apiKey.prefix}…</code>
          {expired ? <Badge tone="medium">expired</Badge> : null}
        </div>
        <Muted class="text-[12px] m-0">
          {apiKey.access === "scan" ? "can start reviews" : "read only"} · created by {creator} ·{" "}
          {expired ? "expired" : "expires"} {formatDateTime(apiKey.expiresAt)} ·{" "}
          {apiKey.lastUsedAt ? `last used ${formatDateTime(apiKey.lastUsedAt)}` : "never used"}
        </Muted>
      </div>
      <Button variant="ghost" size="sm" onClick={onRevoke} disabled={busy} class="shrink-0">
        {revoking ? "Revoking…" : "Revoke"}
      </Button>
    </li>
  );
}
