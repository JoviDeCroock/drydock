import { computed, createModel, signal } from "@preact/signals";
import { apiFetch, apiJson, errorMessage } from "./api";

export interface NotificationWebhookConnection {
  hostname: string;
  enabled: boolean;
  createdAt: string | number | Date;
}

const WEBHOOK_BASE = "/api/v1/notification-webhook";

export const NotificationWebhookModel = createModel(() => {
  const connection = signal<NotificationWebhookConnection | null>(null);
  const loaded = signal(false);
  const busy = signal(false);
  const error = signal<string | null>(null);
  const notice = signal<string | null>(null);
  const draftUrl = signal("");
  const draftSecret = signal("");
  const canSave = computed(
    () => !busy.value && !!draftUrl.value.trim() && draftSecret.value.length >= 32,
  );
  let generation = 0;
  let organizationId: string | null = null;

  async function update(method: "PUT" | "PATCH" | "DELETE", body?: unknown): Promise<boolean> {
    if (busy.peek() || !organizationId) return false;
    const requestGeneration = generation;
    busy.value = true;
    error.value = null;
    notice.value = null;
    try {
      const result =
        method === "DELETE"
          ? await apiFetch<{ connection?: NotificationWebhookConnection }>(WEBHOOK_BASE, { method })
          : await apiJson<{ connection: NotificationWebhookConnection }>(WEBHOOK_BASE, body, {
              method,
            });
      if (generation !== requestGeneration) return false;
      connection.value = result.connection ?? null;
      draftUrl.value = "";
      draftSecret.value = "";
      notice.value = method === "DELETE" ? "Webhook disconnected." : "Webhook settings saved.";
      return true;
    } catch (err) {
      if (generation === requestGeneration) error.value = errorMessage(err);
      return false;
    } finally {
      if (generation === requestGeneration) busy.value = false;
    }
  }

  return {
    connection,
    loaded,
    busy,
    error,
    notice,
    draftUrl,
    draftSecret,
    canSave,
    async load(nextOrganizationId: string | null): Promise<void> {
      const requestGeneration = ++generation;
      organizationId = nextOrganizationId;
      connection.value = null;
      loaded.value = false;
      error.value = null;
      notice.value = null;
      draftUrl.value = "";
      draftSecret.value = "";
      busy.value = !!organizationId;
      if (!organizationId) {
        loaded.value = true;
        return;
      }
      try {
        const result = await apiFetch<{ connection: NotificationWebhookConnection | null }>(
          WEBHOOK_BASE,
        );
        if (generation === requestGeneration) connection.value = result.connection;
      } catch (err) {
        if (generation === requestGeneration) error.value = errorMessage(err);
      } finally {
        if (generation === requestGeneration) {
          loaded.value = true;
          busy.value = false;
        }
      }
    },
    save(): Promise<boolean> {
      return update("PUT", { url: draftUrl.peek().trim(), secret: draftSecret.peek() });
    },
    setEnabled(enabled: boolean): Promise<boolean> {
      return update("PATCH", { enabled });
    },
    disconnect(): Promise<boolean> {
      return update("DELETE");
    },
    async test(): Promise<void> {
      if (busy.peek() || !organizationId) return;
      const requestGeneration = generation;
      busy.value = true;
      error.value = null;
      notice.value = null;
      try {
        const result = await apiJson<{ ok: boolean; reason?: string }>(`${WEBHOOK_BASE}/test`, {});
        if (generation !== requestGeneration) return;
        if (result.ok) notice.value = "Test notification delivered.";
        else
          error.value =
            "Test notification could not be delivered. Check your endpoint and try again.";
      } catch (err) {
        if (generation === requestGeneration) error.value = errorMessage(err);
      } finally {
        if (generation === requestGeneration) busy.value = false;
      }
    },
  };
});
