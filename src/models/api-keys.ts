import { computed, createModel, signal } from "@preact/signals";
import { apiFetch, apiJson, errorMessage } from "./api";

export interface OrganizationApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  createdBy: { userId: string; email: string | null; name: string | null };
}

interface ListResponse {
  keys: OrganizationApiKey[];
  limit: number;
  expiryDays: number[];
}

interface CreateResponse {
  key: OrganizationApiKey;
  token: string;
}

export type ApiKeysStatus = "idle" | "loading" | "creating" | "revoking";

const DEFAULT_EXPIRY_DAYS = 90;

export const ApiKeysModel = createModel(() => {
  const keys = signal<OrganizationApiKey[]>([]);
  const limit = signal<number | null>(null);
  const expiryChoices = signal<number[]>([30, DEFAULT_EXPIRY_DAYS, 365]);
  const loaded = signal(false);
  const status = signal<ApiKeysStatus>("idle");
  const error = signal<string | null>(null);
  const draftName = signal("");
  const draftExpiryDays = signal(DEFAULT_EXPIRY_DAYS);
  // The secret of the key created last. It exists only in this response, so it
  // stays on screen until dismissed or the organization changes.
  const revealed = signal<{ name: string; token: string } | null>(null);
  let loadRequestId = 0;

  const busy = computed(() => status.value !== "idle");
  const atLimit = computed(() => limit.value !== null && keys.value.length >= limit.value);

  return {
    keys,
    limit,
    expiryChoices,
    loaded,
    status,
    error,
    draftName,
    draftExpiryDays,
    revealed,
    busy,
    atLimit,

    async load(canManage: boolean): Promise<void> {
      const requestId = ++loadRequestId;
      this.keys.value = [];
      this.revealed.value = null;
      this.loaded.value = false;
      this.error.value = null;
      if (!canManage) {
        this.loaded.value = true;
        this.status.value = "idle";
        return;
      }
      this.status.value = "loading";
      try {
        const data = await apiFetch<ListResponse>("/api/v1/api-keys");
        if (requestId !== loadRequestId) return;
        this.keys.value = data.keys;
        this.limit.value = data.limit;
        if (data.expiryDays.length) this.expiryChoices.value = data.expiryDays;
      } catch (err) {
        if (requestId === loadRequestId) this.error.value = errorMessage(err);
      } finally {
        if (requestId === loadRequestId) {
          this.loaded.value = true;
          this.status.value = "idle";
        }
      }
    },

    async create(): Promise<boolean> {
      const name = this.draftName.value.trim();
      if (!name) {
        this.error.value = "Name the key after what will use it.";
        return false;
      }
      const requestId = loadRequestId;
      this.status.value = "creating";
      this.error.value = null;
      try {
        const data = await apiJson<CreateResponse>("/api/v1/api-keys", {
          name,
          expiresInDays: this.draftExpiryDays.value,
        });
        if (requestId !== loadRequestId) return true;
        this.keys.value = [...this.keys.value, data.key];
        this.revealed.value = { name: data.key.name, token: data.token };
        this.draftName.value = "";
        return true;
      } catch (err) {
        if (requestId === loadRequestId) this.error.value = errorMessage(err);
        return false;
      } finally {
        if (requestId === loadRequestId) this.status.value = "idle";
      }
    },

    async revoke(keyId: string): Promise<void> {
      const requestId = loadRequestId;
      this.status.value = "revoking";
      this.error.value = null;
      try {
        await apiFetch<{ ok: boolean }>(`/api/v1/api-keys/${encodeURIComponent(keyId)}`, {
          method: "DELETE",
        });
        if (requestId !== loadRequestId) return;
        this.keys.value = this.keys.value.filter((key) => key.id !== keyId);
      } catch (err) {
        if (requestId === loadRequestId) this.error.value = errorMessage(err);
      } finally {
        if (requestId === loadRequestId) this.status.value = "idle";
      }
    },

    dismissRevealed(): void {
      this.revealed.value = null;
    },
  };
});
