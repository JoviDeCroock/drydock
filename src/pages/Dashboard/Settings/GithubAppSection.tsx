import type { ComponentChildren } from "preact";
import { useModel } from "@preact/signals";
import { formatDateTimeExact } from "../../../lib/format";
import {
  GithubAppModel,
  type InstallationStatus,
  type PublicGithubAppInstallation,
} from "../../../models/github-app";
import { ReleaseTargetsModel, type PublicReleaseTarget } from "../../../models/release-targets";
import { Alert } from "../../../components/Alert";
import { Badge, type BadgeTone } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import {
  CollapsibleCard,
  SettingsCardBody,
  SettingsCardHeader,
  SettingsCardListItem,
} from "../../../components/Card";
import { cn } from "../../../components/cn";
import { MonoDetail, MonoLabel, Muted } from "../../../components/Typography";
import { ReleaseTargetForm } from "./ReleaseTargetForm";
import { PublisherSetup } from "../../../features/publisher-setup/PublisherSetup";
import { OPERATOR_SETUP_DOCS } from "./settings-links";

export function GithubAppSection({
  githubApp,
  targets,
  defaultOpen = false,
}: {
  githubApp: ReturnType<typeof useModel<typeof GithubAppModel.prototype>>;
  targets: InstanceType<typeof ReleaseTargetsModel>;
  defaultOpen?: boolean;
}) {
  const configured = githubApp.config.value?.configured === true;
  const installations: PublicGithubAppInstallation[] = githubApp.installations.value;
  const status = githubApp.status.value;
  const error = githubApp.error.value;
  const lastLinked = githubApp.lastLinked.value;
  const busy = githubApp.busy.value;
  const releaseTargets: PublicReleaseTarget[] = targets.releaseTargets.value;
  const releaseTargetsError = targets.releaseTargetsError.value;
  const activeInstallations = installations.filter(
    (row: PublicGithubAppInstallation) => row.status === "active",
  );

  // Nothing below the intro can work until the operator configures the App, so
  // an instance without it shows one unavailable state instead of disabled
  // scaffolding. Installations linked before a config change still list.
  // Only a loaded config that says "not configured" proves that; a failed or
  // pending config fetch must not hide installations as unavailable.
  const unavailable = githubApp.config.value?.configured === false && installations.length === 0;

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
            <span class="font-medium text-ink">Workflow Gate — enforced.</span> Install the Drydock
            GitHub App so your configured GitHub environment holds the publish job until you approve
            or reject it here. Your workflow keeps its publishing credentials and publishes the
            package.
          </Muted>
          {unavailable ? null : (
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
          )}
        </div>

        {unavailable ? (
          <p class="m-0 text-[13px] leading-[1.55] text-ink">
            The GitHub App is not set up on this Drydock instance. Your Drydock operator can enable
            it.{" "}
            <a
              class="underline underline-offset-2 hover:text-accent"
              href={OPERATOR_SETUP_DOCS.githubApp}
              target="_blank"
              rel="noreferrer"
            >
              Operator setup guide
            </a>
          </p>
        ) : null}

        {error ? <Alert tone="critical">{error}</Alert> : null}

        {lastLinked ? (
          <Alert tone="ok">
            Linked <strong>{lastLinked.accountLogin}</strong> · installation{" "}
            <code class="font-mono text-[12px]">{lastLinked.installationId}</code>.
          </Alert>
        ) : null}
      </SettingsCardBody>

      {unavailable ? null : (
        <>
          <div>
            <SettingsCardHeader
              title="Linked installations"
              aside={
                installations.length ? <MonoLabel>{installations.length} linked</MonoLabel> : null
              }
            />
            {installations.length ? (
              <InstallationList installations={installations} />
            ) : (
              <SettingsCardBody inset="belowHeader" gap="none">
                <Muted class="text-[13px] m-0">
                  No GitHub App installations are linked to this organization.
                </Muted>
              </SettingsCardBody>
            )}
          </div>

          {activeInstallations.length ? (
            <PublisherSetup installations={activeInstallations} targets={targets} />
          ) : null}

          <div>
            <SettingsCardHeader
              title="Release targets"
              aside={
                releaseTargets.length ? <MonoLabel>{releaseTargets.length} mapped</MonoLabel> : null
              }
            />
            {releaseTargetsError ? (
              <SettingsCardBody inset="belowHeader" gap="none">
                <Alert tone="critical">{releaseTargetsError}</Alert>
              </SettingsCardBody>
            ) : null}
            {releaseTargets.length ? (
              <ReleaseTargetList
                releaseTargets={releaseTargets}
                installations={installations}
                onDelete={(id) => void targets.deleteReleaseTarget(id)}
              />
            ) : null}
            {activeInstallations.length ? (
              <ManualTargetDisclosure separated={releaseTargets.length > 0}>
                <ReleaseTargetForm targets={targets} activeInstallations={activeInstallations} />
              </ManualTargetDisclosure>
            ) : (
              <SettingsCardBody inset="belowHeader" gap="none">
                <Muted class="text-[13px] m-0">
                  Release targets require an active GitHub App installation with access to the
                  repository.
                </Muted>
              </SettingsCardBody>
            )}
          </div>
        </>
      )}
    </CollapsibleCard>
  );
}

// The guided setup above maps its own target; the manual form is for a
// workflow that already uses a protected environment, so it stays folded.
function ManualTargetDisclosure({
  separated,
  children,
}: {
  separated: boolean;
  children: ComponentChildren;
}) {
  return (
    <details class={cn("group/manual", separated && "border-t border-border")}>
      <summary class="cursor-pointer list-none px-5 py-4 text-[13px] font-medium text-ink-muted hover:text-ink">
        <span aria-hidden class="mr-1.5 font-mono text-ink-subtle">
          <span class="group-open/manual:hidden">▸</span>
          <span class="hidden group-open/manual:inline">▾</span>
        </span>
        Map a release target manually
      </summary>
      {children}
    </details>
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
  suspended: { tone: "medium", hint: "re-enable on GitHub to reconnect" },
  uninstalled: { tone: "critical", hint: "reinstall to reconnect" },
};

function formatDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function InstallationList({ installations }: { installations: PublicGithubAppInstallation[] }) {
  return (
    <ul class="m-0 p-0 list-none">
      {installations.map((installation) => {
        const inactive =
          installation.status === "active" ? null : INACTIVE_INSTALLATION[installation.status];
        return (
          <li
            key={installation.id}
            class="border-b border-border last:border-b-0 px-5 py-3 flex flex-wrap items-baseline gap-x-3 gap-y-1"
          >
            <span class="font-mono text-[14px] font-medium">{installation.accountLogin}</span>
            {inactive ? <Badge tone={inactive.tone}>{installation.status}</Badge> : null}
            <MonoDetail
              parts={[
                <span key="target">{installation.targetType.toLowerCase()}</span>,
                <span key="installation">installation {installation.installationId}</span>,
                <time
                  key="linked"
                  dateTime={installation.installedAt}
                  title={formatDateTimeExact(installation.installedAt)}
                >
                  linked {formatDate(installation.installedAt)}
                </time>,
                inactive ? <span key="hint">{inactive.hint}</span> : null,
              ]}
            />
          </li>
        );
      })}
    </ul>
  );
}
