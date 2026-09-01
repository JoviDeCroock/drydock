import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { useModel } from "@preact/signals";
import {
  GateSetupModel,
  NEW_ENVIRONMENT_CHOICE,
  environmentSettingsUrl,
  newWorkflowFileUrl,
} from "../../../models/gate-setup";
import type {
  InstallationRepository,
  GateSetupEcosystemOption,
  PublicGithubAppInstallation,
  PublicReleaseTarget,
  RepositoryEnvironment,
} from "../../../models/github-app";
import { Alert } from "../../../components/Alert";
import { Badge } from "../../../components/Badge";
import { Button, LinkButton } from "../../../components/Button";
import { CodeBlock } from "../../../components/CodeBlock";
import { CollapsibleCard, SettingsCardBody, SettingsCardHeader } from "../../../components/Card";
import { Field } from "../../../components/Field";
import { Input } from "../../../components/Input";
import { Select } from "../../../components/Select";
import { InlineCode, MonoDetail, MonoLabel, Muted } from "../../../components/Typography";

type GateSetup = ReturnType<typeof useModel<typeof GateSetupModel.prototype>>;

/**
 * The running-copy measure. Body text in a step stops here; the controls and
 * the code block span the card. `docs/design.md` lists this as the canonical
 * prose measure, and mixing capped and uncapped copy in one column is what made
 * an earlier pass read as unconsidered.
 */
const MEASURE = "max-w-[680px]";

/**
 * Hardening that is true of any gated environment, whatever the registry.
 *
 * The ecosystem adapters supply the registry-side notes; these three are
 * GitHub-side and would otherwise be lost — they are what stops the gate from
 * being a checkpoint someone can walk around.
 */
const ENVIRONMENT_HARDENING = [
  "Uncheck **Allow administrators to bypass configured protection rules** on the environment — it is on by default.",
  "Restrict the environment's deployment branches and tags to your release branch or tag pattern.",
  "Require `CODEOWNERS` review on `.github/workflows/` — a trusted publisher pins the workflow path, not its contents.",
];

/**
 * Render a lockdown note's inline markup.
 *
 * The notes are authored in the ecosystem adapters, where backticks around a
 * package name or a workflow filename are the natural way to write them, and
 * they were previously printed raw — every npm note rendered its own backticks.
 * Only the two marks the notes actually use are supported; this is a formatter
 * for known strings, not a markdown parser for arbitrary input.
 */
