import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useComputed, useModel, useSignalEffect } from "@preact/signals";
import { Show, useLiveSignal } from "@preact/signals/utils";
import type { PublisherSetupJobStage } from "../../../server/lib/github-app/setup-types";
import { activeOrganizationId } from "../../models/active-organization";
import type { PublicGithubAppInstallation } from "../../models/github-app";
import { PublisherSetupModel, type SetupOperation } from "../../models/publisher-setup";
import { ReleaseTargetsModel } from "../../models/release-targets";
import { scanDetailPath } from "../../lib/scan-detail-path";
import { Alert } from "../../components/Alert";
import { Button, LinkButton } from "../../components/Button";
import { SettingsCardBody, SettingsCardHeader } from "../../components/Card";
import { cn } from "../../components/cn";
import { CopyButton } from "../../components/CopyButton";
import { DiffView } from "../../components/DiffView";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { Select } from "../../components/Select";
import { LoadingLine, MonoLabel, Muted } from "../../components/Typography";

type SetupModel = InstanceType<typeof PublisherSetupModel>;
type StepState = "done" | "active" | "upcoming";

export function PublisherSetup({
  installations,
  targets,
}: {
  installations: PublicGithubAppInstallation[];
  targets: InstanceType<typeof ReleaseTargetsModel>;
}) {
  const model = useModel(PublisherSetupModel);
  const installationInput = useLiveSignal(installations);
  const availableInstallations = useComputed(() =>
    installationInput.value.filter(
      (installation) =>
        installation.status === "active" &&
        installation.organizationId === activeOrganizationId.value,
    ),
  );
  useSignalEffect(() => {
    const available = availableInstallations.value;
    const selected = model.installationRowId.value;
    // An organization switch can restore a pending job before its installations
    // replace the previous organization's list; that empty projection is not
    // authority to discard the restored job.
    if (available.length === 0) return;
    if (!available.some((installation) => installation.id === selected)) {
      const next = available[0].id;
      if (next !== selected) void model.selectInstallation(next);
    }
  });

  // Drafting is optional (a workflow may already use the environment), so the
  // verify step opens as soon as a repository is chosen; it only takes the
  // primary action once the workflow step is finished or skipped past.
  // A draft job restored after a reload has no inspection, but its progress,
  // result, and failure (including a job that is no longer available) still
  // belong to this step.
  const workflowState = useComputed<StepState>(() => {
    if (model.pullRequest.value) return "done";
    const failed =
      Boolean(model.error.value) &&
      (model.failedOperation.value === "drafting" || model.failedOperation.value === "cancelling");
    const started = model.inspection.value || model.draftJobId.value || model.draft.value || failed;
    return started ? "active" : "upcoming";
  });
  const verifyState = useComputed<StepState>(() => {
    const status = model.setupStatus.value;
    const repository = model.repositoryFullName.value;
    if (status && status.checks.every((check) => check.status === "passed")) return "done";
    return repository ? "active" : "upcoming";
  });
  // Exactly one primary action: `Prepare draft pull request` renders only for
  // an inspection with workflows, so verification leads whenever it is absent
  // (including a restored job, which has no inspection) or a PR exists.
  const verifyLeads = useComputed(() => {
    const inspection = model.inspection.value;
    const draftable = Boolean(inspection && inspection.workflows.length > 0);
    return Boolean(model.pullRequest.value) || !draftable;
  });

  return (
    <div>
      <SettingsCardHeader title="Prepare a release workflow" />
      <SettingsCardBody inset="belowHeader">
        <Muted class="m-0 text-[13px] max-w-[680px]">
          Drydock prepares the workflow change as a draft pull request and checks your GitHub
          environment. You review and merge the pull request in GitHub.
        </Muted>
        <ol class="m-0 p-0 list-none flex flex-col">
          <SetupStep
            index={1}
            title="Choose the release"
            state={model.inspection.value ? "done" : "active"}
            description="The GitHub environment named here holds the publish job until you approve or reject it in Drydock."
          >
            <ReleaseFields model={model} installations={availableInstallations.value} />
          </SetupStep>
          <SetupStep
            index={2}
            title="Update the publishing workflow"
            state={workflowState.value}
            description={
              <>
                Drydock opens a draft pull request that publishes from a job using the{" "}
                <span class="font-mono text-[12px] text-ink">
                  {model.environment.value.trim() || "selected"}
                </span>{" "}
                environment. Skip this step if your workflow already does.
              </>
            }
          >
            <WorkflowDraft model={model} />
          </SetupStep>
          <SetupStep
            index={3}
            title="Protect the environment and verify"
            state={verifyState.value}
            last
            description="In GitHub, add the Drydock deployment protection rule to the environment, then run your publishing workflow. GitHub holds only the job that uses that environment."
          >
            <SetupChecks model={model} targets={targets} primary={verifyLeads.value} />
          </SetupStep>
        </ol>
      </SettingsCardBody>
    </div>
  );
}

