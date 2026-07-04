import { computed, createModel, signal } from "@preact/signals";
import { activeOrganizationId, setActiveOrganizationId } from "./active-organization";
import { apiFetch, apiJson, errorMessage } from "./api";
import { busySignal, runAction } from "./async-action";
import { twoFactorErrorMessage } from "./two-factor-error-message";

export interface Organization {
  id: string;
  name: string;
  ownerUserId: string;
  role: string;
  isPersonal: boolean;
  npmConnectionConfigured: boolean;
  requireTwoFactorForReleaseDecisions: boolean;
  createdAt: string | number | Date;
  updatedAt: string | number | Date;
}

interface ListResponse {
  organizations: Organization[];
}

export type OrganizationStatus =
  | "idle"
  | "loading"
  | "creating"
  | "renaming"
  | "deleting"
  | "updating";

const RELEASE_TWO_FACTOR_COPY = {
  enrollmentRequired:
    "Enable two-factor authentication on your own account first, then change this policy.",
  required: "Enter the code from your authenticator app to stop requiring two-factor.",
  invalid: "That authentication code is invalid or expired — enter the current code.",
};

export const OrganizationModel = createModel(() => {
  const organizations = signal<Organization[]>([]);
  const loaded = signal(false);
  const status = signal<OrganizationStatus>("idle");
  const error = signal<string | null>(null);

  const active = computed<Organization | null>(() => {
    const stored = activeOrganizationId.value;
    const list = organizations.value;
    if (stored) {
      const found = list.find((org) => org.id === stored);
      if (found) return found;
    }
    return list[0] ?? null;
  });
  const busy = busySignal(status);

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
        this.organizations.value = data.organizations;
        const stored = activeOrganizationId.peek();
        const isStoredValid = stored && data.organizations.some((org) => org.id === stored);
        if (!isStoredValid) {
          setActiveOrganizationId(data.organizations[0]?.id ?? null);
        }
        this.error.value = null;
      } catch (err) {
        this.error.value = errorMessage(err);
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
      return (
        (await runAction({
          status: this.status,
          error: this.error,
          pending: "creating",
          run: async () => {
            const data = await apiJson<{ organization: { id: string; name: string } }>(
              "/api/v1/organizations",
              { name: trimmed },
            );
            await this.load();
            setActiveOrganizationId(data.organization.id);
            return this.organizations.value.find((org) => org.id === data.organization.id) ?? null;
          },
        })) ?? null
      );
    },

    activate(organizationId: string): boolean {
      if (!this.organizations.value.some((org) => org.id === organizationId)) {
        this.error.value = "Unknown organization.";
        return false;
      }
      setActiveOrganizationId(organizationId);
      this.error.value = null;
      return true;
    },

    async delete(organizationId: string): Promise<boolean> {
      return (
        (await runAction({
          status: this.status,
          error: this.error,
          pending: "deleting",
          run: async () => {
            await apiFetch(`/api/v1/organizations/${encodeURIComponent(organizationId)}`, {
              method: "DELETE",
            });
            // load() re-points the active org when the stored id is no longer valid,
            // so a deleted active org falls back to the personal workspace.
            await this.load();
            return true;
          },
        })) ?? false
      );
    },

    async rename(organizationId: string, name: string): Promise<boolean> {
      const trimmed = name.trim();
      if (!trimmed) {
        this.error.value = "Name is required.";
        return false;
      }
      return (
        (await runAction({
          status: this.status,
          error: this.error,
          pending: "renaming",
          run: async () => {
            await apiJson<{ organization: { id: string; name: string } }>(
              `/api/v1/organizations/${encodeURIComponent(organizationId)}`,
              { name: trimmed },
              {
                method: "PATCH",
              },
            );
            await this.load();
            return true;
          },
        })) ?? false
      );
    },

    // Changing the policy is 2FA-guarded server-side: enabling requires the owner
    // be enrolled, and disabling requires a fresh `totpCode` (passed only on the
    // relax path). Codes are surfaced as friendly copy below.
    async setReleaseTwoFactor(
      organizationId: string,
      enabled: boolean,
      totpCode?: string | null,
    ): Promise<boolean> {
      return (
        (await runAction({
          status: this.status,
          error: this.error,
          pending: "updating",
          mapError: (err) => twoFactorErrorMessage(err, RELEASE_TWO_FACTOR_COPY),
          run: async () => {
            await apiJson<{ requireTwoFactorForReleaseDecisions: boolean }>(
              `/api/v1/organizations/${encodeURIComponent(organizationId)}/release-two-factor`,
              { enabled, totpCode: totpCode?.trim() || undefined },
              { method: "PUT" },
            );
            // Reload so `active.requireTwoFactorForReleaseDecisions` reflects the new
            // policy everywhere that reads the org list.
            await this.load();
            return true;
          },
        })) ?? false
      );
    },
  };
});
