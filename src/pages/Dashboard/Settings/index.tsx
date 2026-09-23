import { useEffect, useRef } from "preact/hooks";
import { useModel, useSignal, useSignalEffect } from "@preact/signals";
import { useLocation } from "preact-iso";
import { buildQueryUrl, useQuerySignal } from "../../../lib/query-state";
import { sessionModel } from "../../../models/auth";
import { useAuthedDashboardSession } from "../../../features/account/useAuthedDashboardSession";
import { AuditLogModel } from "../../../models/audit-log";
import { NpmConnectionModel } from "../../../models/npm-connection";
import { NotificationRecipientsModel } from "../../../models/notification-recipients";
import { SlackConnectionModel } from "../../../models/slack-connection";
import { OrganizationModel } from "../../../models/organization";
import { GithubAppModel } from "../../../models/github-app";
import { ReleaseTargetsModel } from "../../../models/release-targets";
import { MembersModel } from "../../../models/organization-members";
import {
  normalizeRole,
  roleCanManageIntegrations,
  roleCanManageMembers,
  type OrganizationRole,
} from "../../../../server/lib/auth/roles";
import { LoadingState } from "../../../components/Loading";
import { PageShell } from "../../../components/PageShell";
import { AppHeaderActions } from "../../../features/account/AppHeaderActions";
import { EmailVerificationBanner } from "../../../features/account/EmailVerificationBanner";
import { Muted } from "../../../components/Typography";
import { GeneralSection, OrganizationDangerZone } from "./GeneralSection";
import { ReleaseSecuritySection } from "./ReleaseSecuritySection";
import { GateSetupWizard } from "./GateSetupWizard";
import { GithubAppSection } from "./GithubAppSection";
import { NotificationRecipientsSection } from "./NotificationRecipientsSection";
import { SlackConnectionSection } from "./SlackConnectionSection";
import { NpmConnectionSection } from "./NpmConnectionSection";
import { OrganizationMembersSection } from "./OrganizationMembersSection";
import { AuditLogSection } from "./AuditLogSection";
import { SettingsNav } from "./SettingsNav";
import {
  SETTINGS_SECTION,
  SETTINGS_TABS,
  isSettingsTab,
  scrollToSettingsSection,
  type SettingsTab,
} from "./settings-links";

