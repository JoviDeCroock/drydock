import { useEffect } from "preact/hooks";
import { computed, createModel, signal, useComputed, useModel, useSignal } from "@preact/signals";
import { For, Show } from "@preact/signals/utils";
import { apiFetch, apiJson, errorMessage } from "../../../models/api";
import { formatDateTime } from "../../../lib/format";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { CollapsibleCard, SettingsCardBody } from "../../../components/Card";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { Select } from "../../../components/Select";
import { LoadingLine, MonoDetail, MonoLabel, Muted } from "../../../components/Typography";

export interface PyPiProjectToken {
  id: string;
  projectName: string;
  indexOrigin: string;
  tokenFingerprint: string;
  tokenLast4: string | null;
  validatedAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type TokenActionResult = { ok: true } | { ok: false; message: string };

const BASE = "/api/v1/pypi-project-tokens";
const DEFAULT_INDEX = "https://pypi.org";

// The typed token is write-only: it is passed straight into a request body and
// never kept in model state, so nothing echoes it back after submit.
export const PyPiProjectTokensModel = createModel(() => {
  const tokens = signal<PyPiProjectToken[]>([]);
  const indexes = signal<string[]>([DEFAULT_INDEX]);
  const loaded = signal(false);
  const loadError = signal<string | null>(null);
  // The in-flight request, as `add` or `<action>:<token id>`.
  const pending = signal<string | null>(null);
  const busy = computed(() => pending.value !== null);

  function replace(token: PyPiProjectToken) {
    tokens.value = tokens.peek().map((row) => (row.id === token.id ? token : row));
  }

  async function run(key: string, action: () => Promise<void>): Promise<TokenActionResult> {
    pending.value = key;
    try {
      await action();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    } finally {
      pending.value = null;
    }
  }

  return {
    tokens,
    indexes,
    loaded,
    loadError,
    pending,
    busy,

    async load(): Promise<void> {
      loadError.value = null;
      try {
        const data = await apiFetch<{ tokens: PyPiProjectToken[]; indexes: string[] }>(BASE);
        tokens.value = data.tokens;
        if (data.indexes.length) indexes.value = data.indexes;
      } catch (err) {
        loadError.value = errorMessage(err);
      } finally {
        loaded.value = true;
      }
    },

    add(project: string, index: string, token: string): Promise<TokenActionResult> {
      return run("add", async () => {
        const data = await apiJson<{ token: PyPiProjectToken }>(BASE, {
          project: project.trim(),
          index,
          token: token.trim(),
        });
        tokens.value = [...tokens.peek(), data.token];
      });
    },

    rotate(id: string, token: string): Promise<TokenActionResult> {
      return run(`rotate:${id}`, async () => {
        const data = await apiJson<{ token: PyPiProjectToken }>(
          `${BASE}/${encodeURIComponent(id)}`,
          { token: token.trim() },
          { method: "PUT" },
        );
        replace(data.token);
      });
    },

    async validate(id: string): Promise<TokenActionResult> {
      let outcome: TokenActionResult = { ok: true };
      const result = await run(`check:${id}`, async () => {
        const data = await apiJson<{ token: PyPiProjectToken; ok: boolean; error?: string }>(
          `${BASE}/${encodeURIComponent(id)}/validate`,
          {},
        );
        replace(data.token);
        if (!data.ok) outcome = { ok: false, message: data.error ?? "Token check failed." };
      });
      return result.ok ? outcome : result;
    },

    remove(id: string): Promise<TokenActionResult> {
      return run(`remove:${id}`, async () => {
        await apiFetch<{ ok: true }>(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" });
        tokens.value = tokens.peek().filter((row) => row.id !== id);
      });
    },
  };
});

type TokensModel = InstanceType<typeof PyPiProjectTokensModel>;

function indexHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function PyPiProjectTokensSection({
  canManage,
  defaultOpen = false,
}: {
  canManage: boolean;
  defaultOpen?: boolean;
}) {
  const model = useModel(PyPiProjectTokensModel);
  const countLabel = useComputed(() => {
    const count = model.tokens.value.length;
    if (count === 0) return null;
    return `${count} ${count === 1 ? "project" : "projects"}`;
  });
  const empty = useComputed(
    () => model.loaded.value && !model.loadError.value && model.tokens.value.length === 0,
  );

  // The parent keys this section on the active organization, so a switch
  // remounts it and this load runs again for the new organization.
  useEffect(() => {
    void model.load();
  }, []);

  return (
    <CollapsibleCard
      title="pypi project tokens"
      defaultOpen={defaultOpen}
      aside={
        <Show<string | null> when={countLabel}>{(label) => <MonoLabel>{label}</MonoLabel>}</Show>
      }
    >
      <SettingsCardBody>
        <Muted class="text-[13px] m-0 max-w-[760px]">
          Preview of PyPI's draft Upload 2.0 (PEP 694). Store a token scoped to a single project and
          Drydock holds that project's staged release, publishes it when a person approves the
          workflow gate, and cancels it on rejection; the token never enters the review sandbox.
        </Muted>

        <Show when={model.loaded} fallback={<LoadingLine>loading PyPI tokens</LoadingLine>}>
          <Show when={empty}>
            <Muted class="text-[13px] m-0">No PyPI project tokens stored.</Muted>
          </Show>
          <TokenList model={model} canManage={canManage} />
        </Show>

        <Show<string | null> when={model.loadError}>
          {(message) => <Alert tone="critical">{message}</Alert>}
        </Show>

        {canManage ? (
          <AddTokenForm model={model} />
        ) : (
          <Muted class="text-[13px] m-0">
            Only organization owners and admins can change PyPI project tokens.
          </Muted>
        )}
      </SettingsCardBody>
    </CollapsibleCard>
  );
}

// Keyed map rather than `For`: a check or rotate replaces the token object, and
// `For` caches rows by identity, which would remount the row and drop the
// inline result it just showed.
function TokenList({ model, canManage }: { model: TokensModel; canManage: boolean }) {
  const tokens = model.tokens.value;
  if (tokens.length === 0) return null;
  return (
    <ul class="flex flex-col m-0 p-0 list-none">
      {tokens.map((token) => (
        <TokenRow key={token.id} model={model} token={token} canManage={canManage} />
      ))}
    </ul>
  );
}

function TokenRow({
  model,
  token,
  canManage,
}: {
  model: TokensModel;
  token: PyPiProjectToken;
  canManage: boolean;
}) {
  const rotating = useSignal(false);
  const confirmingRemove = useSignal(false);
  const draft = useSignal("");
  const check = useSignal<TokenActionResult | null>(null);
  const failure = useSignal<string | null>(null);
  const saveDisabled = useComputed(() => model.busy.value || draft.value.trim().length === 0);
  const checkLabel = useComputed(() =>
    model.pending.value === `check:${token.id}` ? "Checking…" : "Check",
  );
  const rotateLabel = useComputed(() => (rotating.value ? "Cancel rotate" : "Rotate"));
  const removeLabel = useComputed(() =>
    model.pending.value === `remove:${token.id}` ? "Removing…" : "Remove",
  );
  const saveLabel = useComputed(() =>
    model.pending.value === `rotate:${token.id}` ? "Saving…" : "Save",
  );
  const inputId = `pypiRotate-${token.id}`;

  const onCheck = async () => {
    check.value = null;
    failure.value = null;
    check.value = await model.validate(token.id);
  };

  const onRotate = async (event: Event) => {
    event.preventDefault();
    const value = draft.peek();
    draft.value = "";
    failure.value = null;
    check.value = null;
    const result = await model.rotate(token.id, value);
    if (result.ok) rotating.value = false;
    else failure.value = result.message;
  };

  const onRemove = async () => {
    failure.value = null;
    const result = await model.remove(token.id);
    if (!result.ok) {
      confirmingRemove.value = false;
      failure.value = result.message;
    }
  };

  return (
    <li class="border-t border-border first:border-t-0 py-3 flex flex-col gap-2">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0 flex flex-col gap-1">
          <code class="text-[13px] text-ink break-all">{token.projectName}</code>
          <MonoDetail
            parts={[
              indexHost(token.indexOrigin),
              token.tokenLast4 ? `…${token.tokenLast4}` : null,
              token.validatedAt === null
                ? "not validated"
                : `validated ${formatDateTime(token.validatedAt)}`,
              token.lastUsedAt === null
                ? "never used"
                : `last used ${formatDateTime(token.lastUsedAt)}`,
            ]}
          />
        </div>
        {canManage ? (
          <div class="flex flex-wrap items-center gap-1 shrink-0">
            <Show<TokenActionResult | null> when={check}>
              {(result) =>
                result.ok ? (
                  <span class="font-mono text-[12px] text-ok-text">token ok</span>
                ) : (
                  <Muted as="span" tone="danger" class="text-[12px]">
                    {result.message}
                  </Muted>
                )
              }
            </Show>
            <Show
              when={confirmingRemove}
              fallback={
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void onCheck()}
                    disabled={model.busy}
                  >
                    {checkLabel}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      rotating.value = !rotating.peek();
                      draft.value = "";
                    }}
                    disabled={model.busy}
                  >
                    {rotateLabel}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => (confirmingRemove.value = true)}
                    disabled={model.busy}
                  >
                    Remove
                  </Button>
                </>
              }
            >
              <span class="text-[13px] text-ink-muted">Remove this token?</span>
              <Button
                variant="danger"
                size="sm"
                onClick={() => void onRemove()}
                disabled={model.busy}
              >
                {removeLabel}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => (confirmingRemove.value = false)}
                disabled={model.busy}
              >
                Cancel
              </Button>
            </Show>
          </div>
        ) : null}
      </div>

      <Show when={rotating}>
        <form
          class="grid grid-cols-1 md:grid-cols-[minmax(0,360px)_auto] gap-3 items-end"
          onSubmit={(event) => void onRotate(event)}
        >
          <Field label="New token" for={inputId}>
            <Input
              id={inputId}
              type="password"
              mono
              value={draft}
              placeholder="pypi-…"
              onInput={(e) => (draft.value = (e.target as HTMLInputElement).value)}
              disabled={model.busy}
              autoComplete="off"
              spellcheck={false}
            />
          </Field>
          {/* h-[38px] matches the Input control height, like the sibling settings forms. */}
          <Button type="submit" variant="secondary" disabled={saveDisabled} class="h-[38px]">
            {saveLabel}
          </Button>
        </form>
      </Show>

      <Show<string | null> when={failure}>
        {(message) => (
          <Muted tone="danger" class="text-[12px] m-0">
            {message}
          </Muted>
        )}
      </Show>
    </li>
  );
}

