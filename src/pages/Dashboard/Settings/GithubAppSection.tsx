import { useModel } from "@preact/signals";
import { formatTimestamp } from "../../../lib/format";
import {
  GithubAppModel,
  type InstallationStatus,
  type PublicGithubAppInstallation,
  type PublicReleaseTarget,
} from "../../../models/github-app";
import { Alert } from "../../../components/Alert";
import { Badge, type BadgeTone } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import {
  CollapsibleCard,
  SettingsCardBody,
  SettingsCardHeader,
  SettingsCardListItem,
} from "../../../components/Card";
import { MonoDetail, MonoLabel, Muted } from "../../../components/Typography";
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
    <CollapsibleCard title="GitHub App" defaultOpen={defaultOpen}>
      <SettingsCardBody>
        {/* Pair the install action with the intro copy and anchor it to the card's
            right edge, on the same axis as the section counts. It is primary only
            until an installation exists; after that, mapping a release target is
            the section's next step and "Modify installation" is maintenance. */}
        <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <Muted class="text-[13px] m-0 max-w-[600px]">
            Install the Drydock GitHub App on your organization so releases gated by a GitHub
            Actions environment can be approved here. Drydock never asks for publish credentials.
            Your workflow keeps its own OIDC/Trusted Publishing trust, and Drydock only acts as the
            deployment-protection approver.
          </Muted>
          <Button
            variant={installations.length ? "secondary" : "primary"}
            onClick={onInstall}
            disabled={!configured || busy}
            class="shrink-0 self-start"
          >
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
          aside={installations.length ? <MonoLabel>{installations.length} linked</MonoLabel> : null}
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
            releaseTargets.length ? <MonoLabel>{releaseTargets.length} mapped</MonoLabel> : null
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
              <span class="font-mono text-[14px] font-medium">{target.repositoryFullName}</span>
              <MonoDetail
                parts={[
                  <span key="ecosystem">{target.ecosystem ?? "auto"}</span>,
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

// An active installation is the expected state and gets no mark; the others
// need a status badge and the step that restores them.
const INACTIVE_INSTALLATION: Record<
  Exclude<InstallationStatus, "active">,
  { tone: BadgeTone; hint: string }
> = {
  suspended: { tone: "medium", hint: "re-enable on github to use" },
  uninstalled: { tone: "critical", hint: "re-install to reconnect" },
};

function InstallationList({ installations }: { installations: PublicGithubAppInstallation[] }) {
  return (
    <ul class="m-0 p-0 list-none">
      {installations.map((installation) => {
        const inactive =
          installation.status === "active" ? null : INACTIVE_INSTALLATION[installation.status];
        return (
          <SettingsCardListItem key={installation.id}>
            <div class="flex flex-col gap-1.5 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono text-[14px] font-medium">{installation.accountLogin}</span>
                {inactive ? <Badge tone={inactive.tone}>{installation.status}</Badge> : null}
              </div>
              <MonoDetail
                parts={[
                  <span key="installation">installation {installation.installationId}</span>,
                  <span key="target">{installation.targetType.toLowerCase()}</span>,
                  <span key="linked">linked {formatTimestamp(installation.installedAt)}</span>,
                  inactive ? <span key="hint">{inactive.hint}</span> : null,
                ]}
              />
            </div>
          </SettingsCardListItem>
        );
      })}
    </ul>
  );
}
