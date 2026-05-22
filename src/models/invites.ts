import { createModel, signal } from "@preact/signals";
import { apiFetch } from "./api";
import type { OrganizationRole } from "./members";

export interface InvitePreview {
  id: string;
  organizationId: string;
  organizationName: string;
  role: OrganizationRole;
  email: string | null;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string | number | Date;
}

interface PreviewResponse {
  invite: InvitePreview;
  viewer: { alreadyMember: boolean };
}

interface AcceptResponse {
  organization: { id: string };
  role: OrganizationRole;
}

export const InviteAcceptModel = createModel(() => {
  const token = signal<string | null>(null);
  const preview = signal<InvitePreview | null>(null);
  const alreadyMember = signal(false);
  const loaded = signal(false);
  const busy = signal(false);
  const error = signal<string | null>(null);
  const accepted = signal<AcceptResponse | null>(null);

  return {
    token,
    preview,
    alreadyMember,
    loaded,
    busy,
    error,
    accepted,

    async load(tokenValue: string): Promise<void> {
      this.token.value = tokenValue;
      this.busy.value = true;
      this.error.value = null;
      try {
        const data = await apiFetch<PreviewResponse>(
          `/api/v1/invites/${encodeURIComponent(tokenValue)}`,
        );
        this.preview.value = data.invite;
        this.alreadyMember.value = data.viewer.alreadyMember;
      } catch (err) {
        this.error.value = err instanceof Error ? err.message : String(err);
      } finally {
        this.loaded.value = true;
        this.busy.value = false;
      }
    },

    async accept(): Promise<AcceptResponse | null> {
      const tokenValue = this.token.value;
      if (!tokenValue) return null;
      this.busy.value = true;
      this.error.value = null;
      try {
        const data = await apiFetch<AcceptResponse>(
          `/api/v1/invites/${encodeURIComponent(tokenValue)}/accept`,
          { method: "POST" },
        );
        this.accepted.value = data;
        return data;
      } catch (err) {
        this.error.value = err instanceof Error ? err.message : String(err);
        return null;
      } finally {
        this.busy.value = false;
      }
    },
  };
});
