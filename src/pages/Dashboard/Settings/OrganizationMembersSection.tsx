import { useModel, useSignal } from "@preact/signals";
import type { OrganizationRole } from "../../../../server/lib/roles";
import { formatTimestamp } from "../../../lib/format";
import {
  MembersModel,
  type OrganizationInvitation,
  type OrganizationMember,
} from "../../../models/organization-members";
import { Alert } from "../../../components/Alert";
import { Badge, type BadgeTone } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import {
  CollapsibleCard,
  SettingsCardBody,
  SettingsCardHeader,
  SettingsCardListItem,
} from "../../../components/Card";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { Select } from "../../../components/Select";
import { MonoDetail, Muted } from "../../../components/Typography";

export function OrganizationMembersSection({
  members,
  currentUserRole,
  currentUserId,
}: {
  members: ReturnType<typeof useModel<typeof MembersModel.prototype>>;
  currentUserRole: OrganizationRole | null;
  currentUserId: string | null;
}) {
  const canManage = currentUserRole === "owner" || currentUserRole === "admin";
  const inviteEmail = useSignal("");
  const inviteRole = useSignal<OrganizationRole>("member");
  const memberList: OrganizationMember[] = members.members.value;
  const invitations: OrganizationInvitation[] = members.invitations.value;
  const status = members.status.value;
  const busy = members.busy.value;
  const error = members.error.value;

  const onInvite = async (event: Event) => {
    event.preventDefault();
    const email = inviteEmail.value;
    const role = inviteRole.value;
    const ok = await members.invite(email, role);
    if (ok) {
      inviteEmail.value = "";
      inviteRole.value = "member";
    }
  };

  return (
    <CollapsibleCard
      title="Members"
      defaultOpen
      aside={
        <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
          {memberList.length} {memberList.length === 1 ? "member" : "members"}
        </span>
      }
    >
      <SettingsCardBody>
        <Muted class="text-[13px] m-0 max-w-[760px]">
          Invite teammates to collaborate on this organization's release targets, integrations, and
          gate reviews. Owners and admins manage membership; members get read access to org-scoped
          scans and can act on releases.
        </Muted>

        {error ? <Alert tone="critical">{error}</Alert> : null}

        {canManage ? (
          <form
            class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,200px)_auto] gap-3 items-end"
            onSubmit={onInvite}
          >
            <Field label="Invite by email" for="inviteEmail">
              <Input
                id="inviteEmail"
                type="email"
                value={inviteEmail}
                placeholder="teammate@example.com"
                onInput={(e) => (inviteEmail.value = (e.target as HTMLInputElement).value)}
                disabled={busy}
                autoComplete="off"
              />
            </Field>
            <Field label="Role" for="inviteRole">
              <Select
                id="inviteRole"
                value={inviteRole.value}
                disabled={busy}
                onChange={(value) => (inviteRole.value = value as OrganizationRole)}
              >
                <option value="member">member</option>
                <option value="admin">admin</option>
              </Select>
            </Field>
            {/* h-[38px] matches the Input control height (13px × 1.55 line-height + padding + border); Button's leading-none makes it shorter otherwise. */}
            <Button
              type="submit"
              disabled={busy || !inviteEmail.value.trim()}
              class="shrink-0 h-[38px]"
            >
              {status === "inviting" ? "Sending…" : "Send invite"}
            </Button>
          </form>
        ) : null}
      </SettingsCardBody>

      <div>
        <MemberList
          members={memberList}
          canManage={canManage}
          currentUserId={currentUserId}
          busy={busy}
          onRemove={(userId) => void members.removeMember(userId)}
        />
      </div>

      {canManage ? (
        <div>
          <SettingsCardHeader
            title="Pending invites"
            aside={
              <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
                {invitations.length} pending
              </span>
            }
          />
          {invitations.length ? (
            <InvitationList
              invitations={invitations}
              busy={busy}
              onRevoke={(id) => void members.revokeInvitation(id)}
            />
          ) : (
            <SettingsCardBody inset="belowHeader" gap="none">
              <Muted class="text-[13px] m-0">No pending invitations.</Muted>
            </SettingsCardBody>
          )}
        </div>
      ) : null}
    </CollapsibleCard>
  );
}

function MemberList({
  members,
  canManage,
  currentUserId,
  busy,
  onRemove,
}: {
  members: OrganizationMember[];
  canManage: boolean;
  currentUserId: string | null;
  busy: boolean;
  onRemove: (userId: string) => void;
}) {
  return (
    <ul class="m-0 p-0 list-none">
      {members.map((member) => {
        const removable = canManage && !member.isOwner && member.userId !== currentUserId;
        return (
          <SettingsCardListItem key={member.userId}>
            <div class="flex flex-col gap-1.5 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-[14px] font-medium text-ink truncate">
                  {member.name || member.email || member.userId}
                </span>
                <Badge tone={roleTone(member.role)}>{member.role}</Badge>
              </div>
              <MonoDetail
                parts={[
                  <span key="email">{member.email ?? "no email on record"}</span>,
                  <span key="joined">joined {formatTimestamp(member.joinedAt)}</span>,
                ]}
              />
            </div>
            {removable ? (
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={() => onRemove(member.userId)}
                class="shrink-0"
              >
                Remove
              </Button>
            ) : null}
          </SettingsCardListItem>
        );
      })}
    </ul>
  );
}

function InvitationList({
  invitations,
  busy,
  onRevoke,
}: {
  invitations: OrganizationInvitation[];
  busy: boolean;
  onRevoke: (id: string) => void;
}) {
  return (
    <ul class="m-0 p-0 list-none">
      {invitations.map((invitation) => (
        <SettingsCardListItem key={invitation.id}>
          <div class="flex flex-col gap-1.5 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-[14px] font-medium text-ink truncate">{invitation.email}</span>
              <Badge tone={roleTone(invitation.role)}>{invitation.role}</Badge>
              {invitation.expired ? <Badge tone="critical">expired</Badge> : null}
            </div>
            <MonoDetail
              parts={[
                <span key="expires">
                  {invitation.expired ? "expired" : "expires"}{" "}
                  {formatTimestamp(invitation.expiresAt)}
                </span>,
                <span key="created">invited {formatTimestamp(invitation.createdAt)}</span>,
              ]}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onRevoke(invitation.id)}
            class="shrink-0"
          >
            Revoke
          </Button>
        </SettingsCardListItem>
      ))}
    </ul>
  );
}

function roleTone(role: OrganizationRole): BadgeTone {
  return role === "owner" ? "info" : "neutral";
}
