import { computed, createModel, signal } from "@preact/signals";
import { apiFetch, apiJson, errorMessage } from "./api";

export interface NotificationRecipient {
  id: string;
  email: string;
  createdAt: string | number | Date;
}

interface ListResponse {
  recipients: NotificationRecipient[];
}

export type NotificationRecipientsStatus = "idle" | "loading" | "adding" | "removing";

function recipientsPath(organizationId: string): string {
  return `/api/v1/organizations/${encodeURIComponent(organizationId)}/notification-recipients`;
}

export const NotificationRecipientsModel = createModel(() => {
  const recipients = signal<NotificationRecipient[]>([]);
  const loaded = signal(false);
  const status = signal<NotificationRecipientsStatus>("idle");
  const error = signal<string | null>(null);
  const draftEmail = signal("");

  const busy = computed(() => status.value !== "idle");

  return {
    recipients,
    loaded,
    status,
    error,
    draftEmail,
    busy,

    async load(organizationId: string | null): Promise<void> {
      if (!organizationId) return;
      this.status.value = "loading";
      try {
        const data = await apiFetch<ListResponse>(recipientsPath(organizationId));
        this.recipients.value = data.recipients;
        this.error.value = null;
      } catch (err) {
        this.error.value = errorMessage(err);
      } finally {
        this.loaded.value = true;
        this.status.value = "idle";
      }
    },

    async add(organizationId: string): Promise<boolean> {
      const email = this.draftEmail.value.trim();
      if (!email) {
        this.error.value = "Email is required.";
        return false;
      }
      this.status.value = "adding";
      this.error.value = null;
      try {
        await apiJson<{ recipient: NotificationRecipient }>(recipientsPath(organizationId), {
          email,
        });
        this.draftEmail.value = "";
        await this.load(organizationId);
        return true;
      } catch (err) {
        this.error.value = errorMessage(err);
        return false;
      } finally {
        this.status.value = "idle";
      }
    },

    async remove(organizationId: string, recipientId: string): Promise<void> {
      this.status.value = "removing";
      this.error.value = null;
      try {
        await apiFetch<{ ok: boolean }>(
          `${recipientsPath(organizationId)}/${encodeURIComponent(recipientId)}`,
          { method: "DELETE" },
        );
        await this.load(organizationId);
      } catch (err) {
        this.error.value = errorMessage(err);
      } finally {
        this.status.value = "idle";
      }
    },
  };
});
