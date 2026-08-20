import { useComputed, useModel, useSignalEffect } from "@preact/signals";
import { For, Show } from "@preact/signals/utils";
import { AtpmPublishersModel, type PublicAtpmPublisher } from "../../../models/atpm-publishers";
import { Alert } from "../../../components/Alert";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import {
  CollapsibleCard,
  SettingsCardBody,
  SettingsCardForm,
  SettingsCardHeader,
  SettingsCardListItem,
} from "../../../components/Card";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { MonoDetail, Muted } from "../../../components/Typography";

/**
 * Connected atpm publishing accounts.
 *
 * The copy is deliberate about what signing in does and does not do. Every
 * other integration in this page hands Drydock a credential; this one hands it
 * nothing, because atpm release candidates are public records and Drydock never
 * writes to a publisher's repository. What the sign-in settles is ownership —
 * whose releases belong in this dashboard — and saying so plainly is the
 * difference between a reasonable request and an alarming one.
 */
export function AtpmPublisherSection({
  atpm,
  canManage,
  defaultOpen = false,
}: {
  atpm: ReturnType<typeof useModel<typeof AtpmPublishersModel.prototype>>;
  canManage: boolean;
  defaultOpen?: boolean;
}) {
  useSignalEffect(() => {
    if (!atpm.loaded.value) void atpm.load();
  });

  const count = useComputed(() => atpm.publishers.value.length);
  const aside = useComputed(() =>
    count.value ? (
      <Badge tone="ok">{count.value} connected</Badge>
    ) : (
      <Badge tone="neutral">not connected</Badge>
    ),
  );

  return (
    <CollapsibleCard title="atpm publishing accounts" aside={aside} defaultOpen={defaultOpen}>
      <SettingsCardBody>
        <Muted class="m-0 text-[13px] leading-[1.6]">
          Connect the AT Protocol account you publish from and Drydock reviews its staged releases
          as they appear. Signing in proves the account is yours — Drydock keeps no token from it,
          reads only records that are already public, and never publishes on your behalf.
        </Muted>

        <Show when={atpm.error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>
        <Show when={atpm.notice}>{(message) => <Alert tone="ok">{message}</Alert>}</Show>

        {canManage ? (
          <SettingsCardForm
            onSubmit={(event: Event) => {
              event.preventDefault();
              void atpm.connect();
            }}
          >
            <Field label="Handle or DID" for="atpmPublisher">
              <Input
                id="atpmPublisher"
                placeholder="@handle.example"
                value={atpm.publisherInput.value}
                disabled={atpm.busy.value}
                onInput={(event) => {
                  atpm.publisherInput.value = (event.currentTarget as HTMLInputElement).value;
                }}
              />
              <Muted class="text-[12px] mt-1.5">
                You will be sent to your own server to sign in — Drydock never sees your password,
                and the account you sign in as has to be the one you typed here.
              </Muted>
            </Field>
            <div class="flex items-center gap-3">
              <Button type="submit" disabled={!atpm.canConnect.value}>
                {atpm.status.value === "connecting" ? "Redirecting…" : "Connect account"}
              </Button>
            </div>
          </SettingsCardForm>
        ) : null}
      </SettingsCardBody>

      <Show when={useComputed(() => count.value > 0)}>
        <div>
          <SettingsCardHeader title="Connected accounts" />
          <ul class="m-0 p-0 list-none">
            <For each={atpm.publishers}>
              {(publisher: PublicAtpmPublisher) => (
                <PublisherRow
                  key={publisher.id}
                  publisher={publisher}
                  atpm={atpm}
                  canManage={canManage}
                />
              )}
            </For>
          </ul>
        </div>
      </Show>
    </CollapsibleCard>
  );
}

function PublisherRow({
  publisher,
  atpm,
  canManage,
}: {
  publisher: PublicAtpmPublisher;
  atpm: ReturnType<typeof useModel<typeof AtpmPublishersModel.prototype>>;
  canManage: boolean;
}) {
  return (
    <SettingsCardListItem>
      <div class="flex flex-col gap-1.5 min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-mono text-[14px] font-medium">
            {publisher.handle ? `@${publisher.handle}` : publisher.did}
          </span>
          <Badge tone="ok">verified</Badge>
        </div>
        <MonoDetail
          parts={[
            // The DID is what everything keys on, so it is shown even when a
            // friendlier handle is available: a handle can move accounts.
            <span key="did">{publisher.did}</span>,
            <span key="pds">{new URL(publisher.pds).host}</span>,
            publisher.lastSweptAt ? (
              <span key="swept">checked {relativeTime(publisher.lastSweptAt)}</span>
            ) : null,
          ]}
        />
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <Button
          variant="secondary"
          size="sm"
          disabled={atpm.busy.value}
          onClick={() => void atpm.discover(publisher.id)}
        >
          {atpm.status.value === "discovering" ? "Checking…" : "Check now"}
        </Button>
        {canManage ? (
          <Button
            variant="danger"
            size="sm"
            disabled={atpm.busy.value}
            onClick={() => void atpm.remove(publisher.id)}
          >
            Remove
          </Button>
        ) : null}
      </div>
    </SettingsCardListItem>
  );
}

function relativeTime(iso: string): string {
  const elapsedMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "just now";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
