import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { useComputed, useModel, useSignal, useSignalEffect } from "@preact/signals";
import { useLocation } from "preact-iso";
import { sessionModel } from "../../models/auth";
import {
  MembersModel,
  type OrganizationInvite,
  type OrganizationMember,
  type OrganizationRole,
} from "../../models/members";
import { OrganizationModel } from "../../models/organization";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyLine,
  Eyebrow,
  Field,
  Input,
  LoadingState,
  Muted,
  PageShell,
  SectionLabel,
} from "../../components";

export default function SettingsPage() {
  const location = useLocation();
  const organizations = useModel(OrganizationModel);
  const members = useModel(MembersModel);
  const sessionChecked = useSignal(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const data = await sessionModel.load();
      if (cancelled) return;
      if (!data) {
        location.route("/login", true);
        return;
      }
      sessionChecked.value = true;
      await organizations.load();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useSignalEffect(() => {
    const active = organizations.active.value;
    const loadedFor = members.organizationId.value;
    if (!active) return;
    if (loadedFor === active.id) return;
    void members.load(active.id);
  });

  const onSignOut = async () => {
    await sessionModel.signOut();
    location.route("/", true);
  };

  if (!sessionChecked.value) {
    return (
      <PageShell>
        <LoadingState title="Opening settings" detail="confirming session" />
      </PageShell>
    );
  }

  const user = sessionModel.user.value;
  const active = organizations.active.value;

  return (
    <PageShell
      headerActions={
        <div class="flex items-center gap-2.5 bg-surface border border-border rounded-lg pl-3.5 pr-1.5 py-1.5">
          <span class="font-mono text-xs text-ink-muted">
            {user?.email || user?.name || "signed in"}
          </span>
          <Button variant="secondary" size="sm" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      }
    >
      <header class="flex flex-col gap-2 max-w-[720px]">
        <Eyebrow>Organization settings</Eyebrow>
        <h1 class="text-3xl font-semibold tracking-[-0.02em] m-0">
          {active ? active.name : "Loading organization"}
        </h1>
        <Muted class="text-[14px] leading-[1.55] m-0">
          Manage who can review staged releases in this workspace. Invites are share-link based and
          expire after 7 days.
        </Muted>
        <div class="flex items-center gap-2 mt-1">
          <a href="/dashboard" class="text-[13px] underline">
            ← Back to dashboard
          </a>
        </div>
      </header>

      {!active ? (
        <LoadingState title="Loading organization" detail="fetching members" />
      ) : active.isPersonal ? (
        <Card class="p-5">
          <Alert tone="info">
            This is your personal workspace. Create a separate organization from the dashboard to
            invite teammates.
          </Alert>
        </Card>
      ) : !members.loaded.value ? (
        <LoadingState title="Loading members" detail="fetching membership and invites" />
      ) : (
        <SettingsBody members={members} />
      )}
    </PageShell>
  );
}

function SettingsBody({
  members,
}: {
  members: ReturnType<typeof useModel<typeof MembersModel.prototype>>;
}) {
  const isOwner = useComputed(() => members.viewerRole.value === "owner");

  return (
    <div class="flex flex-col gap-6">
      {members.error.value ? <Alert tone="critical">{members.error.value}</Alert> : null}

      <MembersTable members={members} canManage={isOwner.value} />

      {isOwner.value ? (
        <>
          <InviteForm members={members} />
          <InvitesTable members={members} />
        </>
      ) : (
        <Card class="p-5">
          <Muted class="text-[13px] m-0">
            Only organization owners can invite teammates or remove members.
          </Muted>
        </Card>
      )}
    </div>
  );
}

function MembersTable({
  members,
  canManage,
}: {
  members: ReturnType<typeof useModel<typeof MembersModel.prototype>>;
  canManage: boolean;
}) {
  const rows: OrganizationMember[] = members.members.value;
  return (
    <section class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-3">
        <SectionLabel>Members</SectionLabel>
        <Muted class="text-[12px] m-0">{rows.length} total</Muted>
      </div>
      <Card class="p-0 overflow-hidden">
        {rows.length === 0 ? (
          <div class="p-5">
            <EmptyLine>No members yet.</EmptyLine>
          </div>
        ) : (
          <div class="overflow-x-auto">
            <table class="w-full border-collapse text-[13px]">
              <thead>
                <tr class="border-b border-border bg-surface-2">
                  <Th>Member</Th>
                  <Th>Role</Th>
                  <Th>Joined</Th>
                  {canManage ? <Th>{""}</Th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((member) => (
                  <tr key={member.userId} class="border-b border-border last:border-b-0">
                    <Td>
                      <div class="flex flex-col gap-0.5 min-w-0">
                        <span class="text-ink">{member.name || member.email || member.userId}</span>
                        {member.email && member.name ? (
                          <span class="font-mono text-xs text-ink-muted">{member.email}</span>
                        ) : null}
                      </div>
                    </Td>
                    <Td>
                      <Badge tone={member.isOwner ? "ok" : "info"}>
                        {member.isOwner ? "owner" : member.role}
                      </Badge>
                    </Td>
                    <Td class="font-mono text-xs text-ink-muted">{formatDate(member.joinedAt)}</Td>
                    {canManage ? (
                      <Td class="text-right">
                        {member.isOwner ? (
                          <Muted class="text-xs m-0">primary owner</Muted>
                        ) : (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => void members.remove(member.userId)}
                            disabled={members.busy.value}
                          >
                            Remove
                          </Button>
                        )}
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </section>
  );
}

function InviteForm({
  members,
}: {
  members: ReturnType<typeof useModel<typeof MembersModel.prototype>>;
}) {
  const email = useSignal("");
  const role = useSignal<OrganizationRole>("member");

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    const submittedRole = role.value;
    const submittedEmail = email.value;
    const created = await members.invite(submittedRole, submittedEmail);
    if (created) {
      email.value = "";
    }
  };

  return (
    <Card class="p-5 flex flex-col gap-4 border-accent/40">
      <div class="flex flex-col gap-1.5">
        <SectionLabel>Invite a teammate</SectionLabel>
        <Muted class="text-[13px] max-w-[680px]">
          We generate a one-time invite link. Send it to the teammate you want to add — when they
          sign in and open it, they join this organization.
        </Muted>
      </div>
      <form
        class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,160px)_auto] gap-3 items-end"
        onSubmit={onSubmit}
      >
        <Field label="Email (optional, just for your records)" for="inviteEmail">
          <Input
            id="inviteEmail"
            type="email"
            value={email}
            placeholder="teammate@example.com"
            onInput={(e) => (email.value = (e.target as HTMLInputElement).value)}
            disabled={members.busy.value}
            autoComplete="off"
            spellcheck={false}
          />
        </Field>
        <Field label="Role" for="inviteRole">
          <select
            id="inviteRole"
            value={role.value}
            onChange={(e) =>
              (role.value = (e.target as HTMLSelectElement).value as OrganizationRole)
            }
            disabled={members.busy.value}
            class="bg-bg border border-border rounded-md text-[13px] text-ink px-3 py-2 outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)] disabled:opacity-60 disabled:cursor-not-allowed font-mono"
          >
            <option value="member">member</option>
            <option value="owner">owner</option>
          </select>
        </Field>
        <Button type="submit" disabled={members.busy.value} class="shrink-0">
          {members.busy.value ? "Creating…" : "Create invite link"}
        </Button>
      </form>
      {members.lastInviteUrl.value ? (
        <InviteLinkReveal
          url={members.lastInviteUrl.value}
          onDismiss={() => members.clearInviteUrl()}
        />
      ) : null}
    </Card>
  );
}

function InviteLinkReveal({ url, onDismiss }: { url: string; onDismiss: () => void }) {
  const copied = useSignal(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      copied.value = true;
      window.setTimeout(() => {
        copied.value = false;
      }, 2000);
    } catch {
      copied.value = false;
    }
  };

  return (
    <div class="flex flex-col gap-2 border border-accent/30 bg-accent/5 rounded-md p-3">
      <div class="flex items-center justify-between gap-2">
        <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
          Share this link once
        </span>
        <button
          type="button"
          onClick={onDismiss}
          class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle hover:text-ink"
        >
          dismiss
        </button>
      </div>
      <div class="flex items-center gap-2">
        <code class="flex-1 text-xs text-ink-muted break-all bg-bg border border-border rounded px-2 py-1.5">
          {url}
        </code>
        <Button variant="secondary" size="sm" onClick={() => void onCopy()} class="shrink-0">
          {copied.value ? "Copied" : "Copy"}
        </Button>
      </div>
      <Muted class="text-xs m-0">
        We do not store the link itself — only its hash. Save it somewhere safe before you close
        this view.
      </Muted>
    </div>
  );
}

function InvitesTable({
  members,
}: {
  members: ReturnType<typeof useModel<typeof MembersModel.prototype>>;
}) {
  const rows: OrganizationInvite[] = members.invites.value;
  return (
    <section class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-3">
        <SectionLabel>Invites</SectionLabel>
        <Muted class="text-[12px] m-0">{rows.length} total</Muted>
      </div>
      <Card class="p-0 overflow-hidden">
        {rows.length === 0 ? (
          <div class="p-5">
            <EmptyLine>No invites yet. Create one above to bring in a teammate.</EmptyLine>
          </div>
        ) : (
          <div class="overflow-x-auto">
            <table class="w-full border-collapse text-[13px]">
              <thead>
                <tr class="border-b border-border bg-surface-2">
                  <Th>Email / token</Th>
                  <Th>Role</Th>
                  <Th>Status</Th>
                  <Th>Expires</Th>
                  <Th>Created</Th>
                  <Th>{""}</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((invite) => (
                  <tr key={invite.id} class="border-b border-border last:border-b-0">
                    <Td>
                      <div class="flex flex-col gap-0.5 min-w-0">
                        <span class="text-ink">{invite.email || "—"}</span>
                        <span class="font-mono text-xs text-ink-muted">
                          inv_••••{invite.tokenLast4 || "----"}
                        </span>
                      </div>
                    </Td>
                    <Td>
                      <Badge tone="info">{invite.role}</Badge>
                    </Td>
                    <Td>
                      <Badge tone={inviteStatusTone(invite.status)}>{invite.status}</Badge>
                    </Td>
                    <Td class="font-mono text-xs text-ink-muted">{formatDate(invite.expiresAt)}</Td>
                    <Td class="font-mono text-xs text-ink-muted">{formatDate(invite.createdAt)}</Td>
                    <Td class="text-right">
                      {invite.status === "pending" ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => void members.revoke(invite.id)}
                          disabled={members.busy.value}
                        >
                          Revoke
                        </Button>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </section>
  );
}

function inviteStatusTone(status: string): "ok" | "info" | "critical" {
  if (status === "accepted") return "ok";
  if (status === "revoked" || status === "expired") return "critical";
  return "info";
}

function Th({ children }: { children: ComponentChildren }) {
  return (
    <th class="text-left font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle px-4 py-2.5">
      {children}
    </th>
  );
}

function Td({ children, class: className }: { children: ComponentChildren; class?: string }) {
  return <td class={`px-4 py-2.5 align-middle ${className || ""}`}>{children}</td>;
}

function formatDate(value: string | number | Date | null | undefined) {
  if (value === null || value === undefined) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
