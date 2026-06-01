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
  CollapsibleCard,
  MonoDetail,
  Muted,
  SectionLabel,
  type BadgeTone,
} from "../../../components";
import { ReleaseTargetForm } from "./ReleaseTargetForm";

export function GithubAppSection({
  githubApp,
  defaultOpen = false,
}: {
  githubApp: ReturnType<typeof useModel<typeof GithubAppModel.prototype>>;
  defaultOpen?: boolean;
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
    <CollapsibleCard
      title="GitHub App"
      defaultOpen={defaultOpen}
      aside={
        <div class="flex flex-col items-end gap-2">
          {configured ? (
            <Badge tone="ok">configured</Badge>
          ) : (
            <Badge tone="info">not configured</Badge>
          )}
          {configured && appSlug ? (
            <span class="font-mono text-[11px] text-ink-subtle">{appSlug}</span>
          ) : null}
        </div>
      }
    >
      <div class="p-5 flex flex-col gap-5">
        <div class="flex flex-col gap-1.5 max-w-[760px]">
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
                ? "Modify installation"
                : "Install GitHub App"}
          </Button>
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
    </CollapsibleCard>
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
                <Badge tone="info">{target.ecosystem ?? "auto"}</Badge>
              </div>
              <MonoDetail
                parts={[
                  <span key="env">env {target.environment}</span>,
                  target.artifactName ? (
                    <span key="artifact">artifact {target.artifactName}</span>
                  ) : null,
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
