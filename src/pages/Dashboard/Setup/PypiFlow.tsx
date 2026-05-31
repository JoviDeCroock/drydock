import { useComputed, useModel, useSignal } from "@preact/signals";
import type {
  GithubAppModel,
  PublicGithubAppInstallation,
  PublicReleaseTarget,
} from "../../../models/github-app";
import {
  Alert,
  Badge,
  Button,
  CodeBlock,
  Field,
  Input,
  LinkButton,
  Muted,
  Select,
} from "../../../components";
import { ReleaseTargetForm } from "../Settings/ReleaseTargetForm";
import { Checklist, StepCard } from "./StepCard";
import { pypiReleaseWorkflow, setupDefaults } from "./workflow-templates";

type GithubApp = ReturnType<typeof useModel<typeof GithubAppModel.prototype>>;

export function PypiFlow({ githubApp }: { githubApp: GithubApp }) {
  const environment = useSignal<string>(setupDefaults.pypiEnvironment);
  const pythonVersion = useSignal("3.12");
  const selectedReleaseTargetId = useSignal("");

  const workflowYaml = useComputed(() =>
    pypiReleaseWorkflow({
      environment: environment.value,
      pythonVersion: pythonVersion.value,
    }),
  );

  const installations = githubApp.installations.value;
  const activeInstallations = installations.filter(
    (row: PublicGithubAppInstallation) => row.status === "active",
  );
  const releaseTargets = githubApp.releaseTargets.value;
  const selectedReleaseTarget =
    releaseTargets.find(
      (target: PublicReleaseTarget) => target.id === selectedReleaseTargetId.value,
    ) ?? null;
  const normalizedFlowEnvironment = (environment.value || setupDefaults.pypiEnvironment)
    .trim()
    .toLowerCase();
  const selectedTargetMatchesFlow =
    selectedReleaseTarget !== null &&
    selectedReleaseTarget.environment.toLowerCase() === normalizedFlowEnvironment;

  const selectReleaseTarget = (targetId: string) => {
    selectedReleaseTargetId.value = targetId;
    const target = releaseTargets.find((row: PublicReleaseTarget) => row.id === targetId);
    if (target) environment.value = target.environment;
  };

  const onReleaseTargetCreated = (target: PublicReleaseTarget) => {
    selectedReleaseTargetId.value = target.id;
    environment.value = target.environment;
  };

  return (
    <div class="flex flex-col gap-4">
      <StepCard
        index="01"
        title="Install the Drydock GitHub App"
        status={activeInstallations.length ? "done" : "todo"}
        summary="Install Drydock on the organization that owns the release repository so it can hold the deployment and post the approve/reject decision back to GitHub."
      >
        <InstallStep githubApp={githubApp} activeInstallations={activeInstallations} />
      </StepCard>

      <StepCard
        index="02"
        title="Add the PyPI release workflow"
        status="manual"
        summary="A tag-triggered workflow builds the wheel + sdist, uploads them for review, and publishes via Trusted Publishing — no PyPI token. The publish job never rebuilds."
      >
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="GitHub environment" for="pypiFlowEnv">
            <Input
              id="pypiFlowEnv"
              type="text"
              value={environment.value}
              placeholder={setupDefaults.pypiEnvironment}
              onInput={(e) => (environment.value = (e.target as HTMLInputElement).value)}
              autoComplete="off"
              spellcheck={false}
            />
          </Field>
          <Field label="Python version" for="pypiFlowPython">
            <Input
              id="pypiFlowPython"
              type="text"
              value={pythonVersion.value}
              placeholder="3.12"
              onInput={(e) => (pythonVersion.value = (e.target as HTMLInputElement).value)}
              autoComplete="off"
              spellcheck={false}
            />
          </Field>
        </div>
        <CodeBlock
          label={`.github/workflows/${setupDefaults.pypiWorkflowFilename}`}
          code={workflowYaml.value}
        />
        <Muted class="text-[12px] leading-[1.55] m-0">
          Commit this to{" "}
          <code class="font-mono text-ink-subtle">
            .github/workflows/{setupDefaults.pypiWorkflowFilename}
          </code>
          . The <code class="font-mono text-ink-subtle">publish</code> job pauses on the{" "}
          <code class="font-mono text-ink-subtle">
            {environment.value || setupDefaults.pypiEnvironment}
          </code>{" "}
          environment and downloads exactly the reviewed artifact — it never rebuilds. For
          hardening, pin each action to a commit SHA.
        </Muted>
      </StepCard>

      <StepCard
        index="03"
        title="Configure the GitHub environment gate"
        status="manual"
        summary="Create the environment your publish job deploys to, add Drydock as a deployment protection rule, and point a PyPI Trusted Publisher at the same environment name."
      >
        <Checklist
          items={[
            <>
              Create (or open) the{" "}
              <code class="font-mono text-ink-subtle">
                {environment.value || setupDefaults.pypiEnvironment}
              </code>{" "}
              GitHub Actions environment on the release repository. See{" "}
              <a
                class="underline"
                href="https://docs.github.com/en/actions/deployment/targeting-different-environments/managing-environments-for-deployment"
                target="_blank"
                rel="noreferrer"
              >
                managing environments
              </a>
              .
            </>,
            <>
              Enable Drydock as a{" "}
              <a
                class="underline"
                href="https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-custom-deployment-protection-rules"
                target="_blank"
                rel="noreferrer"
              >
                custom deployment protection rule
              </a>{" "}
              on that environment so the publish job pauses for review.
            </>,
            <>
              On PyPI, configure a{" "}
              <a
                class="underline"
                href="https://docs.pypi.org/trusted-publishers/"
                target="_blank"
                rel="noreferrer"
              >
                Trusted Publisher
              </a>{" "}
              for the same repository and workflow, with its environment name matching{" "}
              <code class="font-mono text-ink-subtle">
                {environment.value || setupDefaults.pypiEnvironment}
              </code>{" "}
              exactly.
            </>,
          ]}
        />
        <Muted class="text-[12px] leading-[1.55] m-0">
          The environment name must match across the workflow, the GitHub environment, and the PyPI
          Trusted Publisher — that shared name is what ties the gate to the OIDC exchange. Drydock
          never holds PyPI credentials.
        </Muted>
      </StepCard>

      <StepCard
        index="04"
        title="Map the release target"
        status={selectedTargetMatchesFlow ? "done" : "todo"}
        summary="Tell Drydock which package, repository, and environment this flow gates. Pick an existing mapping explicitly or create a new one below."
      >
        {releaseTargets.length ? (
          <ExistingReleaseTargetPicker
            releaseTargets={releaseTargets}
            selectedId={selectedReleaseTargetId.value}
            onSelect={selectReleaseTarget}
          />
        ) : null}
        {selectedReleaseTarget && selectedTargetMatchesFlow ? (
          <Muted class="text-[12px] m-0">
            Using {selectedReleaseTarget.packageName} on{" "}
            <code class="font-mono text-ink-subtle">
              {selectedReleaseTarget.repositoryFullName}
            </code>{" "}
            / <code class="font-mono text-ink-subtle">{selectedReleaseTarget.environment}</code>.
          </Muted>
        ) : selectedReleaseTarget ? (
          <Alert tone="warn">
            The selected target uses environment {selectedReleaseTarget.environment}; update the
            workflow environment or pick a matching target.
          </Alert>
        ) : releaseTargets.length ? (
          <Muted class="text-[12px] m-0">
            Existing mappings are available, but none is selected for this setup flow yet.
          </Muted>
        ) : null}
        {activeInstallations.length ? (
          <div class="border border-border rounded-lg overflow-hidden">
            <ReleaseTargetForm
              githubApp={githubApp}
              activeInstallations={activeInstallations}
              onCreated={onReleaseTargetCreated}
            />
          </div>
        ) : (
          <Muted class="text-[13px] m-0">
            Install the GitHub App on an organization with the repo you want to gate (step 01)
            before mapping a release target.
          </Muted>
        )}
        {releaseTargets.length ? (
          <Muted class="text-[12px] m-0">
            {releaseTargets.length} release target{releaseTargets.length === 1 ? "" : "s"} mapped in
            this organization. Manage them in{" "}
            <a class="underline" href="/dashboard/settings">
              settings
            </a>
            .
          </Muted>
        ) : null}
      </StepCard>

      <StepCard
        index="05"
        title="Test the gate"
        status="manual"
        summary="Push a v* tag. The publish job pauses on the environment, the held release shows up on your dashboard, and your approval releases or blocks it."
      >
        <Muted class="text-[13px] leading-[1.55] m-0">
          When the workflow reaches the <code class="font-mono text-ink-subtle">publish</code> job
          it waits for Drydock's review. The held deployment appears on your dashboard as a gate;
          once you approve, the same job resumes and publishes via Trusted Publishing.
        </Muted>
        <LinkButton variant="secondary" size="sm" href="/dashboard" class="self-start">
          Open dashboard
        </LinkButton>
      </StepCard>
    </div>
  );
}