function SetupStep({
  index,
  title,
  state,
  description,
  last = false,
  children,
}: {
  index: number;
  title: string;
  state: StepState;
  description: ComponentChildren;
  last?: boolean;
  children: ComponentChildren;
}) {
  return (
    <li class="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3">
      <div class="flex flex-col items-center">
        <span
          aria-hidden
          class={cn(
            "font-mono text-[11px] font-medium tabular-nums leading-none pt-[4px]",
            state === "done" ? "text-ok-text" : state === "active" ? "text-ink" : "text-ink-subtle",
          )}
        >
          {state === "done" ? "✓" : String(index).padStart(2, "0")}
        </span>
        {last ? null : <span class="w-px flex-1 bg-border mt-2" aria-hidden />}
      </div>
      <div class={cn("flex flex-col gap-4 min-w-0", !last && "pb-7")}>
        <div class="flex flex-col gap-1">
          <h4
            class={cn(
              "m-0 text-[14px] font-medium tracking-[-0.005em]",
              state === "upcoming" ? "text-ink-muted" : "text-ink",
            )}
          >
            {title}
            {state === "done" ? <span class="sr-only"> (done)</span> : null}
          </h4>
          <Muted class="m-0 text-[13px] leading-[1.55] max-w-[680px]">{description}</Muted>
        </div>
        {state === "upcoming" ? null : children}
      </div>
    </li>
  );
}

function StepError({ model, operations }: { model: SetupModel; operations: SetupOperation[] }) {
  return (
    <Show
      when={() =>
        model.failedOperation.value && operations.includes(model.failedOperation.value)
          ? model.error.value
          : null
      }
    >
      {(message) => <Alert tone="critical">{message}</Alert>}
    </Show>
  );
}

