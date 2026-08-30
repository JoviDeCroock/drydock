import { computed, createModel, signal } from "@preact/signals";
import { activeOrganizationId, setActiveOrganizationId } from "./active-organization";
import { ApiError, apiFetch, apiJson, errorMessage } from "./api";

export interface Organization {
  id: string;
  name: string;
  ownerUserId: string;
  role: string;
  isPersonal: boolean;
  npmConnectionConfigured: boolean;
  requireTwoFactorForReleaseDecisions: boolean;
  requireAuthorityChangeApproval: boolean;
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

// The release-two-factor route answers with stable codes; map them to copy that
// matches what the owner must do. `apiFetch` rewrites the generic 401 message but
// preserves `code`, so we key off the code rather than the message text.
function releaseTwoFactorErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "two_factor_enrollment_required") {
      return "Enable two-factor authentication on your own account first, then change this policy.";
    }
    if (err.code === "two_factor_required") {
      return "Enter the code from your authenticator app to stop requiring two-factor.";
    }
    if (err.code === "two_factor_invalid") {
      return "That authentication code is invalid or expired — enter the current code.";
    }
  }
  return errorMessage(err);
}

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
  const busy = computed(() => status.value !== "idle");

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
      this.status.value = "creating";
      this.error.value = null;
      try {
        const data = await apiJson<{ organization: { id: string; name: string } }>(
          "/api/v1/organizations",
          { name: trimmed },
        );
        await this.load();
        setActiveOrganizationId(data.organization.id);
        return this.organizations.value.find((org) => org.id === data.organization.id) ?? null;
      } catch (err) {
        this.error.value = errorMessage(err);
        return null;
      } finally {
        this.status.value = "idle";
      }
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
      this.status.value = "deleting";
      this.error.value = null;
      try {
        await apiFetch(`/api/v1/organizations/${encodeURIComponent(organizationId)}`, {
          method: "DELETE",
        });
        // load() re-points the active org when the stored id is no longer valid,
        // so a deleted active org falls back to the personal workspace.
        await this.load();
        return true;
      } catch (err) {
        this.error.value = errorMessage(err);
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
        await apiJson<{ organization: { id: string; name: string } }>(
          `/api/v1/organizations/${encodeURIComponent(organizationId)}`,
          { name: trimmed },
          {
            method: "PATCH",
          },
        );
        await this.load();
        return true;
      } catch (err) {
        this.error.value = errorMessage(err);
        return false;
      } finally {
        this.status.value = "idle";
      }
    },

    // Changing the policy is 2FA-guarded server-side: enabling requires the owner
    // be enrolled, and disabling requires a fresh `totpCode` (passed only on the
    // relax path). Codes are surfaced as friendly copy below.
    async setReleaseTwoFactor(
      organizationId: string,
      enabled: boolean,
      totpCode?: string | null,
    ): Promise<boolean> {
      this.status.value = "updating";
      this.error.value = null;
      try {
        await apiJson<{ requireTwoFactorForReleaseDecisions: boolean }>(
          `/api/v1/organizations/${encodeURIComponent(organizationId)}/release-two-factor`,
          { enabled, totpCode: totpCode?.trim() || undefined },
          { method: "PUT" },
        );
        // Reload so `active.requireTwoFactorForReleaseDecisions` reflects the new
        // policy everywhere that reads the org list.
        await this.load();
        return true;
      } catch (err) {
        this.error.value = releaseTwoFactorErrorMessage(err);
        return false;
      } finally {
        this.status.value = "idle";
      }
    },

    // Org policy: hold a release gate whose publishing authority changed since
    // the last approved baseline until a maintainer explicitly accepts it.
    async setAuthorityChangeApproval(organizationId: string, enabled: boolean): Promise<boolean> {
      this.status.value = "updating";
      this.error.value = null;
      try {
        await apiJson<{ requireAuthorityChangeApproval: boolean }>(
          `/api/v1/organizations/${encodeURIComponent(organizationId)}/authority-change-approval`,
          { enabled },
          { method: "PUT" },
        );
        await this.load();
        return true;
      } catch (err) {
        this.error.value = errorMessage(err);
        return false;
      } finally {
        this.status.value = "idle";
      }
    },
  };
});
