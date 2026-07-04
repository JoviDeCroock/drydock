import { useModel } from "@preact/signals";
import { formatTimestamp } from "../../../lib/format";
import {
  ApiTokensModel,
  type ApiTokenScope,
  type PublicApiToken,
} from "../../../models/api-tokens";
import { Alert } from "../../../components/Alert";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { CollapsibleCard, SettingsCardBody } from "../../../components/Card";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { LoadingLine, Muted } from "../../../components/Typography";

export function ApiTokensSection({
  apiTokens,
  organizationId,
  canManage,
  defaultOpen = false,
}: {
  apiTokens: ReturnType<typeof useModel<typeof ApiTokensModel.prototype>>;
  organizationId: string | null;
  canManage: boolean;
  defaultOpen?: boolean;
}) {
  const tokens = apiTokens.tokens.value;
  const loaded = apiTokens.loaded.value;
  const busy = apiTokens.busy.value;
  const status = apiTokens.status.value;
  const error = apiTokens.error.value;
  const secret = apiTokens.createdSecret.value;
  const name = apiTokens.draftName.value;

  const onCreate = async (event: Event) => {
    event.preventDefault();
    await apiTokens.create(organizationId);
  };

  const onCopySecret = async () => {
    if (!secret) return;
    await navigator.clipboard?.writeText(secret).catch(() => undefined);
  };

  return (
    <CollapsibleCard
      title="programmatic access"
      defaultOpen={defaultOpen}
      aside={<Badge tone={tokens.length > 0 ? "info" : "neutral"}>{tokens.length} active</Badge>}
    >
      <SettingsCardBody>
        <Muted class="text-[13px] m-0 max-w-[760px]">
          Create organization-scoped bearer tokens for CI, scripts, and tooling. Tokens can read
          scans or create scans, but they cannot decide held releases or manage settings.
        </Muted>

        {!canManage ? (
          <Muted class="text-[13px] m-0">
            Only organization owners and admins can manage API tokens.
          </Muted>
        ) : !loaded ? (
          <LoadingLine>loading API tokens</LoadingLine>
        ) : tokens.length > 0 ? (
          <ul class="flex flex-col gap-2 m-0 p-0 list-none">
            {tokens.map((token: PublicApiToken) => (
              <ApiTokenRow
                key={token.id}
                token={token}
                busy={busy}
                revoking={status === "revoking"}
                onRevoke={() => void apiTokens.revoke(organizationId, token.id)}
              />
            ))}
          </ul>
        ) : (
          <Muted class="text-[13px] m-0">No active API tokens.</Muted>
        )}

        {secret ? (
          <Alert tone="warn">
            <div class="flex flex-col gap-2">
              <span>Copy this token now. Drydock will not show it again.</span>
              <div class="flex flex-col sm:flex-row gap-2 sm:items-center">
                <code class="font-mono text-[12px] break-all text-ink bg-bg border border-border rounded-md px-2 py-1.5">
                  {secret}
                </code>
                <Button variant="secondary" size="sm" onClick={onCopySecret}>
                  Copy
                </Button>
              </div>
            </div>
          </Alert>
        ) : null}

        {canManage ? (
          <form class="flex flex-col gap-3 border-t border-border pt-4" onSubmit={onCreate}>
            <div class="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
              <Field label="Token name" for="apiTokenName">
                <Input
                  id="apiTokenName"
                  type="text"
                  value={name}
                  onInput={(e) =>
                    (apiTokens.draftName.value = (e.target as HTMLInputElement).value)
                  }
                  disabled={busy || !organizationId}
                  autoComplete="off"
                />
              </Field>
              <Button
                type="submit"
                disabled={
                  busy ||
                  !organizationId ||
                  !name.trim() ||
                  (!apiTokens.draftScansRead.value && !apiTokens.draftScansWrite.value)
                }
                class="shrink-0"
              >
                {status === "creating" ? "Creating..." : "Create token"}
              </Button>
            </div>

            <div class="flex flex-col sm:flex-row gap-3">
              <ScopeCheckbox
                checked={apiTokens.draftScansRead.value}
                disabled={busy || !organizationId}
                label="Read scans"
                scope="scans:read"
                onChange={(checked) => (apiTokens.draftScansRead.value = checked)}
              />
              <ScopeCheckbox
                checked={apiTokens.draftScansWrite.value}
                disabled={busy || !organizationId}
                label="Create scans"
                scope="scans:write"
                onChange={(checked) => (apiTokens.draftScansWrite.value = checked)}
              />
            </div>
          </form>
        ) : null}

        {error ? <Alert tone="critical">{error}</Alert> : null}
      </SettingsCardBody>
    </CollapsibleCard>
  );
}

function ApiTokenRow({
  token,
  busy,
  revoking,
  onRevoke,
}: {
  token: PublicApiToken;
  busy: boolean;
  revoking: boolean;
  onRevoke: () => void;
}) {
  return (
    <li class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border border-border rounded-md px-3 py-3">
      <div class="flex flex-col gap-1 min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-[13px] font-medium text-ink break-words">{token.name}</span>
          {token.scopes.map((scope) => (
            <Badge key={scope} tone="neutral">
              {scope}
            </Badge>
          ))}
        </div>
        <div class="font-mono text-[11px] text-ink-subtle break-words">
          drydock_...{token.tokenLast4} - created {formatTimestamp(token.createdAt)} - last used{" "}
          {token.lastUsedAt ? formatTimestamp(token.lastUsedAt) : "never"}
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={onRevoke} disabled={busy} class="self-start">
        {revoking ? "Revoking..." : "Revoke"}
      </Button>
    </li>
  );
}

function ScopeCheckbox({
  checked,
  disabled,
  label,
  scope,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  scope: ApiTokenScope;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label class="flex items-start gap-2 text-[13px] text-ink-muted">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
      />
      <span class="flex flex-col gap-0.5">
        <span class="text-ink">{label}</span>
        <code class="font-mono text-[11px] text-ink-subtle">{scope}</code>
      </span>
    </label>
  );
}
