import { useModel, useSignalEffect } from "@preact/signals";
import { SlackConnectionModel, type SlackChannelOption } from "../../../models/slack-connection";
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
  const configured = slack.configured.value;
  const connection = slack.connection.value;
  const status = slack.status.value;
  const busy = slack.busy.value;
  const loaded = slack.loaded.value;
  const error = slack.error.value;
  const channels = slack.channels.value;
  const channelsLoaded = slack.channelsLoaded.value;
  const channelsError = slack.channelsError.value;
  const callbackNotice = slack.callbackNotice.value;

  const connected = connection !== null;
  const aside = connected ? (
    <Badge tone="ok">connected</Badge>
  ) : (
    <Badge tone="neutral">not connected</Badge>
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

        {callbackNotice ? (
          <Alert tone={callbackNotice.ok ? "ok" : "critical"}>{callbackNotice.message}</Alert>
        ) : null}

        {!loaded ? (
          <LoadingLine>loading Slack connection</LoadingLine>
        ) : !configured ? (
          <Muted class="text-[13px] m-0">
            Slack is not configured on this Drydock instance. Ask the operator to add the Slack app
            credentials.
          </Muted>
        ) : connected ? (
          <div class="flex flex-col gap-4">
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-[13px] text-ink break-all">
                  {connection.teamName ?? "Slack workspace"}
                </span>
                {connection.channelName ? (
                  <Badge tone="info">#{connection.channelName}</Badge>
                ) : (
                  <Badge tone="medium">no channel</Badge>
                )}
              </div>
              {canManage ? (
                <div class="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void onTest()}
                    disabled={busy || !connection.channelId}
                  >
                    {status === "testing" ? "Testing…" : "Test"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void slack.disconnect()}
                    disabled={busy}
                  >
                    {status === "disconnecting" ? "Disconnecting…" : "Disconnect"}
                  </Button>
                </div>
              ) : null}
            </div>

            {canManage ? (
              channelsLoaded ? (
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
                      value={connection.channelId ?? ""}
                      disabled={busy || channels.length === 0}
                      onChange={onSelectChannel}
                    >
                      <option value="" disabled>
                        {channels.length === 0 ? "No public channels found" : "Choose a channel…"}
                      </option>
                      {channels.map((channel: SlackChannelOption) => (
                        <option key={channel.id} value={channel.id}>
                          #{channel.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {status === "savingChannel" ? (
                    <Muted class="text-[12px] m-0">Saving…</Muted>
                  ) : null}
                </div>
              ) : channelsError ? null : (
                <LoadingLine size="inline">loading channels</LoadingLine>
              )
            ) : connection.channelName ? (
              <Muted class="text-[13px] m-0">
                Posting to <span class="text-ink">#{connection.channelName}</span>.
              </Muted>
            ) : (
              <Muted class="text-[13px] m-0">No channel selected yet.</Muted>
            )}

            {channelsError ? <Alert tone="critical">{channelsError}</Alert> : null}
          </div>
        ) : (
          <div class="flex flex-col gap-3">
            <Muted class="text-[13px] m-0">No Slack workspace connected.</Muted>
            {canManage ? (
              <Button onClick={() => void slack.connect()} disabled={busy} class="self-start">
                {status === "connecting" ? "Redirecting to Slack…" : "Add to Slack"}
              </Button>
            ) : null}
          </div>
        )}

        {error ? <Alert tone="critical">{error}</Alert> : null}
      </div>
    </CollapsibleCard>
  );
}
