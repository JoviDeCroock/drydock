import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { useModel } from "@preact/signals";
import {
  GATE_ECOSYSTEMS,
  GateSetupModel,
  NEW_ENVIRONMENT_CHOICE,
  type GateSetupPreview,
  type GateSetupStepResult,
  gateSetupStatusLabel,
} from "../../../models/gate-setup";
import type {
  InstallationRepository,
  PublicGithubAppInstallation,
  RepositoryEnvironment,
} from "../../../models/github-app";
import { Alert } from "../../../components/Alert";
import { Badge, type BadgeTone } from "../../../components/Badge";
import { Button, LinkButton } from "../../../components/Button";
import { CollapsibleCard, SettingsCardBody, SettingsCardHeader } from "../../../components/Card";
import { CopyButton } from "../../../components/CopyButton";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { Select } from "../../../components/Select";
import { MonoDetail, Muted } from "../../../components/Typography";

type GateSetup = ReturnType<typeof useModel<typeof GateSetupModel.prototype>>;

const ENVIRONMENT_DOCS =
  "https://docs.github.com/en/actions/deployment/targeting-different-environments/managing-environments-for-deployment";

/**
 * The guided workflow-gate setup wizard.
 *
 * Gate onboarding used to be ten steps spread across Drydock, GitHub settings,
 * and the docs. Here it is one column: pick a repo, name the environment, let
 * Drydock create it and register itself as its protection rule, generate the
 * publish workflow for the package, and open the pull request.
 *
 * The installed App often lacks the permission a given step needs — repository
 * administration for the environment, `workflows: write` for the pull request —
 * so every automated step renders its own manual fallback inline instead of
 * dead-ending. The generated YAML is always shown and always copyable, which is
 * the fallback the pull-request step degrades to.
 */
export function GateSetupWizard({
  activeInstallations,
  onReleaseTargetCreated,
  defaultOpen = false,
}: {
  activeInstallations: PublicGithubAppInstallation[];
  onReleaseTargetCreated?: () => void;
  defaultOpen?: boolean;
}) {
  const gateSetup = useModel(GateSetupModel);
  const installationRowId = gateSetup.installationRowId.value;
  const error = gateSetup.error.value;
  const releaseTarget = gateSetup.releaseTarget.value;

  // Keep the wizard pinned to an installation the org still has, the same way
  // the release-target form does.
  const installationIds = activeInstallations.map((row) => row.id).join(",");
  useEffect(() => {
    const stillValid = activeInstallations.some((row) => row.id === installationRowId);
    if (!stillValid && activeInstallations.length) {
      void gateSetup.selectInstallation(activeInstallations[0].id);
    }
  }, [installationIds, installationRowId]);

  // The settings page selects the integrations tab for a #gate-setup deep link,
  // which means this section only exists after that render — so the scroll has
  // to happen here, on mount, rather than in the browser's own hash handling.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash !== "#gate-setup") return;
    document.getElementById("gate-setup")?.scrollIntoView({ block: "start" });
  }, []);

  return (
    <div id="gate-setup" class="scroll-mt-6">
      <CollapsibleCard
        title="Guided gate setup"
        defaultOpen={defaultOpen}
        aside={releaseTarget ? <Badge tone="ok">gate configured</Badge> : null}
      >
        <SettingsCardBody>
          <div class="flex flex-col gap-1.5 max-w-[600px]">
            <Muted class="text-[13px] m-0">
              Set a repository up for workflow-gated releases without leaving Drydock. Drydock
              creates the GitHub Environment, registers itself as its deployment-protection rule,
              generates the publish workflow for your package, and opens a pull request with it.
            </Muted>
            <MonoDetail
              parts={[
                <span key="a">creates the environment</span>,
                <span key="b">enables the protection rule</span>,
                <span key="c">opens a workflow pr</span>,
              ]}
            />
          </div>
          {error ? <Alert tone="critical">{error}</Alert> : null}
        </SettingsCardBody>

        <RepositoryStep gateSetup={gateSetup} activeInstallations={activeInstallations} />
        <EnvironmentStep gateSetup={gateSetup} />
        <ProtectionRuleStep gateSetup={gateSetup} />
        <PackageStep gateSetup={gateSetup} />
        <WorkflowStep gateSetup={gateSetup} />
        <ReleaseTargetStep gateSetup={gateSetup} onCreated={onReleaseTargetCreated} />
      </CollapsibleCard>
    </div>
  );
}

