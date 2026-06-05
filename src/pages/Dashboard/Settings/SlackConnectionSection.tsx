import { useModel } from "@preact/signals";
import { SlackConnectionModel, type SlackChannelOption } from "../../../models/slack-connection";
import {
  Alert,
  Badge,
  Button,
  CollapsibleCard,
  Field,
  LoadingLine,
  Muted,
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
  const lastTest = slack.lastTest.value;
  const callbackNotice = slack.callbackNotice.value;

  const connected = connection !== null;
  const aside = connected ? (
    <Badge tone={connection.enabled ? "ok" : "neutral"}>
      {connection.enabled ? "connected" : "paused"}
    </Badge>
  ) : (
    <Badge tone="neutral">not connected</Badge>
  );

  const onSelectChannel = (channelId: string) => {
    if (channelId) void slack.selectChannel(channelId);
  };

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
                    onClick={() => void slack.test()}
                    disabled={busy || !connection.channelId || !connection.enabled}
                  >
                    {status === "testing" ? "Testing…" : "Test"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void slack.setEnabled(!connection.enabled)}
                    disabled={busy}
                  >
                    {connection.enabled ? "Pause" : "Resume"}
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
              <Field label="Channel" for="slackChannel">
                {channelsLoaded ? (
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
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void slack.loadChannels()}
                    disabled={busy}
                    class="self-start"
                  >
                    {status === "loadingChannels"
                      ? "Loading channels…"
                      : connection.channelId
                        ? "Change channel"
                        : "Choose a channel"}
                  </Button>
                )}
              </Field>
            ) : connection.channelName ? (
              <Muted class="text-[13px] m-0">
                Posting to <span class="text-ink">#{connection.channelName}</span>.
              </Muted>
            ) : (
              <Muted class="text-[13px] m-0">No channel selected yet.</Muted>
            )}

            {status === "savingChannel" ? (
              <Muted class="text-[12px] m-0">Saving channel…</Muted>
            ) : null}
            {channelsError ? <Alert tone="critical">{channelsError}</Alert> : null}
            {lastTest ? (
              <Alert tone={lastTest.ok ? "ok" : "critical"}>{lastTest.message}</Alert>
            ) : null}
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
