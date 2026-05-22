import { createModel, signal } from "@preact/signals";
import { apiFetch } from "./api";

export type OrganizationRole = "owner" | "member";

export interface OrganizationMember {
  userId: string;
  email: string | null;
  name: string | null;
  role: OrganizationRole;
  joinedAt: string | number | Date;
  isOwner: boolean;
}

export interface OrganizationInvite {
  id: string;
  organizationId: string;
  role: OrganizationRole;
  email: string | null;
  status: "pending" | "accepted" | "revoked" | "expired";
  tokenLast4: string | null;
  invitedByUserId: string | null;
  acceptedByUserId: string | null;
  expiresAt: string | number | Date;
  acceptedAt: string | number | Date | null;
  createdAt: string | number | Date;
  updatedAt: string | number | Date;
}

interface MembersResponse {
  members: OrganizationMember[];
  viewer: { role: OrganizationRole };
}

interface InvitesResponse {
  invites: OrganizationInvite[];
}

interface CreatedInviteResponse {
  invite: OrganizationInvite;
  token: string;
  url: string;
}

export const MembersModel = createModel(() => {
  const organizationId = signal<string | null>(null);
  const members = signal<OrganizationMember[]>([]);
  const invites = signal<OrganizationInvite[]>([]);
  const viewerRole = signal<OrganizationRole | null>(null);
  const loaded = signal(false);
  const busy = signal(false);
  const error = signal<string | null>(null);
  const lastInviteUrl = signal<string | null>(null);

  return {
    organizationId,
    members,
    invites,
    viewerRole,
    loaded,
    busy,
    error,
    lastInviteUrl,

    async load(id: string): Promise<void> {
      this.organizationId.value = id;
      this.busy.value = true;
      this.error.value = null;
      try {
        const membersData = await apiFetch<MembersResponse>(
          `/api/v1/organizations/${encodeURIComponent(id)}/members`,
        );
        this.members.value = membersData.members;
        this.viewerRole.value = membersData.viewer.role;
        if (membersData.viewer.role === "owner") {
          const invitesData = await apiFetch<InvitesResponse>(
            `/api/v1/organizations/${encodeURIComponent(id)}/invites`,
          );
          this.invites.value = invitesData.invites;
        } else {
          this.invites.value = [];
        }
      } catch (err) {
        this.error.value = err instanceof Error ? err.message : String(err);
      } finally {
        this.loaded.value = true;
        this.busy.value = false;
      }
    },

    async invite(role: OrganizationRole, email: string): Promise<CreatedInviteResponse | null> {
      const id = this.organizationId.value;
      if (!id) return null;
      this.busy.value = true;
      this.error.value = null;
      this.lastInviteUrl.value = null;
      try {
        const trimmed = email.trim().toLowerCase();
        const data = await apiFetch<CreatedInviteResponse>(
          `/api/v1/organizations/${encodeURIComponent(id)}/invites`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ role, email: trimmed || undefined }),
          },
        );
        this.invites.value = [data.invite, ...this.invites.value];
        this.lastInviteUrl.value = data.url;
        return data;
      } catch (err) {
        this.error.value = err instanceof Error ? err.message : String(err);
        return null;
      } finally {
        this.busy.value = false;
      }
    },

    async revoke(inviteId: string): Promise<boolean> {
      const id = this.organizationId.value;
      if (!id) return false;
      this.busy.value = true;
      this.error.value = null;
      try {
        await apiFetch(
          `/api/v1/organizations/${encodeURIComponent(id)}/invites/${encodeURIComponent(inviteId)}`,
          { method: "DELETE" },
        );
        this.invites.value = this.invites.value.map((invite) =>
          invite.id === inviteId
            ? { ...invite, status: "revoked", updatedAt: new Date().toISOString() }
            : invite,
        );
        return true;
      } catch (err) {
        this.error.value = err instanceof Error ? err.message : String(err);
        return false;
      } finally {
        this.busy.value = false;
      }
    },

    async remove(userId: string): Promise<boolean> {
      const id = this.organizationId.value;
      if (!id) return false;
      this.busy.value = true;
      this.error.value = null;
      try {
        await apiFetch(
          `/api/v1/organizations/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
          { method: "DELETE" },
        );
        this.members.value = this.members.value.filter((member) => member.userId !== userId);
        return true;
      } catch (err) {
        this.error.value = err instanceof Error ? err.message : String(err);
        return false;
      } finally {
        this.busy.value = false;
      }
    },

    clearInviteUrl() {
      this.lastInviteUrl.value = null;
    },
  };
});
