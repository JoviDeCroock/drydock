import { createModel, signal } from "@preact/signals";
import { apiFetch, apiJson, errorMessage } from "./api";

export interface NotificationSettings {
  mentionEmails: boolean;
}

type SettingsStatus = "idle" | "loading" | "saving";

export const NotificationSettingsModel = createModel(() => {
  const settings = signal<NotificationSettings | null>(null);
  const status = signal<SettingsStatus>("idle");
  const error = signal<string | null>(null);

  return {
    settings,
    status,
    error,

    async load(): Promise<void> {
      status.value = "loading";
      try {
        const data = await apiFetch<{ settings: NotificationSettings }>(
          "/api/v1/account/notification-settings",
        );
        settings.value = data.settings;
        error.value = null;
      } catch (err) {
        error.value = errorMessage(err);
      } finally {
        status.value = "idle";
      }
    },

    async setMentionEmails(enabled: boolean): Promise<void> {
      const previous = settings.peek();
      settings.value = { mentionEmails: enabled };
      status.value = "saving";
      error.value = null;
      try {
        const data = await apiJson<{ settings: NotificationSettings }>(
          "/api/v1/account/notification-settings",
          { mentionEmails: enabled },
          { method: "PATCH" },
        );
        settings.value = data.settings;
      } catch (err) {
        settings.value = previous;
        error.value = errorMessage(err);
      } finally {
        status.value = "idle";
      }
    },
  };
});
