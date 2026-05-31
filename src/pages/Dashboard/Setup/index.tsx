import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { useModel, useSignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { useQuerySignal } from "../../../lib/query-state";
import { sessionModel } from "../../../models/auth";
import { NpmConnectionModel } from "../../../models/npm-connection";
import { OrganizationModel } from "../../../models/organization";
import { GithubAppModel } from "../../../models/github-app";
import { StagedPublishesModel } from "../../../models/staged-publishes";
import {
  Button,
  Card,
  Eyebrow,
  LinkButton,
  LoadingState,
  Muted,
  OrgSwitcher,
  PageShell,
  SectionLabel,
  UserMenu,
} from "../../../components";
import { NpmFlow } from "./NpmFlow";
import { PypiFlow } from "./PypiFlow";

type Flow = "npm" | "pypi" | null;

function parseFlow(raw: string | undefined): Flow {
  return raw === "npm" || raw === "pypi" ? raw : null;
}

export default function SetupPage() {
  const location = useLocation();
  const npm = useModel(NpmConnectionModel);
  const organizations = useModel(OrganizationModel);
  const githubApp = useModel(GithubAppModel);
  const stagedPublishes = useModel(StagedPublishesModel);
  const sessionChecked = useSignal(false);
  const flow = useSignal<Flow>(null);

  useQuerySignal(flow, {
    name: "flow",
    parse: parseFlow,
    serialize: (value) => value,
  });

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
      ]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const reloadActiveOrgScopedData = async () => {
    githubApp.clearForm();
    stagedPublishes.reset();
    await Promise.all([npm.load(), githubApp.loadInstallations(), githubApp.loadReleaseTargets()]);
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
        <SetupHeader />
        <LoadingState title="Opening guided setup" detail="confirming session" />
      </PageShell>
    );
  }

  const user = sessionModel.user.value;
  const workspaceLoaded = npm.loaded.value && githubApp.loaded.value;
  const activeFlow = flow.value;

  return (
    <PageShell
      headerActions={
        <>
          <LinkButton variant="ghost" size="sm" href="/dashboard">
            Dashboard
          </LinkButton>
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
      <SetupHeader />

      {!workspaceLoaded ? (
        <LoadingState title="Loading guided setup" detail="checking npm and GitHub App" />
      ) : activeFlow === "npm" ? (
        <FlowFrame onBack={() => (flow.value = null)}>
          <NpmFlow npm={npm} stagedPublishes={stagedPublishes} />
        </FlowFrame>
      ) : activeFlow === "pypi" ? (
        <FlowFrame onBack={() => (flow.value = null)}>
          <PypiFlow githubApp={githubApp} />
        </FlowFrame>
      ) : (
        <EcosystemChooser onChoose={(next) => (flow.value = next)} />
      )}
    </PageShell>
  );
}

function SetupHeader() {
  return (
    <header class="flex flex-col gap-2 max-w-[680px]">
      <Eyebrow>Guided setup</Eyebrow>
      <h1 class="text-3xl font-semibold tracking-[-0.02em] m-0">Set up a publishing flow</h1>
      <Muted class="text-[14px] leading-[1.55] m-0">
        Drydock generates best-practice config and walks you through the few steps it can't do for
        you. Pick the ecosystem you publish to and work down the list — each step lights up as its
        state is satisfied.
      </Muted>
    </header>
  );
}

function FlowFrame({ onBack, children }: { onBack: () => void; children: ComponentChildren }) {
  return (
    <div class="flex flex-col gap-4">
      <button
        type="button"
        onClick={onBack}
        class="self-start font-mono text-[11px] text-ink-muted hover:text-ink transition-colors duration-150 ease-out cursor-pointer"
      >
        ← Choose a different ecosystem
      </button>
      {children}
    </div>
  );
}

function EcosystemChooser({ onChoose }: { onChoose: (flow: "npm" | "pypi") => void }) {
  return (
    <div class="flex flex-col gap-3">
      <SectionLabel>Pick an ecosystem</SectionLabel>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ChoiceCard
          label="npm"
          title="Staged publishing"
          description="CI stages the tarball through npm trusted publishing (OIDC) — no NPM_TOKEN. Drydock reviews the staged release and a maintainer approves the public publish with 2FA."
          cta="Set up npm staging"
          onClick={() => onChoose("npm")}
        />
        <ChoiceCard
          label="PyPI"
          title="GitHub Actions release gate"
          description="A tag-triggered workflow builds the wheel + sdist and pauses on a GitHub Environment. Drydock reviews the candidate, then the publish job resumes via Trusted Publishing — no PyPI token."
          cta="Set up PyPI gate"
          onClick={() => onChoose("pypi")}
        />
      </div>
    </div>
  );
}

function ChoiceCard({
  label,
  title,
  description,
  cta,
  onClick,
}: {
  label: string;
  title: string;
  description: string;
  cta: string;
  onClick: () => void;
}) {
  return (
    <Card as="article" class="p-5 flex flex-col gap-4">
      <div class="flex flex-col gap-1.5">
        <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
          {label}
        </span>
        <h2 class="text-[18px] font-medium tracking-[-0.01em] m-0">{title}</h2>
        <Muted class="text-[13px] leading-[1.55] m-0">{description}</Muted>
      </div>
      <Button variant="primary" size="sm" class="self-start" onClick={onClick}>
        {cta}
      </Button>
    </Card>
  );
}
