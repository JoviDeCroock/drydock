import { useComputed, useModel, useSignalEffect, type Signal } from "@preact/signals";
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
  LoadingLine,
  Muted,
  pushToast,
  Select,
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
    const loadedChannels = slack.channelsLoaded.value;
    const channelsFailed = slack.channelsError.value !== null;
    const idle = slack.status.value === "idle";
    if (canManage && hasConnection && !loadedChannels && !channelsFailed && idle) {
      void slack.loadChannels();
    }
  });

  return (
    <CollapsibleCard title="slack" defaultOpen={defaultOpen} aside={aside}>
      <div class="p-5 flex flex-col gap-5">
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
      </div>
    </CollapsibleCard>
  );
}

type SlackModel = ReturnType<typeof useModel<typeof SlackConnectionModel.prototype>>;

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
  const showChannelPicker = useComputed(
    () => canManage.value && slack.channelsError.value === null,
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
  const selectedChannelName = useComputed(() => slack.connection.value?.channelName ?? null);
  const savingChannel = useComputed(() => slack.status.value === "savingChannel");
  const testDisabled = useComputed(() => slack.busy.value || !slack.connection.value?.channelId);
  const testingLabel = useComputed(() => (slack.status.value === "testing" ? "Testing…" : "Test"));
  const disconnectLabel = useComputed(() =>
    slack.status.value === "disconnecting" ? "Disconnecting…" : "Disconnect",
  );

  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-[13px] text-ink break-all">
            {connection.teamName ?? "Slack workspace"}
          </span>
          <Show<string | null>
            when={selectedChannelName}
            fallback={<Badge tone="medium">no channel</Badge>}
          >
            {(channelName) => <Badge tone="info">#{channelName}</Badge>}
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
        fallback={<ReadOnlyChannelSelection channelName={selectedChannelName} />}
      >
        <div class="flex flex-wrap items-center gap-3">
          <label
            for="slackChannel"
            class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle shrink-0"
          >
            Channel
          </label>
          <div class="flex-1 min-w-[200px] max-w-[360px]">
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

      <Show<string | null> when={slack.channelsError}>
        {(message) => <Alert tone="critical">{message}</Alert>}
      </Show>
    </div>
  );
}

function ReadOnlyChannelSelection({ channelName }: { channelName: Signal<string | null> }) {
  return (
    <Show<string | null>
      when={channelName}
      fallback={<Muted class="text-[13px] m-0">No channel selected yet.</Muted>}
    >
      {(name) => (
        <Muted class="text-[13px] m-0">
          Posting to <span class="text-ink">#{name}</span>.
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
