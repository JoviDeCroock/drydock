import { useEffect } from "preact/hooks";
import { useModel, useSignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { rememberDashboardReturnUrl } from "../../lib/query-state";
import { sessionModel } from "../../models/auth";
import { NpmConnectionModel } from "../../models/npm-connection";
import { OrganizationModel } from "../../models/organization";
import {
  GithubAppModel,
  type InstallationStatus,
  type PublicGithubAppInstallation,
} from "../../models/github-app";
import {
  Alert,
  Badge,
  Button,
  Card,
  Eyebrow,
  Field,
  Input,
  LinkButton,
  LoadingState,
  MonoDetail,
  Muted,
  OrgSwitcher,
  PageShell,
  SectionLabel,
  UserMenu,
  type BadgeTone,
} from "../../components";

const GITHUB_APP_UI_ENABLED = import.meta.env.DEV;

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
      const loaders: Promise<unknown>[] = [organizations.load(), npm.load()];
      if (GITHUB_APP_UI_ENABLED) {
        loaders.push(githubApp.loadConfig(), githubApp.loadInstallations());
      }
      await Promise.all(loaders);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const reloadActiveOrgScopedData = async () => {
    const loaders: Promise<unknown>[] = [npm.load()];
    if (GITHUB_APP_UI_ENABLED) loaders.push(githubApp.loadInstallations());
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
  const githubAppLoaded = GITHUB_APP_UI_ENABLED ? githubApp.loaded.value : true;
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
          {GITHUB_APP_UI_ENABLED ? <GithubAppSection githubApp={githubApp} /> : null}
          <NpmConnectionSection npm={npm} />
        </div>
      ) : (
        <LoadingState title="Loading settings" detail={loadingDetail(npmLoaded, githubAppLoaded)} />
      )}
    </PageShell>
  );
}

function loadingDetail(npmLoaded: boolean, githubAppLoaded: boolean): string {
  const parts: string[] = [];
  if (!npmLoaded) parts.push("checking npm connection");
  if (GITHUB_APP_UI_ENABLED && !githubAppLoaded) parts.push("checking GitHub App");
  return parts.join(" · ");
}

function SettingsHeader() {
  return (
    <header class="flex flex-col gap-2 max-w-[640px]">
      <Eyebrow>Organization settings</Eyebrow>
      <h1 class="text-3xl font-semibold tracking-[-0.02em] m-0">Integrations &amp; access</h1>
      <Muted class="text-[14px] leading-[1.55] m-0">
        {GITHUB_APP_UI_ENABLED
          ? "Connect npm so Drydock can fetch staged tarballs, and install the GitHub App so it can gate PyPI workflow releases for this organization."
          : "Connect npm so Drydock can fetch staged tarballs for this organization."}
      </Muted>
    </header>
  );
}

