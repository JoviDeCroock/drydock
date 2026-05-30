import { useEffect } from "preact/hooks";
import { useModel, useSignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { isGithubAppUiEnabled } from "../../../lib/github-app-ui";
import { rememberDashboardReturnUrl } from "../../../lib/query-state";
import { sessionModel } from "../../../models/auth";
import { NpmConnectionModel } from "../../../models/npm-connection";
import { OrganizationModel } from "../../../models/organization";
import { GithubAppModel } from "../../../models/github-app";
import {
  Eyebrow,
  LoadingState,
  Muted,
  OrgSwitcher,
  PageShell,
  UserMenu,
} from "../../../components";
import { GithubAppSection } from "./GithubAppSection";
import { NpmConnectionSection } from "./NpmConnectionSection";

export default function SettingsPage() {
  const location = useLocation();
  const npm = useModel(NpmConnectionModel);
  const organizations = useModel(OrganizationModel);
  const githubApp = useModel(GithubAppModel);
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
      if (isGithubAppUiEnabled(organizations.activeOrganizationId.peek())) {
        await Promise.all([
          githubApp.loadConfig(),
          githubApp.loadInstallations(),
          githubApp.loadReleaseTargets(),
        ]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const reloadActiveOrgScopedData = async () => {
    const loaders: Promise<unknown>[] = [npm.load()];
    if (isGithubAppUiEnabled(organizations.activeOrganizationId.peek())) {
      githubApp.clearForm();
      if (!githubApp.configLoaded.peek()) loaders.push(githubApp.loadConfig());
      loaders.push(githubApp.loadInstallations(), githubApp.loadReleaseTargets());
    }
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

  const githubAppUiEnabled = isGithubAppUiEnabled(organizations.activeOrganizationId.value);

  if (!sessionChecked.value) {
    return (
      <PageShell>
        <SettingsHeader githubAppUiEnabled={githubAppUiEnabled} />
        <LoadingState title="Opening settings" detail="confirming session" />
      </PageShell>
    );
  }

  const user = sessionModel.user.value;
  const githubAppLoaded = githubAppUiEnabled ? githubApp.loaded.value : true;
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
      <SettingsHeader githubAppUiEnabled={githubAppUiEnabled} />

      {workspaceLoaded ? (
        <div class="flex flex-col gap-6">
          {githubAppUiEnabled ? <GithubAppSection githubApp={githubApp} /> : null}
          <NpmConnectionSection npm={npm} />
        </div>
      ) : (
        <LoadingState
          title="Loading settings"
          detail={loadingDetail(npmLoaded, githubAppLoaded, githubAppUiEnabled)}
        />
      )}
    </PageShell>
  );
}

function loadingDetail(
  npmLoaded: boolean,
  githubAppLoaded: boolean,
  githubAppUiEnabled: boolean,
): string {
  const parts: string[] = [];
  if (!npmLoaded) parts.push("checking npm connection");
  if (githubAppUiEnabled && !githubAppLoaded) parts.push("checking GitHub App");
  return parts.join(" · ");
}

function SettingsHeader({ githubAppUiEnabled }: { githubAppUiEnabled: boolean }) {
  return (
    <header class="flex flex-col gap-2 max-w-[640px]">
      <Eyebrow>Organization settings</Eyebrow>
      <h1 class="text-3xl font-semibold tracking-[-0.02em] m-0">Integrations &amp; access</h1>
      <Muted class="text-[14px] leading-[1.55] m-0">
        {githubAppUiEnabled
          ? "Connect npm so Drydock can fetch staged tarballs, and install the GitHub App so it can gate PyPI workflow releases for this organization."
          : "Connect npm so Drydock can fetch staged tarballs for this organization."}
      </Muted>
    </header>
  );
}
