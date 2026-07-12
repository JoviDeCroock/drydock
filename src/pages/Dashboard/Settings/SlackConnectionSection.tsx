import { useComputed, useModel, useSignal, useSignalEffect, type Signal } from "@preact/signals";
import { For, Show, useLiveSignal } from "@preact/signals/utils";
import {
  getMissingSlackChannelOption,
  SlackConnectionModel,
  type SlackChannelOption,
  type SlackConnection,
  type SlackTestResult,
} from "../../../models/slack-connection";
import { Alert } from "../../../components/Alert";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { CollapsibleCard, SettingsCardBody } from "../../../components/Card";
import { Input } from "../../../components/Input";
import { Select } from "../../../components/Select";
import { pushToast } from "../../../components/Toast";
import { LoadingLine, Muted } from "../../../components/Typography";

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
  onTest,
}: {
  slack: SlackModel;
  canManage: Signal<boolean>;
  connection: SlackConnection;
  onTest: () => Promise<void>;
}) {
  const channelSelectionMode = useSignal<"picker" | "manual">(
    connection.channelId && !connection.channelName ? "manual" : "picker",
  );
  const selectedChannelId = useSignal(connection.channelName ? (connection.channelId ?? "") : "");
  const manualChannelId = useSignal(
    connection.channelId && !connection.channelName ? connection.channelId : "",
  );
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
  const channelPickerPlaceholder = useComputed(() => {
    const loading = channelPickerLoading.value;
    const channels = slack.channels.value;
    if (loading) return "Loading channels…";
    return channels.length === 0 ? "No public channels found" : "Choose a channel…";
  });
  // A native select discards a value that has no matching option. Keep the
  // persisted destination mounted while the asynchronous channel list loads,
  // then let the matching Slack option replace it.
  const savedChannelOption = useComputed(() =>
    getMissingSlackChannelOption(slack.connection.value, slack.channels.value),
  );
  const selectedChannelLabel = useComputed(() => {
    const current = slack.connection.value;
    if (!current?.channelId) return null;
    return current.channelName ? `#${current.channelName}` : current.channelId;
  });
  const savingChannel = useComputed(() => slack.status.value === "savingChannel");
  const saveChannelLabel = useComputed(() =>
    savingChannel.value ? "Saving channel…" : "Save channel",
  );
  const testDisabled = useComputed(() => slack.busy.value || !slack.connection.value?.channelId);
  const testingLabel = useComputed(() => (slack.status.value === "testing" ? "Testing…" : "Test"));
  const disconnectLabel = useComputed(() =>
    slack.status.value === "disconnecting" ? "Disconnecting…" : "Disconnect",
  );
  const effectiveSelectionMode = useComputed(() => {
    const canUsePicker = showChannelPicker.value;
    const requestedMode = channelSelectionMode.value;
    return canUsePicker && requestedMode === "picker" ? "picker" : "manual";
  });
  const pickerModeSelected = useComputed(() => channelSelectionMode.value === "picker");
  const manualModeSelected = useComputed(() => channelSelectionMode.value === "manual");
  const saveChannelDisabled = useComputed(() => {
    const busy = slack.busy.value;
    const currentConnection = slack.connection.value;
    const mode = effectiveSelectionMode.value;
    const pickerChannelId = selectedChannelId.value;
    const manualId = manualChannelId.value.trim();
    const draftChannelId = mode === "picker" ? pickerChannelId : manualId;
    const currentMethod = currentConnection?.channelName ? "picker" : "manual";
    const unchanged =
      draftChannelId === (currentConnection?.channelId ?? "") && mode === currentMethod;
    return busy || !draftChannelId || unchanged;
  });
  const onSaveChannel = async (event: Event) => {
    event.preventDefault();
    if (effectiveSelectionMode.peek() === "picker") {
      const channelId = selectedChannelId.peek();
      if (channelId) await slack.selectChannel(channelId);
      return;
    }
    await slack.saveChannelId(manualChannelId.peek());
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
        when={canManage}
        fallback={<ReadOnlyChannelSelection channelLabel={selectedChannelLabel} />}
      >
        <div class="flex flex-col gap-3">
          <Show when={showChannelPicker}>
            <fieldset class="flex flex-col gap-2">
              <legend class={slackFieldLabelClass}>Channel selection</legend>
              <div class="flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-ink">
                <label class="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="slackChannelSelectionMode"
                    value="picker"
                    checked={pickerModeSelected}
                    onChange={() => (channelSelectionMode.value = "picker")}
                    disabled={slack.busy}
                    class="accent-accent"
                  />
                  Pick from Slack
                </label>
                <label class="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="slackChannelSelectionMode"
                    value="manual"
                    checked={manualModeSelected}
                    onChange={() => (channelSelectionMode.value = "manual")}
                    disabled={slack.busy}
                    class="accent-accent"
                  />
                  Enter a channel ID
                </label>
              </div>
              <Muted class="text-[12px] m-0">
                Choose one method. Only the visible destination will be saved.
              </Muted>
            </fieldset>
          </Show>

          <form class={slackFieldGridClass} onSubmit={onSaveChannel}>
            <Show
              when={() => effectiveSelectionMode.value === "picker"}
              fallback={
                <>
                  <label for="slackChannelId" class={slackFieldLabelClass}>
                    Channel ID
                  </label>
                  <div class={slackFieldControlClass}>
                    <Input
                      id="slackChannelId"
                      type="text"
                      value={manualChannelId}
                      placeholder="C0123ABCDEF"
                      onInput={(e) =>
                        (manualChannelId.value = (e.target as HTMLInputElement).value)
                      }
                      disabled={slack.busy}
                      spellcheck={false}
                    />
                  </div>
                </>
              }
            >
              <label for="slackChannel" class={slackFieldLabelClass}>
                Channel
              </label>
              <div class={slackFieldControlClass}>
                <Select
                  id="slackChannel"
                  value={selectedChannelId}
                  disabled={channelPickerDisabled}
                  onChange={(channelId) => (selectedChannelId.value = channelId)}
                >
                  <option value="" disabled>
                    {channelPickerPlaceholder}
                  </option>
                  <Show<SlackChannelOption | null> when={savedChannelOption}>
                    {(channel) => <option value={channel.id}>#{channel.name}</option>}
                  </Show>
                  <For each={slack.channels}>
                    {(channel: SlackChannelOption) => (
                      <option key={channel.id} value={channel.id}>
                        #{channel.name}
                      </option>
                    )}
                  </For>
                </Select>
              </div>
            </Show>
            <Button
              type="submit"
              variant="secondary"
              disabled={saveChannelDisabled}
              class="self-stretch whitespace-nowrap"
            >
              {saveChannelLabel}
            </Button>
            <Show when={() => effectiveSelectionMode.value === "manual"}>
              <Muted class="col-start-2 col-span-2 text-[12px] m-0">
                Use this when the channel is not listed or list permission is unavailable.
              </Muted>
            </Show>
          </form>
        </div>
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
