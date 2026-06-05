import { computed, createModel, signal } from "@preact/signals";
import { ApiError, apiFetch, apiJson, errorMessage } from "./api";

export interface SlackConnection {
  teamId: string;
  teamName: string | null;
  channelId: string | null;
  channelName: string | null;
  enabled: boolean;
  createdAt: string | number | Date;
}

export interface SlackChannelOption {
  id: string;
  name: string;
}

interface StatusResponse {
  configured: boolean;
  connection: SlackConnection | null;
}

interface ChannelsResponse {
  channels: SlackChannelOption[];
}

interface ConnectResponse {
  authorizeUrl: string;
  expiresInSeconds: number;
}

interface TestResponse {
  ok: boolean;
  rateLimited?: boolean;
  reason?: string;
}

export interface SlackTestResult {
  ok: boolean;
  message: string;
}

export type SlackConnectionStatus =
  | "idle"
  | "loading"
  | "connecting"
  | "loadingChannels"
  | "savingChannel"
  | "updating"
  | "disconnecting"
  | "testing";

const SLACK_BASE = "/api/v1/slack";

export const SlackConnectionModel = createModel(() => {
  const configured = signal(false);
  const connection = signal<SlackConnection | null>(null);
  const loaded = signal(false);
  const status = signal<SlackConnectionStatus>("idle");
  const error = signal<string | null>(null);

  const channels = signal<SlackChannelOption[]>([]);
  const channelsLoaded = signal(false);
  const channelsError = signal<string | null>(null);

  const lastTest = signal<SlackTestResult | null>(null);
  // Set from the OAuth callback redirect (?slack=connected|error).
  const callbackNotice = signal<SlackTestResult | null>(null);

  let currentOrganizationId: string | null = null;
  let loadRequestId = 0;

  const busy = computed(() => status.value !== "idle");

  function resetChannelPicker() {
    channels.value = [];
    channelsLoaded.value = false;
    channelsError.value = null;
  }

  return {
    configured,
    connection,
    loaded,
    status,
    error,
    channels,
    channelsLoaded,
    channelsError,
    lastTest,
    callbackNotice,
    busy,

    async load(organizationId: string | null): Promise<void> {
      const requestId = ++loadRequestId;
      currentOrganizationId = organizationId;
      this.connection.value = null;
      this.configured.value = false;
      this.loaded.value = false;
      this.error.value = null;
      this.lastTest.value = null;
      resetChannelPicker();
      if (!organizationId) {
        this.loaded.value = true;
        this.status.value = "idle";
        return;
      }
      this.status.value = "loading";
      try {
        const data = await apiFetch<StatusResponse>(SLACK_BASE);
        if (requestId === loadRequestId) {
          this.configured.value = data.configured;
          this.connection.value = data.connection;
          this.error.value = null;
        }
      } catch (err) {
        if (requestId === loadRequestId) {
          this.error.value = errorMessage(err);
        }
      } finally {
        if (requestId === loadRequestId) {
          this.loaded.value = true;
          this.status.value = "idle";
        }
      }
    },

    // Kicks off the "Add to Slack" OAuth flow by navigating the browser to the
    // authorize URL minted by the server. Slack redirects back to the callback
    // route, which finishes the exchange and returns to settings.
    async connect(): Promise<void> {
      this.status.value = "connecting";
      this.error.value = null;
      try {
        const data = await apiJson<ConnectResponse>(`${SLACK_BASE}/connect`, {});
        window.location.assign(data.authorizeUrl);
      } catch (err) {
        if (err instanceof ApiError && err.code === "slack_not_configured") {
          this.configured.value = false;
          this.error.value =
            "Slack is not configured yet on this Drydock instance. Ask the operator to add the Slack app credentials.";
        } else {
          this.error.value = errorMessage(err);
        }
        this.status.value = "idle";
      }
    },

    async loadChannels(): Promise<void> {
      const org = currentOrganizationId;
      this.status.value = "loadingChannels";
      this.channelsError.value = null;
      try {
        const data = await apiFetch<ChannelsResponse>(`${SLACK_BASE}/channels`);
        if (currentOrganizationId !== org) return;
        this.channels.value = data.channels;
        this.channelsLoaded.value = true;
      } catch (err) {
        if (currentOrganizationId === org) {
          this.channelsError.value = errorMessage(err);
        }
      } finally {
        if (currentOrganizationId === org) {
          this.status.value = "idle";
        }
      }
    },

    async selectChannel(channelId: string): Promise<void> {
      const org = currentOrganizationId;
      const channel = this.channels.peek().find((option) => option.id === channelId);
      if (!channel) return;
      this.status.value = "savingChannel";
      this.error.value = null;
      this.lastTest.value = null;
      try {
        const data = await apiJson<{ connection: SlackConnection }>(
          `${SLACK_BASE}/channel`,
          { channelId: channel.id, channelName: channel.name },
          { method: "PUT" },
        );
        if (currentOrganizationId !== org) return;
        this.connection.value = data.connection;
      } catch (err) {
        if (currentOrganizationId === org) {
          this.error.value = errorMessage(err);
        }
      } finally {
        if (currentOrganizationId === org) {
          this.status.value = "idle";
        }
      }
    },

    async setEnabled(enabled: boolean): Promise<void> {
      const org = currentOrganizationId;
      this.status.value = "updating";
      this.error.value = null;
      try {
        const data = await apiJson<{ connection: SlackConnection }>(
          SLACK_BASE,
          { enabled },
          { method: "PATCH" },
        );
        if (currentOrganizationId !== org) return;
        this.connection.value = data.connection;
      } catch (err) {
        if (currentOrganizationId === org) {
          this.error.value = errorMessage(err);
        }
      } finally {
        if (currentOrganizationId === org) {
          this.status.value = "idle";
        }
      }
    },

    async disconnect(): Promise<void> {
      const org = currentOrganizationId;
      this.status.value = "disconnecting";
      this.error.value = null;
      this.lastTest.value = null;
      try {
        await apiFetch<{ ok: boolean }>(SLACK_BASE, { method: "DELETE" });
        if (currentOrganizationId !== org) return;
        this.connection.value = null;
        resetChannelPicker();
      } catch (err) {
        if (currentOrganizationId === org) {
          this.error.value = errorMessage(err);
        }
      } finally {
        if (currentOrganizationId === org) {
          this.status.value = "idle";
        }
      }
    },

    async test(): Promise<void> {
      const org = currentOrganizationId;
      this.status.value = "testing";
      this.error.value = null;
      this.lastTest.value = null;
      try {
        const result = await apiJson<TestResponse>(`${SLACK_BASE}/test`, {});
        if (currentOrganizationId !== org) return;
        this.lastTest.value = {
          ok: result.ok,
          message: result.ok
            ? "Test message sent."
            : result.rateLimited
              ? "Slack is rate-limiting test messages — try again shortly."
              : `Slack rejected the test${result.reason ? `: ${result.reason}` : "."}`,
        };
      } catch (err) {
        if (currentOrganizationId === org) {
          this.lastTest.value = { ok: false, message: errorMessage(err) };
        }
      } finally {
        if (currentOrganizationId === org) {
          this.status.value = "idle";
        }
      }
    },

    // Surface the result of the OAuth callback redirect once the page reloads.
    noteCallback(slack: string | undefined, detail: string | undefined): void {
      if (slack === "connected") {
        this.callbackNotice.value = { ok: true, message: "Slack workspace connected." };
      } else if (slack === "error") {
        this.callbackNotice.value = {
          ok: false,
          message: `Could not connect Slack${detail ? `: ${detail}` : "."}`,
        };
      } else {
        this.callbackNotice.value = null;
      }
    },

    dismissCallbackNotice(): void {
      this.callbackNotice.value = null;
    },
  };
});
