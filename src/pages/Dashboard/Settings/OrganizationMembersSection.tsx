import { useComputed, useModel, useSignal } from "@preact/signals";
import type { OrganizationRole } from "../../../../server/lib/auth/roles";
import { formatDateTime } from "../../../lib/format";
import {
  MembersModel,
  type OrganizationInvitation,
  type OrganizationMember,
} from "../../../models/organization-members";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import {
  Card,
  SettingsCardBody,
  SettingsCardHeader,
  SettingsCardListItem,
} from "../../../components/Card";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { Select } from "../../../components/Select";
import { MonoDetail, MonoLabel, Muted, SectionLabel } from "../../../components/Typography";

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
  const roleHint = useComputed(() =>
    inviteRole.value === "admin"
      ? "Admins also manage members and integrations."
      : "Owners and admins manage members and integrations.",
  );
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
    // The only section on its tab, so it is a plain card: collapsing it would
    // leave the tab empty.
    <Card as="section" padding="none">
      <div class="px-5 py-4">
        <SectionLabel
          as="h2"
          aside={
            <MonoLabel>
              {memberList.length} {memberList.length === 1 ? "member" : "members"}
            </MonoLabel>
          }
        >
          Members
        </SectionLabel>
      </div>
      <SettingsCardBody>
        <Muted class="text-[13px] m-0 max-w-[680px]">
          Members see this organization's reviews and record release decisions.
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
            <Muted class="m-0 -mt-1.5 text-[12px] leading-[1.5] lg:row-start-2 lg:col-start-1">
              The invite shows your name and email address.
            </Muted>
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
            {/* The role explanation sits under the Role select on wide screens and
                before the submit on narrow ones. */}
            <Muted class="m-0 -mt-1.5 text-[12px] leading-[1.5] lg:row-start-2 lg:col-start-2">
              {roleHint}
            </Muted>
            {/* h-[38px] matches the Input control height (13px × 1.55 line-height + padding + border); Button's leading-none makes it shorter otherwise. */}
            <Button
              type="submit"
              disabled={busy || !inviteEmail.value.trim()}
              class="shrink-0 h-[38px] lg:row-start-1 lg:col-start-3"
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
            aside={invitations.length ? <MonoLabel>{invitations.length} pending</MonoLabel> : null}
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
    </Card>
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
              </div>
              <MonoDetail
                parts={[
                  <span key="role">{member.role}</span>,
                  <span key="email">{member.email ?? "no email on record"}</span>,
                  <span key="joined">joined {formatDateTime(member.joinedAt)}</span>,
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
            </div>
            <MonoDetail
              parts={[
                <span key="role">{invitation.role}</span>,
                <span key="expires" class={invitation.expired ? "text-warn-text" : undefined}>
                  {invitation.expired ? "expired" : "expires"}{" "}
                  {formatDateTime(invitation.expiresAt)}
                </span>,
                <span key="created">invited {formatDateTime(invitation.createdAt)}</span>,
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