export default function SettingsPage() {
  const location = useLocation();
  const npm = useModel(NpmConnectionModel);
  const organizations = useModel(OrganizationModel);
  const githubApp = useModel(GithubAppModel);
  const targets = useModel(ReleaseTargetsModel);
  const members = useModel(MembersModel);
  const recipients = useModel(NotificationRecipientsModel);
  const slack = useModel(SlackConnectionModel);
  const audit = useModel(AuditLogModel);
  const activeTab = useSignal<SettingsTab>("general");
  const gateSetupDeepLink = useSignal(false);
  const gateSetupHashHandled = useSignal(false);

  useQuerySignal(activeTab, {
    name: "tab",
    parse: (raw) => (isSettingsTab(raw) ? raw : "general"),
    serialize: (value) => (value === "general" ? null : value),
  });

  // Other surfaces deep-link to /dashboard/settings#gate-setup. The wizard is on
  // the integrations tab, so the hash has to select the tab before the browser
  // has anything to scroll to; the wizard itself does the scrolling once it
  // mounts.
  //
  // Once per arrival. Query writes keep the hash (`buildQueryUrl`), so every
  // tab change is a new `location.url` still ending in `#gate-setup`; reacting
  // to each one snapped the page back to Integrations the moment the maintainer
  // picked another tab.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash !== "#gate-setup") {
      gateSetupHashHandled.value = false;
      return;
    }
    if (gateSetupHashHandled.peek()) return;
    gateSetupHashHandled.value = true;
    gateSetupDeepLink.value = true;
    activeTab.value = "integrations";
  }, [location.url]);

  // The deep link describes the arrival, not the page: after the maintainer
  // leaves Integrations, coming back must not reopen the wizard's card and
  // scroll them to it again.
  useSignalEffect(() => {
    if (activeTab.value !== "integrations") gateSetupDeepLink.value = false;
  });

  // Surface the result of the Slack OAuth callback redirect, then strip the
  // one-shot params so a refresh doesn't replay the notice.
  useEffect(() => {
    const slackParam = location.query.slack;
    if (!slackParam) return;
    slack.noteCallback(slackParam, location.query.slackError);
    location.route(buildQueryUrl({ slack: null, slackError: null }), true);
  }, [location.query.slack]);

  const sessionChecked = useAuthedDashboardSession({
    onReady: async (_session, isCancelled) => {
      await organizations.load();
      if (isCancelled()) return;
      await Promise.all([
        npm.load(),
        githubApp.loadConfig(),
        githubApp.loadInstallations(),
        targets.load(),
        members.load(canManageMembers(organizations)),
        recipients.load(organizations.active.peek()?.id ?? null),
        slack.load(organizations.active.peek()?.id ?? null),
        audit.load(canManageMembers(organizations)),
      ]);
    },
  });

  const reloadActiveOrgScopedData = async () => {
    const loaders: Promise<unknown>[] = [npm.load(), members.load(canManageMembers(organizations))];
    targets.clearForm();
    if (!githubApp.configLoaded.peek()) loaders.push(githubApp.loadConfig());
    loaders.push(githubApp.loadInstallations(), targets.load());
    loaders.push(recipients.load(organizations.active.peek()?.id ?? null));
    loaders.push(slack.load(organizations.active.peek()?.id ?? null));
    loaders.push(audit.load(canManageMembers(organizations)));
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

  const workspaceLoaded =
    githubApp.loaded.value && targets.releaseTargetsLoaded.value && npm.loaded.value;
  useScrollToHashSection(workspaceLoaded, activeTab.value, location.url);

  if (!sessionChecked.value) {
    return (
      <PageShell headerActions={<AppHeaderActions current="settings" />}>
        <SettingsHeader />
        <LoadingState title="Opening settings" detail="confirming session" />
      </PageShell>
    );
  }

  const user = sessionModel.user.value;
  const githubAppLoaded = githubApp.loaded.value && targets.releaseTargetsLoaded.value;
  const npmLoaded = npm.loaded.value;
  // The audit log is owner/admin-only: hide the tab from members and fall back
  // to General if a member deep-links to ?tab=audit (the endpoint 403s anyway).
  const canViewAudit = canManageMembers(organizations);
  const activeGithubInstallations = githubApp.installations.value.filter(
    (row) => row.status === "active",
  );
  const requestedTab = activeTab.value;
  const tab = requestedTab === "audit" && !canViewAudit ? "general" : requestedTab;
  const visibleTabs = SETTINGS_TABS.filter((entry) => entry.id !== "audit" || canViewAudit);

  return (
    <PageShell
      headerActions={
        <AppHeaderActions
          current="settings"
          organizations={organizations}
          onActivate={onSwitchOrganization}
          onCreate={onCreateOrganization}
        />
      }
    >
      <SettingsHeader />

      <EmailVerificationBanner />

      {workspaceLoaded ? (
        <div class="grid grid-cols-1 md:grid-cols-[200px_minmax(0,1fr)] gap-6 md:gap-8">
          <SettingsNav active={tab} tabs={visibleTabs} />

          <div class="min-w-0 flex flex-col gap-6">
            {tab === "general" ? (
              <>
                <GeneralSection
                  organizations={organizations}
                  currentUserRole={activeRole(organizations)}
                />
                <ReleaseSecuritySection
                  organizations={organizations}
                  currentUserRole={activeRole(organizations)}
                />
                <OrganizationDangerZone
                  organizations={organizations}
                  currentUserRole={activeRole(organizations)}
                  onDeleted={reloadActiveOrgScopedData}
                />
              </>
            ) : null}
            {tab === "members" ? (
              <OrganizationMembersSection
                members={members}
                currentUserRole={activeRole(organizations)}
                currentUserId={user?.id ?? null}
              />
            ) : null}
            {tab === "notifications" ? (
              <>
                <NotificationRecipientsSection
                  recipients={recipients}
                  organizationId={organizations.active.value?.id ?? null}
                  canManage={canManageIntegrations(organizations)}
                  fallbackEmail={ownerFallbackEmail(organizations, user)}
                  defaultOpen
                />
                <SlackConnectionSection
                  slack={slack}
                  canManage={canManageIntegrations(organizations)}
                  defaultOpen
                />
              </>
            ) : null}
            {tab === "integrations" ? (
              <>
                <div id={SETTINGS_SECTION.npmAccess} class={SECTION_ANCHOR_CLASS}>
                  <NpmConnectionSection
                    key={organizations.active.value?.id}
                    npm={npm}
                    organizations={organizations}
                    onSwitchOrganization={onSwitchOrganization}
                    defaultOpen
                  />
                </div>
                <div id={SETTINGS_SECTION.githubApp} class={SECTION_ANCHOR_CLASS}>
                  <GithubAppSection githubApp={githubApp} targets={targets} defaultOpen />
                </div>
                {/* Always rendered: the wizard owns the #gate-setup anchor, and
                    the audience deep-linking to it is precisely the one that has
                    not installed the App yet. */}
                <GateSetupWizard
                  activeInstallations={activeGithubInstallations}
                  releaseTargets={targets.releaseTargets.value}
                  gateSetupEcosystems={githubApp.config.value?.gateSetupEcosystems ?? []}
                  canManage={canManageIntegrations(organizations)}
                  onReleaseTargetsChanged={() => void targets.load()}
                  onInstall={() => void githubApp.startInstall()}
                  installDisabled={
                    githubApp.config.value?.configured !== true || githubApp.busy.value
                  }
                  deepLinked={gateSetupDeepLink.value}
                />
              </>
            ) : null}
            {tab === "audit" && canViewAudit ? (
              <AuditLogSection audit={audit} organizationId={organizations.active.value?.id} />
            ) : null}
          </div>
        </div>
      ) : (
        <LoadingState title="Loading settings" detail={loadingDetail(npmLoaded, githubAppLoaded)} />
      )}
    </PageShell>
  );
}

