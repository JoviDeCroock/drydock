import { useComputed, useModel, useSignal, useSignalEffect, type Signal } from "@preact/signals";
import { For, Show, useLiveSignal } from "@preact/signals/utils";
import {
  SlackConnectionModel,
  type SlackChannelOption,
  type SlackConnection,
  type SlackTestResult,
} from "../../../models/slack-connection";
import {
  Alert,
  Badge,
  Button,
  CollapsibleCard,
  Input,
  LoadingLine,
  Muted,
  pushToast,
  Select,
  SettingsCardBody,
} from "../../../components";

export function SlackConnectionSection({
  slack,
  canManage,
  defaultOpen = false,
}: {
  slack: ReturnType<typeof useModel<typeof SlackConnectionModel.prototype>>;
  canManage: boolean;
  defaultOpen?: boolean;
}) {
  const canManageSignal = useLiveSignal(canManage);
  const loadingConnection = useComputed(() => !slack.loaded.value);
  const aside = (
    <Show when={slack.connection} fallback={<Badge tone="neutral">not connected</Badge>}>
      <Badge tone="ok">connected</Badge>
    </Show>
  );

  const onSelectChannel = (channelId: string) => {
    if (channelId) void slack.selectChannel(channelId);
  };

  const onTest = async () => {
    const result = await slack.test();
    if (result) pushToast(result.message, result.ok ? "ok" : "critical");
  };

  // Load the channel list up front for managing users so the picker is ready
  // without an extra click. Guarded so it fires once: a finished load flips
  // channelsLoaded, a failure sets channelsError, and an in-flight request moves
  // status off "idle" — each stops the effect from re-firing. Signals are read
  // unconditionally so they are always tracked as dependencies.
  useSignalEffect(() => {
    const hasConnection = slack.connection.value !== null;
    const canListChannels = slack.connection.value?.canListChannels === true;
    const loadedChannels = slack.channelsLoaded.value;
    const channelsFailed = slack.channelsError.value !== null;
    const idle = slack.status.value === "idle";
    if (
      canManage &&
      hasConnection &&
      canListChannels &&
      !loadedChannels &&
      !channelsFailed &&
      idle
    ) {
      void slack.loadChannels();
    }
  });

  return (
    <CollapsibleCard title="slack" defaultOpen={defaultOpen} aside={aside}>
      <SettingsCardBody>
        <Muted class="text-[13px] m-0 max-w-[760px]">
          Connect a Slack workspace and choose one public channel for Drydock to post scan
          completions and release-gate reviews. The bot token is encrypted at rest and only ever
          posts to the channel you pick.
        </Muted>

        <Show<SlackTestResult | null> when={slack.callbackNotice}>
          {(notice) => <Alert tone={notice.ok ? "ok" : "critical"}>{notice.message}</Alert>}
        </Show>

        <Show
          when={loadingConnection}
          fallback={
            <Show
              when={slack.configured}
              fallback={
                <Muted class="text-[13px] m-0">
                  Slack is not configured on this Drydock instance. Ask the operator to add the
                  Slack app credentials.
                </Muted>
              }
            >
              <Show<SlackConnection | null>
                when={slack.connection}
                fallback={<DisconnectedSlackState slack={slack} canManage={canManageSignal} />}
              >
                {(connection) => (
                  <ConnectedSlackState
                    slack={slack}
                    canManage={canManageSignal}
                    connection={connection}
                    onSelectChannel={onSelectChannel}
                    onTest={onTest}
                  />
                )}
              </Show>
            </Show>
          }
        >
          <LoadingLine>loading Slack connection</LoadingLine>
        </Show>

        <Show<string | null> when={slack.error}>
          {(message) => <Alert tone="critical">{message}</Alert>}
        </Show>
      </SettingsCardBody>
    </CollapsibleCard>
  );
}

type SlackModel = ReturnType<typeof useModel<typeof SlackConnectionModel.prototype>>;
const slackFieldGridClass =
  "grid grid-cols-[76px_minmax(0,360px)_auto] items-center gap-x-3 gap-y-2";
const slackFieldLabelClass = "font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle";
const slackFieldControlClass = "min-w-0";

