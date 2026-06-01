import type { ComponentChildren } from "preact";
import { useModel } from "@preact/signals";
import { formatTimestamp } from "../../../lib/format";
import {
  GithubAppModel,
  type InstallationStatus,
  type PublicGithubAppInstallation,
  type PublicReleaseTarget,
} from "../../../models/github-app";
import {
  Alert,
  Badge,
  Button,
  Card,
  MonoDetail,
  Muted,
  SectionLabel,
  type BadgeTone,
} from "../../../components";
import { ReleaseTargetForm } from "./ReleaseTargetForm";

export function GithubAppSection({
  githubApp,
}: {
  githubApp: ReturnType<typeof useModel<typeof GithubAppModel.prototype>>;
}) {
  const configured = githubApp.config.value?.configured === true;
  const appSlug = githubApp.config.value?.appSlug;
  const installations: PublicGithubAppInstallation[] = githubApp.installations.value;
  const status = githubApp.status.value;
  const error = githubApp.error.value;
  const lastLinked = githubApp.lastLinked.value;
  const busy = githubApp.busy.value;
  const releaseTargets: PublicReleaseTarget[] = githubApp.releaseTargets.value;
  const releaseTargetsError = githubApp.releaseTargetsError.value;
  const activeInstallations = installations.filter(
    (row: PublicGithubAppInstallation) => row.status === "active",
  );

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
              Install the Drydock GitHub App on your organization so releases gated by a GitHub
              Actions environment can be approved here. Drydock never asks for publish credentials —
              your workflow keeps its own OIDC/Trusted Publishing trust and Drydock only acts as the
              deployment-protection approver.
            </Muted>
            <MonoDetail
              parts={[
                <span key="ecosystem">workflow gate</span>,
                <span key="oidc">no publish credentials</span>,
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

        <PypiGateSetupGuide />
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

      <div class="border-t border-border">
        <div class="px-5 py-4 flex items-center justify-between gap-3">
          <SectionLabel>Release targets</SectionLabel>
          <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
            {releaseTargets.length} mapped
          </span>
        </div>
        {activeInstallations.length ? (
          <ReleaseTargetForm githubApp={githubApp} activeInstallations={activeInstallations} />
        ) : (
          <div class="px-5 pb-5">
            <Muted class="text-[13px] m-0">
              Install the GitHub App on an organization with the repo you want to gate before
              mapping a release target.
            </Muted>
          </div>
        )}
        {releaseTargetsError ? (
          <div class="px-5 pb-5">
            <Alert tone="critical">{releaseTargetsError}</Alert>
          </div>
        ) : null}
        {releaseTargets.length ? (
          <ReleaseTargetList
            releaseTargets={releaseTargets}
            installations={installations}
            onDelete={(id) => void githubApp.deleteReleaseTarget(id)}
          />
        ) : null}
      </div>
    </Card>
  );
}

function ReleaseTargetList({
  releaseTargets,
  installations,
  onDelete,
}: {
  releaseTargets: PublicReleaseTarget[];
  installations: PublicGithubAppInstallation[];
  onDelete: (id: string) => void;
}) {
  return (
    <ul class="m-0 p-0 list-none border-t border-border">
      {releaseTargets.map((target) => {
        const installation = installations.find((row) => row.id === target.installationRowId);
        return (
          <li
            key={target.id}
            class="border-b border-border last:border-b-0 px-5 py-4 flex flex-wrap items-center justify-between gap-3"
          >
            <div class="flex flex-col gap-1.5 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono text-[14px] font-medium">{target.repositoryFullName}</span>
              </div>
              <MonoDetail
                parts={[
                  <span key="env">env {target.environment}</span>,
                  <span key="install">
                    via {installation?.accountLogin ?? "unknown"} ·{" "}
                    {installation?.installationId ?? target.installationRowId}
                  </span>,
                ]}
              />
            </div>
            <Button variant="danger" size="sm" onClick={() => onDelete(target.id)} class="shrink-0">
              Remove
            </Button>
          </li>
        );
      })}
    </ul>
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
                <span key="linked">linked {formatTimestamp(installation.installedAt)}</span>,
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

function PypiGateSetupGuide() {
  return (
    <div class="border border-border rounded-lg bg-surface-2 px-4 py-3 flex flex-col gap-4">
      <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
        gate setup
      </span>
      <ol class="m-0 p-0 list-none flex flex-col gap-3">
        <SetupStep
          index="01"
          title="Install the GitHub App"
          detail="Install Drydock on the GitHub organization that owns the release repository, using the button below. This lets Drydock read the held deployment and post the approve/reject decision back to GitHub."
        />
        <SetupStep
          index="02"
          title="Add a deployment protection rule"
          detail={
            <>
              In the repository, open (or create) the GitHub Actions environment your publish job
              deploys to, then enable Drydock as a custom deployment protection rule so the publish
              job pauses for review. See{" "}
              <a
                class="underline"
                href="https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-custom-deployment-protection-rules"
                target="_blank"
                rel="noreferrer"
              >
                custom deployment protection rules
              </a>
              .
            </>
          }
        />
        <SetupStep
          index="03"
          title="Match the PyPI Trusted Publisher environment"
          detail={
            <>
              On PyPI, configure a Trusted Publisher for the same repository and workflow, and set
              its environment name to match the GitHub environment exactly. The workflow keeps its
              own OIDC trust with PyPI. See{" "}
              <a
                class="underline"
                href="https://docs.pypi.org/trusted-publishers/"
                target="_blank"
                rel="noreferrer"
              >
                PyPI Trusted Publishers
              </a>
              .
            </>
          }
        />
      </ol>
      <Muted as="p" class="text-[12px] leading-[1.55] m-0">
        Drydock reviews the release candidate and your approval releases or blocks the held GitHub
        job. Publishing happens through the workflow's Trusted Publishing OIDC exchange{" "}
        <span class="font-mono text-ink-subtle">→</span> Drydock never holds or sees PyPI
        credentials.
      </Muted>
    </div>
  );
}

function SetupStep({
  index,
  title,
  detail,
}: {
  index: string;
  title: string;
  detail: ComponentChildren;
}) {
  return (
    <li class="grid grid-cols-[28px_minmax(0,1fr)] gap-3 items-baseline min-w-0">
      <span class="font-mono text-[11px] text-ink-subtle tabular-nums">{index}</span>
      <div class="flex flex-col gap-1 min-w-0">
        <span class="text-[13px] font-medium text-ink">{title}</span>
        <Muted as="p" class="text-[12px] leading-[1.55] m-0">
          {detail}
        </Muted>
      </div>
    </li>
  );
}