// Leaves breathing room above a section scrolled to from a link.
const SECTION_ANCHOR_CLASS = "scroll-mt-6";

/**
 * Land a `#section` deep link once the tab holding it has rendered. Each
 * tab/hash pair scrolls once, so reloading data (switching organizations)
 * never yanks the page back to the anchor.
 */
// `url` is preact-iso's location: a section link clicked while already on its
// tab changes it (the hash rides along on link clicks), so that scrolls too.
function useScrollToHashSection(contentReady: boolean, tab: SettingsTab, url: string) {
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    const hash = window.location.hash;
    // preact-iso's url carries the hash after some navigations and not after
    // others; key on the address without it so one tab/section pair scrolls
    // once however the reader arrived.
    const key = `${tab}${url.split("#")[0]}${hash}`;
    if (!contentReady || !hash || scrolledFor.current === key) return;
    const frame = window.requestAnimationFrame(() => {
      if (scrollToSettingsSection(hash, document)) scrolledFor.current = key;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [contentReady, tab, url]);
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

function canManageIntegrations(
  organizations: ReturnType<typeof useModel<typeof OrganizationModel.prototype>>,
): boolean {
  return roleCanManageIntegrations(activeRole(organizations));
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
      <h1 class="text-3xl font-semibold tracking-[-0.02em] m-0">Organization settings</h1>
      <Muted class="text-[14px] leading-[1.55] m-0">
        Manage members, notifications, and the npm or GitHub connections Drydock uses to hold
        releases for review.
      </Muted>
    </header>
  );
}
