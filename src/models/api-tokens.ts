import { computed, createModel, signal } from "@preact/signals";
import { apiFetch, apiJson, errorMessage } from "./api";

export type ApiTokenScope = "scans:read" | "scans:write";

export interface PublicApiToken {
  id: string;
  organizationId: string;
  name: string;
  scopes: ApiTokenScope[];
  tokenLast4: string;
  createdByUserId: string | null;
  lastUsedAt: string | number | Date | null;
  createdAt: string | number | Date;
  updatedAt: string | number | Date;
}

type ApiTokenStatus = "idle" | "loading" | "creating" | "revoking";

function tokensPath(organizationId: string): string {
  return `/api/v1/organizations/${encodeURIComponent(organizationId)}/api-tokens`;
}

export const ApiTokensModel = createModel(() => {
  const tokens = signal<PublicApiToken[]>([]);
  const loaded = signal(false);
  const status = signal<ApiTokenStatus>("idle");
  const error = signal<string | null>(null);
  const createdSecret = signal<string | null>(null);
  const draftName = signal("CI access");
  const draftScansRead = signal(true);
  const draftScansWrite = signal(true);
  let currentOrganizationId: string | null = null;

  const busy = computed(() => status.value !== "idle");

  return {
    tokens,
    loaded,
    status,
    error,
    createdSecret,
    draftName,
    draftScansRead,
    draftScansWrite,
    busy,

    async load(organizationId: string | null, canManage: boolean): Promise<void> {
      currentOrganizationId = organizationId;
      this.tokens.value = [];
      this.loaded.value = false;
      this.error.value = null;
      this.createdSecret.value = null;
      if (!organizationId || !canManage) {
        this.loaded.value = true;
        return;
      }

      this.status.value = "loading";
      try {
        const data = await apiFetch<{ tokens: PublicApiToken[] }>(tokensPath(organizationId));
        if (currentOrganizationId !== organizationId) return;
        this.tokens.value = data.tokens;
        this.error.value = null;
      } catch (err) {
        if (currentOrganizationId === organizationId) this.error.value = errorMessage(err);
      } finally {
        if (currentOrganizationId === organizationId) {
          this.loaded.value = true;
          this.status.value = "idle";
        }
      }
    },

    async create(organizationId: string | null): Promise<void> {
      if (!organizationId) return;
      const name = this.draftName.value.trim();
      if (!name) {
        this.error.value = "Token name is required.";
        return;
      }
      const scopes = selectedScopes(this.draftScansRead.value, this.draftScansWrite.value);
      if (scopes.length === 0) {
        this.error.value = "Select at least one scope.";
        return;
      }

      this.status.value = "creating";
      this.error.value = null;
      this.createdSecret.value = null;
      try {
        const data = await apiJson<{ token: PublicApiToken; secret: string }>(
          tokensPath(organizationId),
          { name, scopes },
        );
        if (currentOrganizationId !== organizationId) return;
        this.tokens.value = [...this.tokens.value, data.token];
        this.createdSecret.value = data.secret;
        this.draftName.value = "CI access";
        this.draftScansRead.value = true;
        this.draftScansWrite.value = true;
      } catch (err) {
        if (currentOrganizationId === organizationId) this.error.value = errorMessage(err);
      } finally {
        if (currentOrganizationId === organizationId || this.status.value === "creating") {
          this.status.value = "idle";
        }
      }
    },

    async revoke(organizationId: string | null, tokenId: string): Promise<void> {
      if (!organizationId) return;
      this.status.value = "revoking";
      this.error.value = null;
      try {
        await apiFetch<{ ok: boolean }>(
          `${tokensPath(organizationId)}/${encodeURIComponent(tokenId)}`,
          { method: "DELETE" },
        );
        if (currentOrganizationId !== organizationId) return;
        this.tokens.value = this.tokens.value.filter((token) => token.id !== tokenId);
      } catch (err) {
        if (currentOrganizationId === organizationId) this.error.value = errorMessage(err);
      } finally {
        if (currentOrganizationId === organizationId || this.status.value === "revoking") {
          this.status.value = "idle";
        }
      }
    },
  };
});

function selectedScopes(read: boolean, write: boolean): ApiTokenScope[] {
  const scopes: ApiTokenScope[] = [];
  if (read) scopes.push("scans:read");
  if (write) scopes.push("scans:write");
  return scopes;
}