function ConnectedSlackState({
  slack,
  canManage,
  connection,
  onSelectChannel,
  onTest,
}: {
  slack: SlackModel;
  canManage: Signal<boolean>;
  connection: SlackConnection;
  onSelectChannel: (channelId: string) => void;
  onTest: () => Promise<void>;
}) {
  const manualChannelId = useSignal("");
  const canListChannels = useComputed(() => slack.connection.value?.canListChannels === true);
  const showChannelPicker = useComputed(
    () => canManage.value && canListChannels.value && slack.channelsError.value === null,
  );
  const channelPickerLoading = useComputed(
    () => showChannelPicker.value && !slack.channelsLoaded.value,
  );
  const channelPickerDisabled = useComputed(
    () => slack.busy.value || channelPickerLoading.value || slack.channels.value.length === 0,
  );
  const channelPickerValue = useComputed(() =>
    channelPickerLoading.value ? "" : (slack.connection.value?.channelId ?? ""),
  );
  const channelPickerPlaceholder = useComputed(() => {
    const loading = channelPickerLoading.value;
    const channels = slack.channels.value;
    if (loading) return "Loading channels…";
    return channels.length === 0 ? "No public channels found" : "Choose a channel…";
  });
  const selectedChannelLabel = useComputed(() => {
    const current = slack.connection.value;
    if (!current?.channelId) return null;
    return current.channelName ? `#${current.channelName}` : current.channelId;
  });
  const savingChannel = useComputed(() => slack.status.value === "savingChannel");
  const testDisabled = useComputed(() => slack.busy.value || !slack.connection.value?.channelId);
  const testingLabel = useComputed(() => (slack.status.value === "testing" ? "Testing…" : "Test"));
  const disconnectLabel = useComputed(() =>
    slack.status.value === "disconnecting" ? "Disconnecting…" : "Disconnect",
  );
  const manualChannelDisabled = useComputed(
    () => slack.busy.value || manualChannelId.value.trim().length === 0,
  );
  const onSaveManualChannel = async (event: Event) => {
    event.preventDefault();
    const channelId = manualChannelId.peek();
    const saved = await slack.saveChannelId(channelId);
    if (saved) manualChannelId.value = "";
  };

  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-[13px] text-ink break-all">
            {connection.teamName ?? "Slack workspace"}
          </span>
          <Show<string | null>
            when={selectedChannelLabel}
            fallback={<Badge tone="medium">no channel</Badge>}
          >
            {(channelLabel) => <Badge tone="info">{channelLabel}</Badge>}
          </Show>
        </div>
        <Show when={canManage}>
          <div class="flex items-center gap-1 shrink-0">
            <Button variant="ghost" size="sm" onClick={() => void onTest()} disabled={testDisabled}>
              {testingLabel}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void slack.disconnect()}
              disabled={slack.busy}
            >
              {disconnectLabel}
            </Button>
          </div>
        </Show>
      </div>

      <Show
        when={showChannelPicker}
        fallback={<ReadOnlyChannelSelection channelLabel={selectedChannelLabel} />}
      >
        <div class={slackFieldGridClass}>
          <label for="slackChannel" class={slackFieldLabelClass}>
            Channel
          </label>
          <div class={slackFieldControlClass}>
            <Select
              id="slackChannel"
              value={channelPickerValue}
              disabled={channelPickerDisabled}
              onChange={onSelectChannel}
            >
              <option value="" disabled>
                {channelPickerPlaceholder}
              </option>
              <For each={slack.channels}>
                {(channel: SlackChannelOption) => (
                  <option key={channel.id} value={channel.id}>
                    #{channel.name}
                  </option>
                )}
              </For>
            </Select>
          </div>
          <Show when={savingChannel}>
            <Muted class="text-[12px] m-0">Saving…</Muted>
          </Show>
        </div>
      </Show>

      <Show when={canManage}>
        <form class={slackFieldGridClass} onSubmit={onSaveManualChannel}>
          <label for="slackChannelId" class={slackFieldLabelClass}>
            Channel ID
          </label>
          <div class={slackFieldControlClass}>
            <Input
              id="slackChannelId"
              type="text"
              value={manualChannelId}
              placeholder="C0123ABCDEF"
              onInput={(e) => (manualChannelId.value = (e.target as HTMLInputElement).value)}
              disabled={slack.busy}
              spellcheck={false}
            />
          </div>
          <Button
            type="submit"
            variant="secondary"
            disabled={manualChannelDisabled}
            class="self-stretch"
          >
            Save
          </Button>
          <Muted class="col-start-2 col-span-2 text-[12px] m-0">
            Paste a channel ID when the channel is not listed or list permission is unavailable.
          </Muted>
        </form>
      </Show>

      <Show<string | null> when={slack.channelsError}>
        {(message) => <Alert tone="critical">{message}</Alert>}
      </Show>
    </div>
  );
}

function ReadOnlyChannelSelection({ channelLabel }: { channelLabel: Signal<string | null> }) {
  return (
    <Show<string | null>
      when={channelLabel}
      fallback={<Muted class="text-[13px] m-0">No channel selected yet.</Muted>}
    >
      {(label) => (
        <Muted class="text-[13px] m-0">
          Posting to <span class="text-ink">{label}</span>.
        </Muted>
      )}
    </Show>
  );
}

function DisconnectedSlackState({
  slack,
  canManage,
}: {
  slack: SlackModel;
  canManage: Signal<boolean>;
}) {
  const connectLabel = useComputed(() =>
    slack.status.value === "connecting" ? "Redirecting to Slack…" : "Add to Slack",
  );

  return (
    <div class="flex flex-col gap-3">
      <Muted class="text-[13px] m-0">No Slack workspace connected.</Muted>
      <Show when={canManage}>
        <Button onClick={() => void slack.connect()} disabled={slack.busy} class="self-start">
          {connectLabel}
        </Button>
      </Show>
    </div>
  );
}