function GithubAppSection({
  githubApp,
}: {
  githubApp: ReturnType<typeof useModel<typeof GithubAppModel.prototype>>;
}) {
  const configured = githubApp.config.value?.configured === true;
  const appSlug = githubApp.config.value?.appSlug;
  const installations = githubApp.installations.value;
  const status = githubApp.status.value;
  const error = githubApp.error.value;
  const lastLinked = githubApp.lastLinked.value;
  const busy = githubApp.busy.value;

  const onInstall = () => {
    void githubApp.startInstall();
  };

  return (
    <Card as="section" class="p-0 overflow-hidden">
      <div class="p-5 flex flex-col gap-5">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="flex flex-col gap-1.5 max-w-[760px]">
            <SectionLabel>GitHub App</SectionLabel>
            <Muted class="text-[13px] m-0">
              Install the Drydock GitHub App on your organization so PyPI releases gated by a GitHub
              Actions environment can be approved here. We never ask for PyPI credentials — the
              workflow keeps its OIDC trust with PyPI and Drydock only acts as the
              deployment-protection approver.
            </Muted>
            <MonoDetail
              parts={[
                <span key="ecosystem">pypi workflow gate</span>,
                <span key="oidc">no pypi credentials</span>,
                <span key="env">github environment required</span>,
              ]}
            />
          </div>
          <div class="flex flex-col items-end gap-2 shrink-0">
            {configured ? (
              <Badge tone="ok">configured</Badge>
            ) : (
              <Badge tone="info">not configured</Badge>
            )}
            {configured && appSlug ? (
              <span class="font-mono text-[11px] text-ink-subtle">{appSlug}</span>
            ) : null}
          </div>
        </div>

        {!configured ? (
          <Alert tone="warn">
            GitHub App is not configured yet — ask the operator to add the GitHub App secrets (
            <code class="font-mono text-[12px]">GITHUB_APP_ID</code>,{" "}
            <code class="font-mono text-[12px]">GITHUB_APP_SLUG</code>,{" "}
            <code class="font-mono text-[12px]">GITHUB_APP_PRIVATE_KEY</code>, and the OAuth client
            + webhook secrets) on the Drydock Worker.
          </Alert>
        ) : null}

        {error ? <Alert tone="critical">{error}</Alert> : null}

        {lastLinked ? (
          <Alert tone="ok">
            Linked <strong>{lastLinked.accountLogin}</strong> · installation{" "}
            <code class="font-mono text-[12px]">{lastLinked.installationId}</code>.
          </Alert>
        ) : null}

        <div class="flex flex-wrap items-center gap-3">
          <Button onClick={onInstall} disabled={!configured || busy}>
            {status === "starting"
              ? "Redirecting…"
              : installations.length
                ? "Install on another organization"
                : "Install GitHub App"}
          </Button>
          <Muted class="text-[12px] m-0">
            You'll be sent to GitHub to pick which account to install on, then returned here.
          </Muted>
        </div>
      </div>

      <div class="border-t border-border">
        <div class="px-5 py-4 flex items-center justify-between gap-3">
          <SectionLabel>Linked installations</SectionLabel>
          <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
            {installations.length} linked
          </span>
        </div>
        {installations.length ? (
          <InstallationList installations={installations} />
        ) : (
          <div class="px-5 pb-5">
            <Muted class="text-[13px] m-0">No installations linked to this organization yet.</Muted>
          </div>
        )}
      </div>
    </Card>
  );
}

