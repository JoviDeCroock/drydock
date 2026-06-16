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
  SettingsCardBody,
  SettingsCardHeader,
  SettingsCardListItem,
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
        configured ? <Badge tone="ok">configured</Badge> : <Badge tone="info">not configured</Badge>
      }
    >
      <SettingsCardBody>
        {/* Pair the install action with the intro copy and anchor it to the card's
            right edge — same axis as the header badge and section counts — so it
            reads as this section's primary action instead of a stranded button. */}
        <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div class="flex flex-col gap-1.5 max-w-[600px]">
            <Muted class="text-[13px] m-0">
              Install the Drydock GitHub App on your organization so releases gated by a GitHub
              Actions environment can be approved here. Drydock never asks for publish credentials.
              Your workflow keeps its own OIDC/Trusted Publishing trust, and Drydock only acts as
              the deployment-protection approver.
            </Muted>
            <MonoDetail
              parts={[
                <span key="ecosystem">workflow gate</span>,
                <span key="oidc">no publish credentials</span>,
                <span key="env">github environment required</span>,
              ]}
            />
          </div>
          <Button onClick={onInstall} disabled={!configured || busy} class="shrink-0 self-start">
            {status === "starting"
              ? "Redirecting…"
              : installations.length
                ? "Modify installation"
                : "Install GitHub App"}
          </Button>
        </div>

        {!configured ? (
          <Alert tone="warn">
            The GitHub App is not configured yet. Ask the operator to add the GitHub App secrets (
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
      </SettingsCardBody>

      <div>
        <SettingsCardHeader
          title="Linked installations"
          aside={
            <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
              {installations.length} linked
            </span>
          }
        />
        {installations.length ? (
          <InstallationList installations={installations} />
        ) : (
          <SettingsCardBody inset="belowHeader" gap="none">
            <Muted class="text-[13px] m-0">No installations linked to this organization yet.</Muted>
          </SettingsCardBody>
        )}
      </div>

      <div>
        <SettingsCardHeader
          title="Release targets"
          aside={
            <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
              {releaseTargets.length} mapped
            </span>
          }
        />
        {activeInstallations.length ? (
          <ReleaseTargetForm githubApp={githubApp} activeInstallations={activeInstallations} />
        ) : (
          <SettingsCardBody inset="belowHeader" gap="none">
            <Muted class="text-[13px] m-0">
              Install the GitHub App on an organization with the repo you want to gate before
              mapping a release target.
            </Muted>
          </SettingsCardBody>
        )}
        {releaseTargetsError ? (
          <SettingsCardBody inset="belowHeader" gap="none">
            <Alert tone="critical">{releaseTargetsError}</Alert>
          </SettingsCardBody>
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
    <ul class="m-0 p-0 list-none">
      {releaseTargets.map((target) => {
        const installation = installations.find((row) => row.id === target.installationRowId);
        return (
          <SettingsCardListItem key={target.id}>
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
          </SettingsCardListItem>
        );
      })}
    </ul>
  );
}

function InstallationList({ installations }: { installations: PublicGithubAppInstallation[] }) {
  return (
    <ul class="m-0 p-0 list-none">
      {installations.map((installation) => (
        <SettingsCardListItem key={installation.id}>
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
        </SettingsCardListItem>
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