function ExistingReleaseTargetPicker({
  releaseTargets,
  selectedId,
  onSelect,
}: {
  releaseTargets: PublicReleaseTarget[];
  selectedId: string;
  onSelect: (targetId: string) => void;
}) {
  return (
    <Field label="Release target for this flow" for="pypiFlowReleaseTarget">
      <Select id="pypiFlowReleaseTarget" value={selectedId} onChange={onSelect}>
        <option value="">Map a new target below…</option>
        {releaseTargets.map((target) => (
          <option key={target.id} value={target.id}>
            {target.packageName} · {target.repositoryFullName} · env {target.environment}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function InstallStep({
  githubApp,
  activeInstallations,
}: {
  githubApp: GithubApp;
  activeInstallations: PublicGithubAppInstallation[];
}) {
  const configured = githubApp.config.value?.configured === true;
  const appSlug = githubApp.config.value?.appSlug;
  const status = githubApp.status.value;
  const busy = githubApp.busy.value;
  const error = githubApp.error.value;
  const installations = githubApp.installations.value;

  return (
    <>
      <div class="flex items-center gap-2">
        {activeInstallations.length ? (
          <Badge tone="ok">installed · {activeInstallations.length} active</Badge>
        ) : configured ? (
          <Badge tone="neutral">not installed</Badge>
        ) : (
          <Badge tone="info">not configured</Badge>
        )}
        {configured && appSlug ? (
          <span class="font-mono text-[11px] text-ink-subtle">{appSlug}</span>
        ) : null}
      </div>

      {!configured ? (
        <Alert tone="warn">
          The GitHub App isn't configured on this Drydock instance yet — ask the operator to add the
          GitHub App secrets on the Worker before installing.
        </Alert>
      ) : null}

      {error ? <Alert tone="critical">{error}</Alert> : null}

      <div class="flex flex-wrap items-center gap-3">
        <Button onClick={() => void githubApp.startInstall()} disabled={!configured || busy}>
          {status === "starting"
            ? "Redirecting…"
            : installations.length
              ? "Install on another organization"
              : "Install GitHub App"}
        </Button>
        <Muted class="text-[12px] m-0">
          You'll pick the account to install on at GitHub, then return here.
        </Muted>
      </div>
    </>
  );
}