function InstallationList({ installations }: { installations: PublicGithubAppInstallation[] }) {
  return (
    <ul class="m-0 p-0 list-none border-t border-border">
      {installations.map((installation) => (
        <li
          key={installation.id}
          class="border-b border-border last:border-b-0 px-5 py-4 flex flex-wrap items-center justify-between gap-3"
        >
          <div class="flex flex-col gap-1.5 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-mono text-[14px] font-medium">{installation.accountLogin}</span>
              <Badge tone={installationStatusTone(installation.status)}>
                {installation.status}
              </Badge>
              <Badge tone="neutral">{installation.accountType.toLowerCase()}</Badge>
            </div>
            <MonoDetail
              parts={[
                <span key="installation">installation {installation.installationId}</span>,
                <span key="target">{installation.targetType.toLowerCase()}</span>,
                <span key="linked">linked {formatDate(installation.installedAt)}</span>,
              ]}
            />
          </div>
          {installation.status !== "active" ? (
            <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
              {installation.status === "suspended"
                ? "re-enable on github to use"
                : "removed on github · re-install to reconnect"}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function installationStatusTone(status: InstallationStatus): BadgeTone {
  switch (status) {
    case "active":
      return "ok";
    case "suspended":
      return "medium";
    case "uninstalled":
      return "critical";
  }
}

function NpmConnectionSection({
  npm,
}: {
  npm: ReturnType<typeof useModel<typeof NpmConnectionModel.prototype>>;
}) {
  const connection = npm.connection.value;
  const status = npm.status.value;
  const busy = npm.busy.value;
  const validated = npm.validated.value;
  const token = npm.token.value;
  const label = npm.label.value;
  const registry = npm.registry.value;
  const validationStageId = npm.validationStageId.value;
  const error = npm.error.value;

  const onSave = async (event: Event) => {
    event.preventDefault();
    await npm.save();
  };

  return (
    <Card as="section" class="p-5">
      <div class="flex flex-col gap-5">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="flex flex-col gap-1.5 max-w-[760px]">
            <SectionLabel>npm access</SectionLabel>
            <Muted class="text-[13px] m-0">
              Add an organization npm token so reviews can fetch staged packages securely. We
              encrypt it, hide it after save, and use it only to retrieve release evidence.
            </Muted>
          </div>
          {connection ? (
            <Badge
              tone={
                validated ? "ok" : connection.validationStatus === "invalid" ? "critical" : "info"
              }
            >
              {connection.validationStatus}
            </Badge>
          ) : (
            <Badge tone="info">not connected</Badge>
          )}
        </div>

        {connection ? (
          <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-x-6 gap-y-2 border-y border-border py-3">
            <CompactMetadataRow label="label" value={connection.label} />
            <CompactMetadataRow label="registry" value={connection.registryUrl} />
            <CompactMetadataRow label="token" value={`•••• ${connection.tokenLast4 || "stored"}`} />
            <CompactMetadataRow
              label="validated"
              value={connection.validatedAt ? formatDate(connection.validatedAt) : "not yet"}
            />
            <CompactMetadataRow
              label="last used"
              value={connection.lastUsedAt ? formatDate(connection.lastUsedAt) : "never"}
            />
          </div>
        ) : null}

        <form
          class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)_auto] gap-3 items-end"
          onSubmit={onSave}
        >
          <Field label="Connection name" for="npmLabel">
            <Input
              id="npmLabel"
              type="text"
              value={label}
              onInput={(e) => (npm.label.value = (e.target as HTMLInputElement).value)}
              disabled={busy}
            />
          </Field>
          <Field label="Registry" for="npmRegistry">
            <Input
              id="npmRegistry"
              type="url"
              value={registry}
              onInput={(e) => (npm.registry.value = (e.target as HTMLInputElement).value)}
              disabled={busy}
            />
          </Field>
          <Field label={connection ? "New npm token" : "npm token"} for="npmToken">
            <Input
              id="npmToken"
              type="password"
              value={token}
              placeholder={connection ? "Paste a new token to rotate" : "npm_..."}
              onInput={(e) => (npm.token.value = (e.target as HTMLInputElement).value)}
              disabled={busy}
              autoComplete="off"
              spellcheck={false}
            />
          </Field>
          <Button type="submit" disabled={busy || !token.trim()} class="shrink-0">
            {status === "saving"
              ? "Saving…"
              : status === "validating"
                ? "Checking…"
                : connection
                  ? "Rotate"
                  : "Save"}
          </Button>
        </form>

        <div class="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
          <Field label="Stage ID access check" for="validationStageId">
            <Input
              id="validationStageId"
              type="text"
              value={validationStageId}
              placeholder="Paste a real stage ID to confirm package access"
              onInput={(e) => (npm.validationStageId.value = (e.target as HTMLInputElement).value)}
              disabled={busy || !connection}
              autoComplete="off"
              spellcheck={false}
            />
          </Field>
          <Button
            variant="secondary"
            onClick={() => void npm.validate()}
            disabled={busy || !connection}
            class="shrink-0"
          >
            {status === "validating"
              ? "Checking…"
              : validationStageId.trim()
                ? "Check stage access"
                : "Check npm auth"}
          </Button>
        </div>

        <Muted class="text-xs">
          Saving runs the npm auth check automatically. Add a stage ID to prove the token can read
          that staged release; we do not keep the release archive.
        </Muted>

        {error ? <Alert tone="critical">{error}</Alert> : null}

        {connection ? (
          <div class="flex items-center justify-between border-t border-border pt-4 gap-3">
            <LinkButton variant="ghost" size="sm" href="/dashboard">
              Back to dashboard
            </LinkButton>
            <Button variant="danger" size="sm" onClick={() => void npm.remove()} disabled={busy}>
              {status === "deleting" ? "Removing…" : "Disconnect npm"}
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function CompactMetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div class="grid grid-cols-[92px_minmax(0,1fr)] gap-3 text-[13px] min-w-0">
      <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">{label}</span>
      <code class="text-xs text-ink-muted break-all">{value}</code>
    </div>
  );
}

function formatDate(value: string | number | Date | null | undefined) {
  if (value === null || value === undefined) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