function RepositoryStep({
  gateSetup,
  activeInstallations,
}: {
  gateSetup: GateSetup;
  activeInstallations: PublicGithubAppInstallation[];
}) {
  const installationRowId = gateSetup.installationRowId.value;
  const repositoryFullName = gateSetup.repositoryFullName.value;
  const repositories: InstallationRepository[] = gateSetup.repositories.value;
  const loading = gateSetup.repositoriesLoading.value;
  const busy = gateSetup.busy.value;

  return (
    <div>
      <SettingsCardHeader title="1 · Repository" />
      <SettingsCardBody inset="belowHeader" gap="compact">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          {activeInstallations.length > 1 ? (
            <Field label="Installation" for="gateSetupInstallation">
              <Select
                id="gateSetupInstallation"
                value={installationRowId}
                disabled={busy}
                onChange={(value) => void gateSetup.selectInstallation(value)}
              >
                <option value="">Pick an installation…</option>
                {activeInstallations.map((installation) => (
                  <option key={installation.id} value={installation.id}>
                    {installation.accountLogin}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Repository" for="gateSetupRepo">
            <Select
              id="gateSetupRepo"
              value={repositoryFullName}
              disabled={busy || !installationRowId || loading}
              onChange={(value) => void gateSetup.selectRepository(value)}
            >
              <option value="">
                {loading
                  ? "Loading repositories…"
                  : repositories.length
                    ? "Pick a repository…"
                    : "No repositories visible"}
              </option>
              {repositories.map((repo) => (
                <option key={repo.id} value={repo.fullName}>
                  {repo.fullName}
                </option>
              ))}
            </Select>
            {!loading && installationRowId && !repositories.length ? (
              <Muted class="text-[12px] mt-1.5">
                This installation has no accessible repositories. Grant the GitHub App access to one
                in{" "}
                <a
                  class="underline"
                  href="https://github.com/settings/installations"
                  target="_blank"
                  rel="noreferrer"
                >
                  GitHub App settings
                </a>
                , then reload this page.
              </Muted>
            ) : null}
          </Field>
        </div>
      </SettingsCardBody>
    </div>
  );
}

function EnvironmentStep({ gateSetup }: { gateSetup: GateSetup }) {
  const choice = gateSetup.environmentChoice.value;
  const newName = gateSetup.newEnvironmentName.value;
  const environments: RepositoryEnvironment[] = gateSetup.environments.value;
  const loading = gateSetup.environmentsLoading.value;
  const repositoryPicked = gateSetup.repositoryPicked.value;
  const environment = gateSetup.environment.value;
  const step = gateSetup.environmentStep.value;
  const busyStep = gateSetup.busyStep.value;
  const busy = gateSetup.busy.value;
  const creatingNew = choice === NEW_ENVIRONMENT_CHOICE;

  return (
    <div>
      <SettingsCardHeader title="2 · GitHub environment" aside={<StepBadge result={step} />} />
      <SettingsCardBody inset="belowHeader" gap="compact">
        <Muted class="text-[13px] m-0">
          The publish job runs in this environment. Drydock holds it there while it reviews the
          uploaded release artifacts.
        </Muted>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Environment" for="gateSetupEnv">
            <Select
              id="gateSetupEnv"
              value={choice}
              disabled={busy || !repositoryPicked || loading}
              onChange={(value) => gateSetup.selectEnvironmentChoice(value)}
            >
              <option value="">
                {!repositoryPicked
                  ? "Pick a repository first…"
                  : loading
                    ? "Loading environments…"
                    : "Pick an environment…"}
              </option>
              {environments.map((env) => (
                <option key={env.name} value={env.name}>
                  {env.name}
                </option>
              ))}
              <option value={NEW_ENVIRONMENT_CHOICE}>Create a new environment…</option>
            </Select>
          </Field>
          {creatingNew ? (
            <Field label="New environment name" for="gateSetupNewEnv">
              <Input
                id="gateSetupNewEnv"
                value={newName}
                disabled={busy}
                placeholder="production"
                onInput={(event) =>
                  gateSetup.setNewEnvironmentName((event.currentTarget as HTMLInputElement).value)
                }
              />
              <Muted class="text-[12px] mt-1.5">
                GitHub lowercases environment names, so this will be created as{" "}
                <code class="font-mono text-[12px]">{environment || "…"}</code>.
              </Muted>
            </Field>
          ) : null}
        </div>
        {creatingNew ? (
          <div class="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => void gateSetup.createEnvironment()}
              disabled={busy || !environment}
            >
              {busyStep === "environment" ? "Creating…" : "Create it in GitHub"}
            </Button>
            <Muted class="text-[12px] m-0">
              Needs the App's repository administration permission.
            </Muted>
          </div>
        ) : null}
        <StepFallback
          result={step}
          extra={
            <Muted class="text-[12px] m-0">
              <a class="underline" href={ENVIRONMENT_DOCS} target="_blank" rel="noreferrer">
                Managing environments for deployment
              </a>{" "}
              walks through it. Come back and pick it from the list once it exists.
            </Muted>
          }
        />
      </SettingsCardBody>
    </div>
  );
}

function ProtectionRuleStep({ gateSetup }: { gateSetup: GateSetup }) {
  const step = gateSetup.protectionStep.value;
  const environmentPicked = gateSetup.environmentPicked.value;
  const environment = gateSetup.environment.value;
  const busyStep = gateSetup.busyStep.value;
  const busy = gateSetup.busy.value;
  const enabled = step !== null && step.status !== "failed";

  return (
    <div>
      <SettingsCardHeader title="3 · Drydock protection rule" aside={<StepBadge result={step} />} />
      <SettingsCardBody inset="belowHeader" gap="compact">
        <Muted class="text-[13px] m-0">
          Registers Drydock as a custom deployment-protection rule on{" "}
          <code class="font-mono text-[12px]">{environment || "the environment"}</code>. This is
          what pauses the publish job and sends Drydock the release to review.
        </Muted>
        <div class="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => void gateSetup.enableProtectionRule()}
            disabled={busy || !environmentPicked}
          >
            {busyStep === "protection_rule"
              ? "Enabling…"
              : enabled
                ? "Re-check the rule"
                : "Enable Drydock protection rule"}
          </Button>
          {enabled ? (
            <Muted class="text-[12px] m-0">
              Drydock now gates deployments to this environment.
            </Muted>
          ) : null}
        </div>
        <StepFallback result={step} />
      </SettingsCardBody>
    </div>
  );
}

function PackageStep({ gateSetup }: { gateSetup: GateSetup }) {
  const ecosystem = gateSetup.ecosystem.value;
  const packageName = gateSetup.packageName.value;
  const environmentPicked = gateSetup.environmentPicked.value;
  const busy = gateSetup.busy.value;

  return (
    <div>
      <SettingsCardHeader title="4 · What you publish" />
      <SettingsCardBody inset="belowHeader" gap="compact">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Ecosystem" for="gateSetupEcosystem">
            <Select
              id="gateSetupEcosystem"
              value={ecosystem}
              disabled={busy || !environmentPicked}
              onChange={(value) => gateSetup.selectEcosystem(value)}
            >
              <option value="">Pick an ecosystem…</option>
              {GATE_ECOSYSTEMS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Package name" for="gateSetupPackage">
            <Input
              id="gateSetupPackage"
              value={packageName}
              disabled={busy || !environmentPicked}
              placeholder="@acme/toolkit"
              onInput={(event) =>
                gateSetup.setPackageName((event.currentTarget as HTMLInputElement).value)
              }
            />
            <Muted class="text-[12px] mt-1.5">
              Used to name the generated workflow and its registry pins. Drydock still derives the
              reviewed identity from the uploaded artifacts, never from this field.
            </Muted>
          </Field>
        </div>
      </SettingsCardBody>
    </div>
  );
}

function WorkflowStep({ gateSetup }: { gateSetup: GateSetup }) {
  const preview: GateSetupPreview | null = gateSetup.preview.value;
  const previewLoading = gateSetup.previewLoading.value;
  const templateReady = gateSetup.templateReady.value;
  const step = gateSetup.pullRequestStep.value;
  const pullRequest = gateSetup.pullRequest.value;
  const busyStep = gateSetup.busyStep.value;
  const busy = gateSetup.busy.value;

  return (
    <div>
      <SettingsCardHeader title="5 · Publish workflow" aside={<StepBadge result={step} />} />
      <SettingsCardBody inset="belowHeader" gap="compact">
        <Muted class="text-[13px] m-0">
          Build once, record <code class="font-mono text-[12px]">SHA256SUMS</code>, upload, pause at
          the environment, verify the digests on download, publish the reviewed bytes. Drydock
          generated this file but has not reviewed it — read it before merging.
        </Muted>
        <div class="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            onClick={() => void gateSetup.loadPreview()}
            disabled={busy || !templateReady}
          >
            {previewLoading ? "Generating…" : preview ? "Regenerate workflow" : "Generate workflow"}
          </Button>
          <Button
            onClick={() => void gateSetup.openPullRequest()}
            disabled={busy || !templateReady}
          >
            {busyStep === "pull_request" ? "Opening…" : "Open a PR with this workflow"}
          </Button>
        </div>

        {pullRequest ? (
          <Alert tone="ok">
            Opened{" "}
            <a class="underline" href={pullRequest.url} target="_blank" rel="noreferrer">
              pull request #{pullRequest.number}
            </a>{" "}
            on branch <code class="font-mono text-[12px]">{pullRequest.branch}</code>. Review and
            merge it to arm the gate.
          </Alert>
        ) : null}

        <StepFallback result={step} />

        {preview ? <WorkflowPreview path={preview.workflowPath} yaml={preview.yaml} /> : null}
        {preview && preview.notes.length ? (
          <div class="flex flex-col gap-1.5">
            <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
              Finish the lockdown
            </span>
            <ul class="m-0 pl-4 flex flex-col gap-1">
              {preview.notes.map((note) => (
                <li key={note} class="text-[13px] leading-[1.55] text-ink-muted">
                  {note}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </SettingsCardBody>
    </div>
  );
}

function ReleaseTargetStep({
  gateSetup,
  onCreated,
}: {
  gateSetup: GateSetup;
  onCreated?: () => void;
}) {
  const releaseTarget = gateSetup.releaseTarget.value;
  const environmentPicked = gateSetup.environmentPicked.value;
  const busyStep = gateSetup.busyStep.value;
  const busy = gateSetup.busy.value;

  const create = async () => {
    const created = await gateSetup.createReleaseTarget();
    if (created) onCreated?.();
  };

  return (
    <div>
      <SettingsCardHeader
        title="6 · Release target"
        aside={releaseTarget ? <Badge tone="ok">mapped</Badge> : null}
      />
      <SettingsCardBody inset="belowHeader" gap="compact">
        <Muted class="text-[13px] m-0">
          The last piece: tell Drydock this repository and environment belong to your organization,
          so a held deployment resolves to a review here.
        </Muted>
        {releaseTarget ? (
          <MonoDetail
            parts={[
              <span key="repo">{releaseTarget.repositoryFullName}</span>,
              <span key="env">env {releaseTarget.environment}</span>,
              <span key="eco">{releaseTarget.ecosystem ?? "auto-detect"}</span>,
            ]}
          />
        ) : (
          <div class="flex flex-wrap items-center gap-3">
            <Button onClick={() => void create()} disabled={busy || !environmentPicked}>
              {busyStep === "release_target" ? "Mapping…" : "Create release target"}
            </Button>
            <LinkButton href="/docs#workflow-gates" size="sm" variant="ghost">
              Read the gate docs
            </LinkButton>
          </div>
        )}
      </SettingsCardBody>
    </div>
  );
}

/** Selectable, copyable YAML. The text stays real text so manual copy works. */
function WorkflowPreview({ path, yaml }: { path: string; yaml: string }) {
  return (
    <div class="overflow-hidden rounded-md border border-border bg-surface-2">
      <div class="px-4 py-2 border-b border-border flex items-center justify-between gap-3">
        <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle min-w-0 truncate">
          {path}
        </span>
        <CopyButton text={yaml} label="Copy workflow" />
      </div>
      <pre class="m-0 p-4 overflow-x-auto font-mono text-[12px] leading-[1.55] text-ink max-h-[420px]">
        <code class="whitespace-pre">{yaml}</code>
      </pre>
    </div>
  );
}

function StepBadge({ result }: { result: GateSetupStepResult | null }) {
  const label = gateSetupStatusLabel(result);
  if (!label || !result) return null;
  return <Badge tone={stepTone(result)}>{label}</Badge>;
}

function stepTone(result: GateSetupStepResult): BadgeTone {
  return result.status === "failed" ? "medium" : "ok";
}

/**
 * The manual path for a step GitHub refused.
 *
 * Rendered inline under the step's own controls, so a maintainer whose
 * installation lacks a permission finishes the same flow by hand instead of
 * hitting a wall.
 */
function StepFallback({
  result,
  extra,
}: {
  result: GateSetupStepResult | null;
  extra?: ComponentChildren;
}) {
  if (!result?.failure) return null;
  return (
    <Alert tone="warn">
      <div class="flex flex-col gap-1.5">
        <span>{result.failure.message}</span>
        <span>{result.failure.manualFallback}</span>
        {extra}
      </div>
    </Alert>
  );
}
