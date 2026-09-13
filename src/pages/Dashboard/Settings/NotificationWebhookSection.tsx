import { useComputed, useModel } from "@preact/signals";
import { Show, useLiveSignal } from "@preact/signals/utils";
import { NotificationWebhookModel } from "../../../models/notification-webhook";
import { Alert } from "../../../components/Alert";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { CollapsibleCard, SettingsCardBody } from "../../../components/Card";
import { Input } from "../../../components/Input";
import { LoadingLine, Muted } from "../../../components/Typography";

export function NotificationWebhookSection({
  webhook,
  canManage,
}: {
  webhook: ReturnType<typeof useModel<typeof NotificationWebhookModel.prototype>>;
  canManage: boolean;
}) {
  const manage = useLiveSignal(canManage);
  const saveDisabled = useComputed(() => !webhook.canSave.value);
  const enabled = useComputed(() => webhook.connection.value?.enabled === true);
  const hostname = useComputed(() => webhook.connection.value?.hostname ?? "");
  const saveLabel = useComputed(() =>
    webhook.connection.value ? "Replace webhook" : "Connect webhook",
  );
  const toggleLabel = useComputed(() =>
    enabled.value ? "Pause notifications" : "Resume notifications",
  );

  return (
    <CollapsibleCard
      title="webhook"
      defaultOpen
      aside={
        <Show when={webhook.connection} fallback={<Badge tone="neutral">not connected</Badge>}>
          <Show when={enabled} fallback={<Badge tone="neutral">paused</Badge>}>
            <Badge tone="ok">connected</Badge>
          </Show>
        </Show>
      }
    >
      <SettingsCardBody>
        <Muted class="text-[13px] m-0 max-w-[760px]">
          Send signed JSON notifications to your HTTPS endpoint for scan completions and
          release-gate reviews. Connect your own automation or notification service.
        </Muted>
        <Show
          when={webhook.loaded}
          fallback={<LoadingLine>loading webhook connection</LoadingLine>}
        >
          <Show
            when={webhook.connection}
            fallback={<Muted class="text-[13px] m-0">No webhook connected.</Muted>}
          >
            <Muted class="text-[13px] m-0">
              Destination: <span class="text-ink font-mono break-all">{hostname}</span>
            </Muted>
            <Show when={manage}>
              <div class="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={webhook.busy}
                  onClick={() => void webhook.test()}
                >
                  Send test
                </Button>
                <Button
                  variant="secondary"
                  disabled={webhook.busy}
                  onClick={() => void webhook.setEnabled(!enabled.peek())}
                >
                  {toggleLabel}
                </Button>
                <Button
                  variant="secondary"
                  disabled={webhook.busy}
                  onClick={() => void webhook.disconnect()}
                >
                  Disconnect webhook
                </Button>
              </div>
            </Show>
          </Show>
          <Show
            when={manage}
            fallback={
              <Muted class="text-[13px] m-0">
                An organization owner or admin can manage this webhook.
              </Muted>
            }
          >
            <form
              class="flex flex-col gap-3 max-w-[560px]"
              onSubmit={(event) => {
                event.preventDefault();
                void webhook.save();
              }}
            >
              <label class="flex flex-col gap-1.5 text-[13px]" for="notificationWebhookUrl">
                Endpoint URL
                <Input
                  id="notificationWebhookUrl"
                  type="url"
                  required
                  value={webhook.draftUrl}
                  disabled={webhook.busy}
                  placeholder="https://example.com/drydock"
                  autoComplete="off"
                  spellcheck={false}
                  onInput={(event) => {
                    webhook.draftUrl.value = event.currentTarget.value;
                  }}
                />
              </label>
              <label class="flex flex-col gap-1.5 text-[13px]" for="notificationWebhookSecret">
                Signing secret
                <Input
                  id="notificationWebhookSecret"
                  type="password"
                  required
                  minLength={32}
                  maxLength={512}
                  value={webhook.draftSecret}
                  disabled={webhook.busy}
                  autoComplete="new-password"
                  onInput={(event) => {
                    webhook.draftSecret.value = event.currentTarget.value;
                  }}
                />
              </label>
              <Muted class="text-[12px] m-0">
                Use a random secret of at least 32 characters and configure the same secret in your
                receiver to verify signatures. The URL and secret are encrypted and cannot be read
                back. Enter both to replace a connection.
              </Muted>
              <Button type="submit" class="self-start" disabled={saveDisabled}>
                {saveLabel}
              </Button>
            </form>
          </Show>
        </Show>
        <Show when={webhook.error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>
        <Show when={webhook.notice}>{(message) => <Alert tone="ok">{message}</Alert>}</Show>
      </SettingsCardBody>
    </CollapsibleCard>
  );
}