function ReleaseFields({
  model,
  installations,
}: {
  model: SetupModel;
  installations: PublicGithubAppInstallation[];
}) {
  // A single installation is already named in the list above; picking it again
  // is a no-op control.
  const pickInstallation = installations.length > 1;
  const inspect = () => void model.inspect();
  // A closed native select fires `change` on every arrow key on Windows and
  // Linux, so wait for the choice to settle before reading workflows.
  const pendingInspect = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pendingInspect.current), []);
  const repositoryField = (
    <RepositoryField
      model={model}
      onSelect={(value) => {
        clearTimeout(pendingInspect.current);
        model.selectRepository(value);
        if (value) pendingInspect.current = setTimeout(inspect, 400);
      }}
    />
  );
  return (
    <div class="flex flex-col gap-3">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        {pickInstallation ? (
          <Field label="Installation" for="publisherSetupInstallation">
            <Select
              id="publisherSetupInstallation"
              value={model.installationRowId}
              disabled={model.inputsLocked}
              onChange={(value) => void model.selectInstallation(value)}
            >
              <option value="">Choose an installation…</option>
              {installations.map((installation) => (
                <option key={installation.id} value={installation.id}>
                  {installation.accountLogin}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {pickInstallation ? repositoryField : <div class="md:col-span-2">{repositoryField}</div>}
        <Field label="Package ecosystem" for="publisherSetupEcosystem">
          <Select
            id="publisherSetupEcosystem"
            value={model.ecosystem}
            disabled={model.inputsLocked}
            onChange={(value) => {
              if (value === "npm" || value === "pypi" || value === "vscode")
                model.setEcosystem(value);
            }}
          >
            <option value="npm">npm</option>
            <option value="pypi">PyPI</option>
            <option value="vscode">VS Code extensions</option>
          </Select>
        </Field>
        <Field label="GitHub environment" for="publisherSetupEnvironment">
          <Input
            id="publisherSetupEnvironment"
            mono
            value={model.environment}
            disabled={model.inputsLocked}
            maxLength={255}
            onInput={(event) => model.setEnvironment(event.currentTarget.value)}
          />
        </Field>
      </div>
      <Show when={model.repositoryError}>
        {(message) => (
          <div class="flex flex-col gap-2">
            <Alert tone="critical">{message}</Alert>
            <div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void model.selectInstallation(model.installationRowId.peek())}
              >
                Load repositories again
              </Button>
            </div>
          </div>
        )}
      </Show>
      <StepError model={model} operations={["inspecting"]} />
      <Show when={() => model.operation.value === "inspecting"}>
        <LoadingLine size="inline">Reading workflows from the default branch</LoadingLine>
      </Show>
      <Show
        when={() =>
          Boolean(model.repositoryFullName.value) && model.operation.value !== "inspecting"
        }
      >
        <div class="flex flex-wrap items-center gap-3">
          <Show when={model.inspection}>
            {(inspection) => (
              <Muted class="m-0 font-mono text-[12px]">
                {inspection.workflows.length}{" "}
                {inspection.workflows.length === 1 ? "workflow" : "workflows"} on{" "}
                {inspection.defaultBranch} · {inspection.baseSha.slice(0, 7)}
              </Muted>
            )}
          </Show>
          <Button variant="ghost" size="sm" disabled={model.inputsLocked} onClick={inspect}>
            <Show when={model.inspection} fallback="Inspect workflows">
              Inspect again
            </Show>
          </Button>
        </div>
      </Show>
    </div>
  );
}

function RepositoryField({
  model,
  onSelect,
}: {
  model: SetupModel;
  onSelect: (value: string) => void;
}) {
  // Choosing another repository while inspecting aborts that inspection.
  const disabled = useComputed(
    () =>
      model.inputsLocked.value || model.loadingRepositories.value || !model.installationRowId.value,
  );
  return (
    <Field label="Repository" for="publisherSetupRepository">
      <Select
        id="publisherSetupRepository"
        value={model.repositoryFullName}
        disabled={disabled}
        onChange={onSelect}
      >
        <option value="">
          {model.loadingRepositories.value ? "Loading repositories…" : "Choose a repository…"}
        </option>
        {model.repositories.value.map((repository) => (
          <option key={repository.id} value={repository.fullName}>
            {repository.fullName}
          </option>
        ))}
      </Select>
      <Show
        when={() =>
          Boolean(model.installationRowId.value) &&
          !model.loadingRepositories.value &&
          !model.repositoryError.value &&
          model.repositories.value.length === 0
        }
      >
        <Muted class="mt-1.5 text-[12px]">No repositories are visible to this installation.</Muted>
      </Show>
    </Field>
  );
}

function WorkflowDraft({ model }: { model: SetupModel }) {
  return (
    <div class="flex flex-col gap-4">
      <Show when={model.inspection}>
        {(inspection) => <DraftRequest model={model} inspection={inspection} />}
      </Show>
      <StepError model={model} operations={["drafting", "cancelling"]} />
      <Show when={model.draftJobId}>
        <DraftProgress model={model} />
      </Show>
      <Show when={model.pullRequest}>
        {(pullRequest) => <PreparedPullRequest model={model} pullRequest={pullRequest} />}
      </Show>
    </div>
  );
}

function DraftRequest({
  model,
  inspection,
}: {
  model: SetupModel;
  inspection: NonNullable<SetupModel["inspection"]["value"]>;
}) {
  const disabled = useComputed(() => !model.canDraft.value);
  const warnings = inspection.warnings.map((warning) => (
    <Alert key={warning} tone="warn">
      {warning}
    </Alert>
  ));
  // With nothing to draft, the step offers no action of its own; verification leads.
  if (inspection.workflows.length === 0)
    return (
      <div class="flex flex-col gap-4">
        <Alert tone="warn">
          No supported workflow files were found; add a publishing workflow before preparing a
          change.
        </Alert>
        {warnings}
      </div>
    );
  return (
    <div class="flex flex-col gap-4">
      {warnings}
      <Field label="Publishing workflow" for="publisherSetupWorkflow">
        <Select
          id="publisherSetupWorkflow"
          mono
          value={model.workflowPath}
          disabled={model.inputsLocked}
          onChange={model.selectWorkflow}
        >
          <option value="">Choose a workflow…</option>
          {inspection.workflows.map((workflow) => (
            <option key={workflow.path} value={workflow.path}>
              {workflow.path}
            </option>
          ))}
        </Select>
      </Field>
      <div class="flex flex-col gap-2">
        <div>
          <Button
            variant={model.pullRequest.value ? "secondary" : "primary"}
            disabled={disabled}
            onClick={() => void model.preparePullRequest()}
          >
            <Show
              when={() => model.operation.value === "drafting"}
              fallback="Prepare draft pull request"
            >
              Starting preparation…
            </Show>
          </Button>
        </div>
        <Muted class="m-0 text-[12px] leading-[1.55] max-w-[680px]">
          Preparing sends the workflow and supporting release files to the configured AI model,
          validates the change, and runs an independent review. If those checks pass, Drydock opens
          a draft pull request. A generated workflow does not by itself protect your release.
        </Muted>
      </div>
    </div>
  );
}

const DRAFT_STAGE_LABELS: Record<PublisherSetupJobStage, string> = {
  queued: "Waiting for the draft to start…",
  fetch_source: "Reading the pinned workflow…",
  draft: "Drafting the workflow change…",
  validate: "Checking the proposed workflow structure…",
  judge: "Running an independent review of the change…",
  create_pr: "Opening the draft pull request in GitHub…",
  ready: "Draft pull request ready for review in GitHub.",
};

function DraftProgress({ model }: { model: SetupModel }) {
  const job = model.draftJob.value;
  const judge = job?.judge;
  const progress = useComputed(() => {
    const current = model.draftJob.value;
    if (!current) return "Restoring draft status…";
    if (current.status === "failed") return "Draft pull request preparation did not complete.";
    return DRAFT_STAGE_LABELS[current.stage];
  });
  return (
    <div class="flex flex-col gap-3">
      <div aria-live="polite">
        <Muted class="m-0 font-mono text-[12px]">{progress}</Muted>
      </div>
      <Show when={model.draftPending}>
        <Muted class="m-0 text-[12px] leading-[1.55] max-w-[680px]">
          Preparation continues if you leave this page, and the selection stays locked until it
          finishes or you cancel. A draft pull request opens automatically when the checks pass.
        </Muted>
      </Show>
      <Show when={model.pollingError}>{(message) => <Alert tone="warn">{message}</Alert>}</Show>
      <Show when={model.pollingPaused}>
        <div>
          <Button variant="secondary" onClick={model.resumeDraftStatus}>
            Resume draft status
          </Button>
        </div>
      </Show>
      {job?.status === "failed" && job.feedback?.length ? (
        <section class="flex flex-col gap-2" aria-label="Agent feedback">
          <h5 class="m-0 text-[14px] font-medium">Agent feedback</h5>
          <ul class="m-0 pl-5 list-disc marker:text-ink-subtle flex flex-col gap-1.5 text-[13px] leading-[1.55] max-w-[680px]">
            {job.feedback.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {judge ? (
        <div class="flex flex-col gap-2">
          <h5 class="m-0 text-[14px] font-medium">Independent review</h5>
          <Muted class="m-0 text-[13px] leading-[1.55] max-w-[680px]">{judge.summary}</Muted>
          {judge.issues.length ? (
            <ul class="m-0 pl-5 list-disc marker:text-ink-subtle flex flex-col gap-1.5 text-[13px] leading-[1.55] max-w-[680px]">
              {judge.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
          <Muted class="m-0 text-[12px]">
            {judge.verdict === "pass"
              ? "No changes requested by the independent reviewer; your review is still required."
              : "Changes requested; this attempt cannot create a pull request."}
          </Muted>
        </div>
      ) : null}
      <Show when={() => model.draftPending.value && model.draftJob.value?.stage !== "create_pr"}>
        <div>
          <Button
            variant="ghost"
            size="sm"
            disabled={model.busy}
            onClick={() => void model.cancelJob()}
          >
            {model.operation.value === "cancelling" ? "Cancelling…" : "Cancel preparation"}
          </Button>
        </div>
      </Show>
    </div>
  );
}

function PreparedPullRequest({
  model,
  pullRequest,
}: {
  model: SetupModel;
  pullRequest: NonNullable<SetupModel["pullRequest"]["value"]>;
}) {
  const proposal = model.draft.value?.proposal;
  return (
    <div class="flex flex-col gap-4 pt-4 border-t border-border">
      <div class="flex flex-col gap-1">
        <h5 class="m-0 text-[14px] font-medium">Draft pull request ready</h5>
        <Muted class="m-0 text-[13px] leading-[1.55] max-w-[680px]">
          Review the generated workflow in GitHub, then merge it and complete the environment setup.
          The pull request stays a draft until you mark it ready for review.
        </Muted>
      </div>
      <div>
        <LinkButton
          href={pullRequest.url}
          target="_blank"
          rel="noopener noreferrer"
          variant="secondary"
        >
          Review pull request #{pullRequest.number} on GitHub
        </LinkButton>
      </div>
      {proposal?.manualSteps.length ? (
        <div class="flex flex-col gap-2">
          <MonoLabel>Remaining steps</MonoLabel>
          <ol class="m-0 pl-5 list-decimal marker:text-ink-subtle marker:font-mono marker:text-[12px] flex flex-col gap-1.5 text-[13px] leading-[1.55] max-w-[680px]">
            {proposal.manualSteps.map((step) => (
              <li key={step} class="pl-1">
                {step}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <Show when={model.draft}>
        <ProposalDetails model={model} />
      </Show>
    </div>
  );
}

function ProposalDetails({ model }: { model: SetupModel }) {
  const draft = model.draft.value!;
  const original = model.inspection.value?.workflows.find(
    (workflow) => workflow.path === draft.proposal.workflowPath,
  );
  return (
    <details class="group">
      <summary class="cursor-pointer list-none text-[13px] font-medium text-ink-muted hover:text-ink">
        <span aria-hidden class="mr-1.5 font-mono text-ink-subtle">
          <span class="group-open:hidden">▸</span>
          <span class="hidden group-open:inline">▾</span>
        </span>
        View workflow changes
      </summary>
      <div class="flex flex-col gap-4 mt-4">
        <Muted class="m-0 text-[13px] leading-[1.55] max-w-[680px]">{draft.proposal.summary}</Muted>
        <DiffView
          path={draft.proposal.workflowPath}
          status="modified"
          before={{ textSample: model.originalContent.value ?? original?.content ?? "" }}
          after={{ textSample: draft.proposal.content }}
          beforeLabel="Current workflow"
          afterLabel="Proposed workflow"
        />
        <div>
          <CopyButton text={draft.proposal.content} label="Copy proposed workflow" />
        </div>
        {draft.proposal.supportingFiles?.map((file) => (
          <section
            key={file.path}
            class="flex flex-col gap-3"
            aria-label={`Proposed file ${file.path}`}
          >
            <DiffView
              path={file.path}
              status={file.originalSha === null ? "added" : "modified"}
              before={file.originalContent === null ? null : { textSample: file.originalContent }}
              after={{ textSample: file.content }}
              beforeLabel={file.originalSha === null ? "Not in repository" : "Current file"}
              afterLabel="Proposed file"
            />
            <div>
              <CopyButton text={file.content} label={`Copy ${file.path}`} />
            </div>
          </section>
        ))}
      </div>
    </details>
  );
}

function SetupChecks({
  model,
  targets,
  primary,
}: {
  model: SetupModel;
  targets: InstanceType<typeof ReleaseTargetsModel>;
  primary: boolean;
}) {
  const disabled = useComputed(() => !model.canCheck.value);
  const settingsUrl = useComputed(
    () => `https://github.com/${model.repositoryFullName.value}/settings/environments`,
  );
  const mapTarget = async () => {
    if (await model.mapReleaseTarget()) {
      await targets.load();
      await model.checkStatus();
    }
  };
  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center gap-3">
        <LinkButton
          href={settingsUrl}
          target="_blank"
          rel="noopener noreferrer"
          variant="secondary"
        >
          Open GitHub environments
        </LinkButton>
        <Button
          disabled={disabled}
          variant={primary ? "primary" : "secondary"}
          onClick={() => void model.checkStatus()}
        >
          <Show when={() => model.operation.value === "checking"} fallback="Check setup status">
            Checking setup…
          </Show>
        </Button>
      </div>
      <StepError model={model} operations={["checking", "mapping"]} />
      <Show when={model.setupStatus}>
        <StatusResult model={model} onMapTarget={mapTarget} />
      </Show>
    </div>
  );
}

function StatusResult({
  model,
  onMapTarget,
}: {
  model: SetupModel;
  onMapTarget: () => Promise<void>;
}) {
  const status = model.setupStatus.value!;
  const scanId = useComputed(() => model.setupStatus.value?.firstReview?.scanId ?? null);
  return (
    <div class="flex flex-col gap-3" aria-live="polite">
      <ul class="m-0 p-0 list-none border border-border rounded-md divide-y divide-border">
        {status.checks.map((check) => (
          <li key={check.label} class="px-4 py-3 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4">
            <div class="flex flex-col gap-1 min-w-0">
              <span class="text-[13px] font-medium">{check.label}</span>
              <Muted class="m-0 text-[13px] leading-[1.55]">{check.detail}</Muted>
            </div>
            <span
              class={cn(
                "font-mono text-[12px] leading-[1.6] whitespace-nowrap",
                check.status === "passed" ? "text-ok-text" : "text-ink-subtle",
              )}
            >
              {check.status === "passed" ? "✓ passed" : check.status}
            </span>
          </li>
        ))}
      </ul>
      <Show when={() => !model.setupStatus.value!.targetMapped}>
        <div>
          <Button disabled={model.busy} variant="secondary" onClick={() => void onMapTarget()}>
            <Show
              when={() => model.operation.value === "mapping"}
              fallback="Map this release target"
            >
              Mapping target…
            </Show>
          </Button>
        </div>
      </Show>
      <Show
        when={() => model.setupStatus.value!.firstReview?.scanStatus === "complete"}
        fallback={
          <Muted class="m-0 text-[13px]">
            A completed pre-publish review has not been observed for this repository and
            environment.
          </Muted>
        }
      >
        <Alert tone="ok">
          The first pre-publish review completed; open the report to make the release decision.
        </Alert>
      </Show>
      <Show when={scanId}>
        {(scanId) => (
          <div>
            <LinkButton
              href={scanDetailPath(scanId, activeOrganizationId.value)}
              variant="secondary"
            >
              Open pre-publish review
            </LinkButton>
          </div>
        )}
      </Show>
    </div>
  );
}
