import { computed, createModel, signal } from "@preact/signals";
import type { OrganizationRole } from "../../server/lib/roles";
import { apiFetch, apiJson, errorMessage } from "./api";

export interface OrganizationMember {
  userId: string;
  email: string | null;
  name: string | null;
  role: OrganizationRole;
  isOwner: boolean;
  joinedAt: string;
}

export interface OrganizationInvitation {
  id: string;
  email: string;
  role: OrganizationRole;
  status: string;
  invitedByUserId: string | null;
  expiresAt: string;
  createdAt: string;
  expired: boolean;
}

type MembersStatus = "idle" | "loading" | "inviting" | "revoking" | "removing";

export const MembersModel = createModel(() => {
  const members = signal<OrganizationMember[]>([]);
  const invitations = signal<OrganizationInvitation[]>([]);
  const loaded = signal(false);
  const status = signal<MembersStatus>("idle");
  const error = signal<string | null>(null);
  const busy = computed(() => status.value !== "idle");

  return {
    members,
    invitations,
    loaded,
    status,
    error,
    busy,

    async load(canManage: boolean): Promise<void> {
      this.status.value = "loading";
      this.error.value = null;
      try {
        const memberData = await apiFetch<{ members: OrganizationMember[] }>(
          "/api/v1/organizations/members",
        );
        this.members.value = memberData.members;
        if (canManage) {
          const inviteData = await apiFetch<{ invitations: OrganizationInvitation[] }>(
            "/api/v1/organizations/invitations",
          );
          this.invitations.value = inviteData.invitations;
        } else {
          this.invitations.value = [];
        }
      } catch (err) {
        this.error.value = errorMessage(err);
      } finally {
        this.loaded.value = true;
        this.status.value = "idle";
      }
    },

    async invite(email: string, role: OrganizationRole): Promise<boolean> {
      const trimmed = email.trim();
      if (!trimmed) {
        this.error.value = "Email is required.";
        return false;
      }
      this.status.value = "inviting";
      this.error.value = null;
      try {
        await apiJson<{ invitation: OrganizationInvitation }>("/api/v1/organizations/invitations", {
          email: trimmed,
          role,
        });
        await this.refreshInvitations();
        return true;
      } catch (err) {
        this.error.value = errorMessage(err);
        return false;
      } finally {
        this.status.value = "idle";
      }
    },

    async revokeInvitation(invitationId: string): Promise<void> {
      this.status.value = "revoking";
      this.error.value = null;
      try {
        await apiFetch(`/api/v1/organizations/invitations/${encodeURIComponent(invitationId)}`, {
          method: "DELETE",
        });
        await this.refreshInvitations();
      } catch (err) {
        this.error.value = errorMessage(err);
      } finally {
        this.status.value = "idle";
      }
    },

    async removeMember(userId: string): Promise<void> {
      this.status.value = "removing";
      this.error.value = null;
      try {
        await apiFetch(`/api/v1/organizations/members/${encodeURIComponent(userId)}`, {
          method: "DELETE",
        });
        const memberData = await apiFetch<{ members: OrganizationMember[] }>(
          "/api/v1/organizations/members",
        );
        this.members.value = memberData.members;
      } catch (err) {
        this.error.value = errorMessage(err);
      } finally {
        this.status.value = "idle";
      }
    },

    async refreshInvitations(): Promise<void> {
      const inviteData = await apiFetch<{ invitations: OrganizationInvitation[] }>(
        "/api/v1/organizations/invitations",
      );
      this.invitations.value = inviteData.invitations;
    },
  };
});