function AddTokenForm({ model }: { model: TokensModel }) {
  const project = useSignal("");
  const index = useSignal(DEFAULT_INDEX);
  const secret = useSignal("");
  const failure = useSignal<string | null>(null);
  const addLabel = useComputed(() => (model.pending.value === "add" ? "Adding…" : "Add token"));
  const addDisabled = useComputed(
    () => model.busy.value || !project.value.trim() || !secret.value.trim(),
  );

  const onAdd = async (event: Event) => {
    event.preventDefault();
    const token = secret.peek();
    secret.value = "";
    failure.value = null;
    const result = await model.add(project.peek(), index.peek(), token);
    if (result.ok) project.value = "";
    else failure.value = result.message;
  };

  return (
    <form class="flex flex-col gap-3" onSubmit={(event) => void onAdd(event)}>
      <div class="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_180px_minmax(0,1fr)_auto] gap-3 items-end">
        <Field label="PyPI project" for="pypiTokenProject">
          <Input
            id="pypiTokenProject"
            type="text"
            value={project}
            placeholder="demo-package"
            onInput={(e) => (project.value = (e.target as HTMLInputElement).value)}
            disabled={model.busy}
            autoComplete="off"
            spellcheck={false}
          />
        </Field>
        <Field label="Index" for="pypiTokenIndex">
          <Select
            id="pypiTokenIndex"
            value={index}
            disabled={model.busy}
            onChange={(value) => (index.value = value)}
          >
            <For each={model.indexes}>
              {(origin: string) => (
                <option key={origin} value={origin}>
                  {indexHost(origin)}
                </option>
              )}
            </For>
          </Select>
        </Field>
        <Field label="Project-scoped token" for="pypiTokenSecret">
          <Input
            id="pypiTokenSecret"
            type="password"
            mono
            value={secret}
            placeholder="pypi-…"
            onInput={(e) => (secret.value = (e.target as HTMLInputElement).value)}
            disabled={model.busy}
            autoComplete="off"
            spellcheck={false}
          />
        </Field>
        {/* h-[38px] matches the Input control height, like the sibling settings forms. */}
        <Button type="submit" disabled={addDisabled} class="h-[38px] whitespace-nowrap">
          {addLabel}
        </Button>
      </div>
      <Show<string | null> when={failure}>
        {(message) => (
          <Muted tone="danger" class="text-[12px] m-0">
            {message}
          </Muted>
        )}
      </Show>
    </form>
  );
}
