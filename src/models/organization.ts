import { computed, createModel, signal } from "@preact/signals";
import { apiFetch } from "./api";

export interface Organization {
  id: string;
  name: string;
  ownerUserId: string;
  role: string;
  isPersonal: boolean;
  isActive: boolean;
  npmConnectionConfigured: boolean;
  createdAt: string | number | Date;
  updatedAt: string | number | Date;
}

interface ListResponse {
  activeOrganizationId: string;
  organizations: Organization[];
}

export type OrganizationStatus = "idle" | "loading" | "creating" | "activating" | "renaming";

export const OrganizationModel = createModel(() => {
  const organizations = signal<Organization[]>([]);
  const activeOrganizationId = signal<string | null>(null);
  const loaded = signal(false);
  const status = signal<OrganizationStatus>("idle");
  const error = signal<string | null>(null);

  const active = computed<Organization | null>(
    () =>
      organizations.value.find((org) => org.id === activeOrganizationId.value) ??
      organizations.value.find((org) => org.isActive) ??
      null,
  );
  const busy = computed(() => status.value !== "idle");

  function applyList(data: ListResponse) {
    organizations.value = data.organizations;
    activeOrganizationId.value = data.activeOrganizationId;
  }

  return {
    organizations,
    activeOrganizationId,
    loaded,
    status,
    error,
    active,
    busy,

    async load(): Promise<void> {
      this.status.value = "loading";
      try {
        const data = await apiFetch<ListResponse>("/api/v1/organizations");
        applyList(data);
        this.error.value = null;
      } catch (err) {
        this.error.value = err instanceof Error ? err.message : String(err);
      } finally {
        this.loaded.value = true;
        this.status.value = "idle";
      }
    },

    async create(name: string): Promise<Organization | null> {
      const trimmed = name.trim();
      if (!trimmed) {
        this.error.value = "Name is required.";
        return null;
      }
      this.status.value = "creating";
      this.error.value = null;
      try {
        const data = await apiFetch<{ organization: { id: string; name: string } }>(
          "/api/v1/organizations",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: trimmed }),
          },
        );
        await this.load();
        return this.organizations.value.find((org) => org.id === data.organization.id) ?? null;
      } catch (err) {
        this.error.value = err instanceof Error ? err.message : String(err);
        return null;
      } finally {
        this.status.value = "idle";
      }
    },

    async activate(organizationId: string): Promise<boolean> {
      if (organizationId === this.activeOrganizationId.value) return true;
      this.status.value = "activating";
      this.error.value = null;
      try {
        await apiFetch<{ activeOrganizationId: string }>(
          `/api/v1/organizations/${encodeURIComponent(organizationId)}/activate`,
          { method: "POST" },
        );
        await this.load();
        return true;
      } catch (err) {
        this.error.value = err instanceof Error ? err.message : String(err);
        return false;
      } finally {
        this.status.value = "idle";
      }
    },

    async rename(organizationId: string, name: string): Promise<boolean> {
      const trimmed = name.trim();
      if (!trimmed) {
        this.error.value = "Name is required.";
        return false;
      }
      this.status.value = "renaming";
      this.error.value = null;
      try {
        await apiFetch<{ organization: { id: string; name: string } }>(
          `/api/v1/organizations/${encodeURIComponent(organizationId)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: trimmed }),
          },
        );
        await this.load();
        return true;
      } catch (err) {
        this.error.value = err instanceof Error ? err.message : String(err);
        return false;
      } finally {
        this.status.value = "idle";
      }
    },
  };
});
