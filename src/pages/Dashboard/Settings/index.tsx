import { useEffect } from "preact/hooks";
import { useModel, useSignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { rememberDashboardReturnUrl } from "../../../lib/query-state";
import { sessionModel } from "../../../models/auth";
import { NpmConnectionModel } from "../../../models/npm-connection";
import { NotificationRecipientsModel } from "../../../models/notification-recipients";
import { OrganizationModel } from "../../../models/organization";
import { GithubAppModel } from "../../../models/github-app";
import { MembersModel } from "../../../models/organization-members";
import {
  normalizeRole,
  roleCanManageMembers,
  type OrganizationRole,
} from "../../../../server/lib/roles";
import {
  Eyebrow,
  LoadingState,
  Muted,
  OrgSwitcher,
  PageShell,
  UserMenu,
} from "../../../components";
import { GithubAppSection } from "./GithubAppSection";
import { NotificationRecipientsSection } from "./NotificationRecipientsSection";
import { NpmConnectionSection } from "./NpmConnectionSection";
import { OrganizationMembersSection } from "./OrganizationMembersSection";

export default function SettingsPage() {
  const location = useLocation();
  const npm = useModel(NpmConnectionModel);
  const organizations = useModel(OrganizationModel);
  const githubApp = useModel(GithubAppModel);
  const members = useModel(MembersModel);
  const recipients = useModel(NotificationRecipientsModel);
  const sessionChecked = useSignal(false);

  useEffect(() => {
    rememberDashboardReturnUrl(location.url);
  }, [location.url]);

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
      await Promise.all([organizations.load(), npm.load()]);
      if (cancelled) return;
      await Promise.all([
        githubApp.loadConfig(),
        githubApp.loadInstallations(),
        githubApp.loadReleaseTargets(),
        members.load(canManageMembers(organizations)),
        recipients.load(organizations.active.peek()?.id ?? null),
      ]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const reloadActiveOrgScopedData = async () => {
    const loaders: Promise<unknown>[] = [npm.load(), members.load(canManageMembers(organizations))];
    githubApp.clearForm();
    if (!githubApp.configLoaded.peek()) loaders.push(githubApp.loadConfig());
    loaders.push(githubApp.loadInstallations(), githubApp.loadReleaseTargets());
    loaders.push(recipients.load(organizations.active.peek()?.id ?? null));
    await Promise.all(loaders);
  };

  const onSwitchOrganization = async (organizationId: string) => {
    if (organizations.activate(organizationId)) {
      await reloadActiveOrgScopedData();
    }
  };

  const onCreateOrganization = async (name: string) => {
    const created = await organizations.create(name);
    if (created) {
      await reloadActiveOrgScopedData();
    }
  };

  const onSignOut = async () => {
    await sessionModel.signOut();
    location.route("/", true);
  };

  if (!sessionChecked.value) {
    return (
      <PageShell>
        <SettingsHeader />
        <LoadingState title="Opening settings" detail="confirming session" />
      </PageShell>
    );
  }

  const user = sessionModel.user.value;
  const githubAppLoaded = githubApp.loaded.value;
  const npmLoaded = npm.loaded.value;
  const workspaceLoaded = githubAppLoaded && npmLoaded;

  return (
    <PageShell
      headerActions={
        <>
          <OrgSwitcher
            organizations={organizations.organizations.value}
            activeOrganizationId={organizations.activeOrganizationId.value}
            busy={organizations.busy.value}
            error={organizations.error.value}
            onActivate={onSwitchOrganization}
            onCreate={onCreateOrganization}
          />
          <UserMenu email={user?.email} name={user?.name} onSignOut={onSignOut} />
        </>
      }
    >
      <SettingsHeader />

      {workspaceLoaded ? (
        <div class="flex flex-col gap-6">
          <OrganizationMembersSection
            members={members}
            currentUserRole={activeRole(organizations)}
            currentUserId={user?.id ?? null}
          />
          <NotificationRecipientsSection
            recipients={recipients}
            organizationId={organizations.active.value?.id ?? null}
            fallbackEmail={ownerFallbackEmail(organizations, user)}
          />
          <NpmConnectionSection npm={npm} />
          <GithubAppSection githubApp={githubApp} />
        </div>
      ) : (
        <LoadingState title="Loading settings" detail={loadingDetail(npmLoaded, githubAppLoaded)} />
      )}
    </PageShell>
  );
}

function activeRole(
  organizations: ReturnType<typeof useModel<typeof OrganizationModel.prototype>>,
): OrganizationRole | null {
  const role = organizations.active.value?.role;
  return role ? normalizeRole(role) : null;
}

function canManageMembers(
  organizations: ReturnType<typeof useModel<typeof OrganizationModel.prototype>>,
): boolean {
  return roleCanManageMembers(activeRole(organizations));
}

function ownerFallbackEmail(
  organizations: ReturnType<typeof useModel<typeof OrganizationModel.prototype>>,
  user: { id?: string | null; email?: string | null } | null,
): string | undefined {
  const active = organizations.active.value;
  if (!active?.ownerUserId || !user?.id || active.ownerUserId !== user.id) return undefined;
  return user.email ?? undefined;
}

function loadingDetail(npmLoaded: boolean, githubAppLoaded: boolean): string {
  const parts: string[] = [];
  if (!npmLoaded) parts.push("checking npm connection");
  if (!githubAppLoaded) parts.push("checking GitHub App");
  return parts.join(" · ");
}

function SettingsHeader() {
  return (
    <header class="flex flex-col gap-2 max-w-[640px]">
      <Eyebrow>Organization settings</Eyebrow>
      <h1 class="text-3xl font-semibold tracking-[-0.02em] m-0">Integrations &amp; access</h1>
      <Muted class="text-[14px] leading-[1.55] m-0">
        Connect npm so Drydock can fetch staged tarballs, and install the GitHub App so it can gate
        workflow releases for this organization.
      </Muted>
    </header>
  );
}