function renderNote(note: string): ComponentChildren {
  return note.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <InlineCode key={index}>{part.slice(1, -1)}</InlineCode>;
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

/**
 * The guided workflow-gate setup wizard.
 *
 * Drydock does not touch the maintainer's repository. Creating the environment,
 * registering the protection rule, and committing the workflow would each need
 * a standing write permission on a repository whose publish path Drydock exists
 * to protect, so the wizard generates the workflow, links to the GitHub screen
 * for each step, and then *verifies* the result by reading GitHub back.
 *
 * That verification is what the summary badge rests on: a mapped release target
 * only means Drydock knows where a held deployment goes, so the wizard reports
 * a gate as armed only when GitHub confirms Drydock is the protection rule.
 */
export function GateSetupWizard({
  activeInstallations,
  releaseTargets,
  onReleaseTargetsChanged,
  onInstall,
  gateSetupEcosystems,
  canManage,
  installDisabled = false,
  deepLinked = false,
}: {
  activeInstallations: PublicGithubAppInstallation[];
  releaseTargets: PublicReleaseTarget[];
  onReleaseTargetsChanged?: () => void;
  onInstall?: () => void;
  gateSetupEcosystems: GateSetupEcosystemOption[];
  canManage: boolean;
  installDisabled?: boolean;
  /**
   * The page arrived on `#gate-setup`. Passed as a captured flag rather than
   * read from `window.location.hash`: the wizard mounts long after arrival
   * (installations load first), and the intervening tab-select URL writes make
   * the live hash an unreliable signal at mount time.
   */
  deepLinked?: boolean;
}) {
  const gateSetup = useModel(GateSetupModel);
  const installationRowId = gateSetup.installationRowId.value;
  const repositoryFullName = gateSetup.repositoryFullName.value;
  const environment = gateSetup.environment.value;
  const localReleaseTarget = gateSetup.releaseTarget.value;
  // Stored release targets are normalized; the draft carries GitHub's casing.
  // Comparing them directly would miss an existing mapping for `Production`.
  const persistedReleaseTarget = releaseTargets.find(
    (target) =>
      target.installationRowId === installationRowId &&
      target.repositoryFullName === repositoryFullName &&
      target.environment.toLowerCase() === environment.toLowerCase(),
  );
  const releaseTarget = localReleaseTarget ?? persistedReleaseTarget ?? null;

  // Only pin the wizard to an installation when there is no choice to make.
  // Auto-selecting the first of several opened the wizard on whichever
  // installation sorted first — often one with no accessible repositories, so
  // the first thing a maintainer saw was an error they had not caused.
  const installationIds = activeInstallations.map((row) => row.id).join(",");
  useEffect(() => {
    if (!canManage) return;
    const stillValid = activeInstallations.some((row) => row.id === installationRowId);
    if (stillValid) return;
    if (activeInstallations.length === 1) {
      void gateSetup.selectInstallation(activeInstallations[0].id);
    } else if (installationRowId) {
      void gateSetup.selectInstallation("");
    }
  }, [canManage, installationIds, installationRowId]);

  // This section only exists after the settings page has switched to the
  // integrations tab and the workspace has loaded, which is well after the
  // browser would have handled the hash itself — so the scroll happens here,
  // keyed on the captured flag rather than a hash that no longer exists.
  useEffect(() => {
    if (typeof window === "undefined" || !deepLinked) return;
    document.getElementById("gate-setup")?.scrollIntoView({ block: "start" });
  }, [deepLinked]);

  useEffect(() => {
    const pinned = persistedReleaseTarget?.ecosystem;
    if (!pinned || gateSetup.ecosystem.peek() === pinned) return;
    gateSetup.selectEcosystem(pinned);
  }, [persistedReleaseTarget?.id, persistedReleaseTarget?.ecosystem]);

  if (!canManage) {
    return <GateSetupPermissionPlaceholder deepLinked={deepLinked} />;
  }

  if (!activeInstallations.length) {
    return (
      <GateSetupPlaceholder
        deepLinked={deepLinked}
        onInstall={onInstall}
        installDisabled={installDisabled}
      />
    );
  }

  const verification = gateSetup.verification.value;
  const preview = gateSetup.preview.value;
  const gateArmed = verification?.protectionRule === "present" && releaseTarget !== null;
  // The first unfinished step. Exactly one step owns the primary button, so the
  // card has a single next action instead of six competing ones.
  const current = !gateSetup.repositoryPicked.value
    ? 1
    : verification?.environment !== "present"
      ? 2
      : verification.protectionRule !== "present"
        ? 3
        : !gateSetup.templateReady.value
          ? 4
          : !preview
            ? 5
            : !releaseTarget
              ? 6
              : 7;

  return (
    <div id="gate-setup" class="scroll-mt-6">
      <CollapsibleCard
        title="Guided gate setup"
        defaultOpen={deepLinked}
        aside={
          gateArmed ? (
            <Badge tone="ok">gate armed</Badge>
          ) : current > 1 ? (
            <Badge tone="neutral">step {Math.min(current, 6)} of 6</Badge>
          ) : null
        }
      >
        <SettingsCardBody>
          <div class={`flex flex-col gap-1.5 ${MEASURE}`}>
            <Muted class="text-[13px] m-0">
              Set a repository up for workflow-gated releases. Drydock generates the publish
              workflow, points you at each GitHub screen, and reads GitHub back to confirm the gate
              is real. It never writes to your repository — holding the permission to rewrite your
              publish workflow is exactly what a gate is supposed to prevent.
            </Muted>
            <MonoDetail
              parts={[
                <span key="a">you make the changes on github</span>,
                <span key="b">drydock verifies them</span>,
              ]}
            />
          </div>
        </SettingsCardBody>

        <RepositoryStep
          gateSetup={gateSetup}
          activeInstallations={activeInstallations}
          current={current}
        />
        <EnvironmentStep gateSetup={gateSetup} current={current} />
        <ProtectionRuleStep gateSetup={gateSetup} current={current} />
        <PackageStep
          gateSetup={gateSetup}
          ecosystems={gateSetupEcosystems}
          releaseTarget={releaseTarget}
          current={current}
        />
        <WorkflowStep gateSetup={gateSetup} current={current} />
        <ReleaseTargetStep
          gateSetup={gateSetup}
          releaseTarget={releaseTarget}
          onChanged={onReleaseTargetsChanged}
          current={current}
        />
        {current === 7 ? <GateArmedSummary gateSetup={gateSetup} /> : null}
      </CollapsibleCard>
    </div>
  );
}

function GateSetupPermissionPlaceholder({ deepLinked }: { deepLinked: boolean }) {
  return (
    <div id="gate-setup" class="scroll-mt-6">
      <CollapsibleCard
        title="Guided gate setup"
        defaultOpen={deepLinked}
        aside={<Badge tone="info">owner or admin required</Badge>}
      >
        <SettingsCardBody>
          <Muted class={`text-[13px] m-0 ${MEASURE}`}>
            Organization owners and admins can run this setup and map its release target. Ask one of
            them to configure the gate for the organization.
          </Muted>
        </SettingsCardBody>
      </CollapsibleCard>
    </div>
  );
}

/**
 * What a maintainer following the `#gate-setup` link sees before the App exists.
 *
 * The funnel that links here is aimed at people who have *not* installed the
 * GitHub App, so this container has to carry the anchor too — rendering nothing
 * would land them mid-page with no wizard and no explanation.
 */
function GateSetupPlaceholder({
  deepLinked,
  onInstall,
  installDisabled,
}: {
  deepLinked: boolean;
  onInstall?: () => void;
  installDisabled: boolean;
}) {
  return (
    <div id="gate-setup" class="scroll-mt-6">
      <CollapsibleCard
        title="Guided gate setup"
        defaultOpen={deepLinked}
        aside={<Badge tone="info">needs the GitHub App</Badge>}
      >
        <SettingsCardBody>
          <Muted class={`text-[13px] m-0 ${MEASURE}`}>
            This wizard generates your publish workflow and verifies that GitHub is holding releases
            for review. It reads your repository through the Drydock GitHub App, so install that
            first — on the account that hosts the repository you want to gate. The wizard appears
            here once the installation is linked.
          </Muted>
          {onInstall ? (
            <div class="flex flex-wrap items-center gap-3">
              <Button onClick={onInstall} disabled={installDisabled}>
                Install the GitHub App
              </Button>
              <Muted class="text-[12px] m-0">
                {installDisabled
                  ? "Ask the operator to configure the GitHub App on this Drydock instance."
                  : "Takes you to GitHub and back. Read-only on your repositories."}
              </Muted>
            </div>
          ) : null}
        </SettingsCardBody>
      </CollapsibleCard>
    </div>
  );
}

function RepositoryStep({
  gateSetup,
  activeInstallations,
  current,
}: {
  gateSetup: GateSetup;
  activeInstallations: PublicGithubAppInstallation[];
  current: number;
}) {
  const installationRowId = gateSetup.installationRowId.value;
  const repositoryFullName = gateSetup.repositoryFullName.value;
  const repositories: InstallationRepository[] = gateSetup.repositories.value;
  const loading = gateSetup.repositoriesLoading.value;
  const busy = gateSetup.busy.value;

  return (
    <div>
      <SettingsCardHeader
        title="1 · Repository"
        aside={<StepBadge done={current > 1} current={current === 1} />}
      />
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
                {!installationRowId
                  ? "Pick an installation first…"
                  : loading
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
        <StepError gateSetup={gateSetup} step={null} />
      </SettingsCardBody>
    </div>
  );
}

function EnvironmentStep({ gateSetup, current }: { gateSetup: GateSetup; current: number }) {
  const choice = gateSetup.environmentChoice.value;
  const newName = gateSetup.newEnvironmentName.value;
  const environments: RepositoryEnvironment[] = gateSetup.environments.value;
  const loading = gateSetup.environmentsLoading.value;
  const repositoryPicked = gateSetup.repositoryPicked.value;
  const repositoryFullName = gateSetup.repositoryFullName.value;
  const environment = gateSetup.environment.value;
  const verification = gateSetup.verification.value;
  const busyStep = gateSetup.busyStep.value;
  const busy = gateSetup.busy.value;
  const creatingNew = choice === NEW_ENVIRONMENT_CHOICE;
  const found = verification?.environment === "present";

  return (
    <div>
      <SettingsCardHeader
        title="2 · GitHub environment"
        aside={<StepBadge done={found} current={current === 2} />}
      />
      <SettingsCardBody inset="belowHeader" gap="compact">
        <Muted class={`text-[13px] m-0 ${MEASURE}`}>
          The publish job runs in this environment. Drydock holds it there while it reviews the
          uploaded release artifacts.
        </Muted>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Environment" for="gateSetupEnv">
            <Select
              id="gateSetupEnv"
              value={choice}
              disabled={busy || !repositoryPicked || loading}
              onChange={(value) => void gateSetup.selectEnvironmentChoice(value)}
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
              <option value={NEW_ENVIRONMENT_CHOICE}>Create a new one on GitHub…</option>
            </Select>
          </Field>
          {creatingNew ? (
            <Field label="Name it" for="gateSetupNewEnv">
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
                Create it on GitHub under exactly this name — the generated workflow and the
                registry's trusted publisher are both pinned to it.
              </Muted>
            </Field>
          ) : null}
        </div>
        {creatingNew && repositoryPicked ? (
          <div class="flex flex-wrap items-center gap-3">
            <LinkButton
              href={environmentSettingsUrl(repositoryFullName)}
              target="_blank"
              rel="noreferrer"
              variant={current === 2 ? "primary" : "secondary"}
            >
              Create it on GitHub ↗
            </LinkButton>
            <Button
              variant="secondary"
              onClick={() => void gateSetup.verify()}
              disabled={busy || !environment}
            >
              {busyStep === "verify" ? "Checking…" : "Check it"}
            </Button>
          </div>
        ) : null}
        <VerificationNotice
          gateSetup={gateSetup}
          check={verification?.environment}
          absent={`Drydock cannot see an environment called "${environment}" on ${repositoryFullName}. Create it on GitHub, then check again.`}
        />
        <StepError gateSetup={gateSetup} step="verify" />
      </SettingsCardBody>
    </div>
  );
}

function ProtectionRuleStep({ gateSetup, current }: { gateSetup: GateSetup; current: number }) {
  const verification = gateSetup.verification.value;
  const environmentPicked = gateSetup.environmentPicked.value;
  const environmentFound = verification?.environment === "present";
  const environment = gateSetup.environment.value;
  const repositoryFullName = gateSetup.repositoryFullName.value;
  const busyStep = gateSetup.busyStep.value;
  const busy = gateSetup.busy.value;
  const enabled = verification?.protectionRule === "present";

  return (
    <div>
      <SettingsCardHeader
        title="3 · Drydock protection rule"
        aside={<StepBadge done={enabled} current={current === 3} />}
      />
      <SettingsCardBody inset="belowHeader" gap="compact">
        <Muted class={`text-[13px] m-0 ${MEASURE}`}>
          This is the step that actually pauses your release. In the environment's settings, enable
          Drydock under <strong>Deployment protection rules</strong>. Without it nothing holds the
          publish job, whatever else is configured here.
        </Muted>
        <div class="flex flex-wrap items-center gap-3">
          {environmentPicked ? (
            <>
              <LinkButton
                href={environmentSettingsUrl(repositoryFullName)}
                target="_blank"
                rel="noreferrer"
                variant={current === 3 ? "primary" : "secondary"}
              >
                Open environment settings ↗
              </LinkButton>
              <Button variant="secondary" onClick={() => void gateSetup.verify()} disabled={busy}>
                {busyStep === "verify" ? "Checking…" : enabled ? "Re-check" : "Check the rule"}
              </Button>
            </>
          ) : (
            <Blocked>Pick an environment in step 2 first.</Blocked>
          )}
        </div>
        {enabled ? (
          <Alert tone="ok">
            GitHub confirms Drydock is a deployment-protection rule on{" "}
            <code class="font-mono text-[12px]">{environment}</code>. Deployments to it now wait for
            a Drydock review.
          </Alert>
        ) : null}
        <VerificationNotice
          gateSetup={gateSetup}
          check={environmentFound ? verification?.protectionRule : undefined}
          absent={`Drydock is not yet a protection rule on "${environment}", so nothing is holding this environment's deployments. Enable it on GitHub, then check again.`}
        />
      </SettingsCardBody>
    </div>
  );
}

function PackageStep({
  gateSetup,
  ecosystems,
  releaseTarget,
  current,
}: {
  gateSetup: GateSetup;
  ecosystems: GateSetupEcosystemOption[];
  releaseTarget: PublicReleaseTarget | null;
  current: number;
}) {
  const ecosystem = gateSetup.ecosystem.value;
  const packageName = gateSetup.packageName.value;
  const packageNameIssue: string | null = gateSetup.packageNameIssue.value;
  const environmentIssue: string | null = gateSetup.environmentIssue.value;
  const busy = gateSetup.busy.value;
  const ecosystemLocked = releaseTarget?.ecosystem != null;

  return (
    <div>
      <SettingsCardHeader
        title="4 · What you publish"
        aside={<StepBadge done={gateSetup.templateReady.value} current={current === 4} />}
      />
      <SettingsCardBody inset="belowHeader" gap="compact">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Ecosystem" for="gateSetupEcosystem">
            <Select
              id="gateSetupEcosystem"
              value={ecosystem}
              disabled={busy || ecosystemLocked}
              onChange={(value) => gateSetup.selectEcosystem(value)}
            >
              <option value="">Pick an ecosystem…</option>
              {ecosystems.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </Select>
            {ecosystemLocked ? (
              <Muted class="text-[12px] mt-1.5">
                The mapped release target pins this ecosystem. Remove the mapping in step 6 before
                choosing another one.
              </Muted>
            ) : null}
          </Field>
          <Field label="Package name" for="gateSetupPackage">
            <Input
              id="gateSetupPackage"
              value={packageName}
              disabled={busy}
              placeholder="@acme/toolkit"
              onInput={(event) =>
                gateSetup.setPackageName((event.currentTarget as HTMLInputElement).value)
              }
            />
            {packageNameIssue ? (
              <Muted class="text-[12px] mt-1.5 text-warn-text">{packageNameIssue}</Muted>
            ) : (
              <Muted class="text-[12px] mt-1.5">
                Names the generated workflow and its registry pins. Drydock still derives the
                reviewed identity from the uploaded artifacts, never from this field.
              </Muted>
            )}
          </Field>
        </div>
        {environmentIssue ? <Alert tone="warn">{environmentIssue}</Alert> : null}
      </SettingsCardBody>
    </div>
  );
}

function WorkflowStep({ gateSetup, current }: { gateSetup: GateSetup; current: number }) {
  const preview = gateSetup.preview.value;
  const templateReady = gateSetup.templateReady.value;
  const verification = gateSetup.verification.value;
  const repositoryFullName = gateSetup.repositoryFullName.value;
  const busyStep = gateSetup.busyStep.value;
  const busy = gateSetup.busy.value;

  return (
    <div>
      <SettingsCardHeader
        title="5 · Publish workflow"
        aside={<StepBadge done={preview !== null} current={current === 5} />}
      />
      <SettingsCardBody inset="belowHeader" gap="compact">
        <Muted class={`text-[13px] m-0 ${MEASURE}`}>
          Build once, record <code class="font-mono text-[12px]">SHA256SUMS</code>, upload, pause at
          the environment, verify the digests on download, publish the reviewed bytes. Drydock wrote
          this file but has not reviewed it — read it before you commit it.
        </Muted>
        <div class="flex flex-wrap items-center gap-3">
          <Button
            variant={current === 5 ? "primary" : "secondary"}
            onClick={() => void gateSetup.loadPreview()}
            disabled={busy || !templateReady}
          >
            {busyStep === "preview"
              ? "Generating…"
              : preview
                ? "Regenerate workflow"
                : "Generate workflow"}
          </Button>
          {preview ? (
            <LinkButton
              href={newWorkflowFileUrl(
                repositoryFullName,
                verification?.defaultBranch ?? null,
                preview.workflowPath,
                preview.yaml,
              )}
              target="_blank"
              rel="noreferrer"
              variant="secondary"
            >
              Commit it on GitHub ↗
            </LinkButton>
          ) : null}
          {!templateReady ? (
            <Blocked>Choose an ecosystem and package name in step 4 first.</Blocked>
          ) : null}
        </div>
        <StepError gateSetup={gateSetup} step="preview" />

        {preview ? (
          <CodeBlock title={preview.workflowPath} lang="yaml" copyLabel="Copy workflow" defaultOpen>
            {preview.yaml}
          </CodeBlock>
        ) : null}
        {preview ? (
          <div class="flex flex-col gap-1.5">
            <MonoLabel>Finish the lockdown</MonoLabel>
            <ul class={`m-0 pl-5 list-disc flex flex-col gap-1 ${MEASURE}`}>
              {[...preview.notes, ...ENVIRONMENT_HARDENING].map((note) => (
                <li key={note} class="text-[13px] leading-[1.55] text-ink-muted">
                  {renderNote(note)}
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
  releaseTarget,
  onChanged,
  current,
}: {
  gateSetup: GateSetup;
  releaseTarget: PublicReleaseTarget | null;
  onChanged?: () => void;
  current: number;
}) {
  const environmentPicked = gateSetup.environmentPicked.value;
  const busyStep = gateSetup.busyStep.value;
  const busy = gateSetup.busy.value;

  const create = async () => {
    const created = await gateSetup.createReleaseTarget();
    if (created) onChanged?.();
  };

  const remove = async () => {
    if (!releaseTarget) return;
    const removed = await gateSetup.removeReleaseTarget(releaseTarget.id);
    if (removed) onChanged?.();
  };

  return (
    <div>
      <SettingsCardHeader
        title="6 · Release target"
        aside={<StepBadge done={releaseTarget !== null} current={current === 6} />}
      />
      <SettingsCardBody inset="belowHeader" gap="compact">
        <Muted class={`text-[13px] m-0 ${MEASURE}`}>
          The last piece: tell Drydock this repository and environment belong to your organization,
          so a held deployment resolves to a review here.
        </Muted>
        {releaseTarget ? (
          <div class="flex flex-wrap items-center justify-between gap-3">
            <MonoDetail
              parts={[
                <span key="repo">{releaseTarget.repositoryFullName}</span>,
                <span key="env">env {releaseTarget.environment}</span>,
                <span key="eco">{releaseTarget.ecosystem ?? "auto-detect"}</span>,
              ]}
            />
            <Button variant="ghost" size="sm" onClick={() => void remove()} disabled={busy}>
              {busyStep === "release_target_delete" ? "Removing…" : "Remove mapping"}
            </Button>
          </div>
        ) : (
          <div class="flex flex-wrap items-center gap-3">
            <Button
              variant={current === 6 ? "primary" : "secondary"}
              onClick={() => void create()}
              disabled={busy || !environmentPicked}
            >
              {busyStep === "release_target" ? "Mapping…" : "Create release target"}
            </Button>
            {!environmentPicked ? <Blocked>Pick an environment in step 2 first.</Blocked> : null}
          </div>
        )}
        <StepError gateSetup={gateSetup} step="release_target" />
      </SettingsCardBody>
    </div>
  );
}

/** Where the flow ends: what the maintainer should do next, not whitespace. */
function GateArmedSummary({ gateSetup }: { gateSetup: GateSetup }) {
  const environment = gateSetup.environment.value;
  return (
    <div>
      <SettingsCardHeader title="Gate armed" aside={<Badge tone="ok">verified</Badge>} />
      <SettingsCardBody inset="belowHeader" gap="compact">
        <Muted class={`text-[13px] m-0 ${MEASURE}`}>
          GitHub confirms Drydock gates <code class="font-mono text-[12px]">{environment}</code>,
          and this organization owns the release target. Merge the publish workflow, then push a
          release tag: the publish job will queue, its artifacts will arrive here for review, and
          nothing reaches the registry until you approve.
        </Muted>
        <div class="flex flex-wrap items-center gap-3">
          <LinkButton href="/dashboard" size="sm" variant="secondary">
            Back to the dashboard
          </LinkButton>
          <LinkButton href="/docs#workflow-gates" size="sm" variant="ghost">
            Read the gate docs
          </LinkButton>
        </div>
      </SettingsCardBody>
    </div>
  );
}

function StepBadge({ done, current }: { done: boolean; current: boolean }) {
  if (done) return <Badge tone="ok">done</Badge>;
  if (current) return <Badge tone="info">now</Badge>;
  return null;
}

/** Why a control is disabled, said next to the control rather than nowhere. */
function Blocked({ children }: { children: ComponentChildren }) {
  return <Muted class="text-[12px] m-0">{children}</Muted>;
}

/**
 * What a verification read found.
 *
 * `unknown` never renders as a problem with the maintainer's setup — it is
 * Drydock reporting that it could not check, which is a different claim and
 * must not be dressed up as either success or failure.
 */
function VerificationNotice({
  gateSetup,
  check,
  absent,
}: {
  gateSetup: GateSetup;
  check: "present" | "absent" | "unknown" | undefined;
  absent: string;
}) {
  const reason = gateSetup.verification.value?.unavailableReason;
  if (check === "unknown") {
    return (
      <Alert tone="info">
        {reason ?? "Drydock could not read this from GitHub, so it cannot confirm the gate."} Check
        again in a moment.
      </Alert>
    );
  }
  if (check === "absent") return <Alert tone="warn">{absent}</Alert>;
  return null;
}

/** An error rendered against the step that raised it. */
function StepError({
  gateSetup,
  step,
}: {
  gateSetup: GateSetup;
  step: "verify" | "preview" | "release_target" | null;
}) {
  const error = gateSetup.error.value;
  if (!error || gateSetup.errorStep.value !== step) return null;
  return <Alert tone="critical">{error}</Alert>;
}
