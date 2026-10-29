import { useComputed, useModel, useSignalEffect } from "@preact/signals";
import { Show, useLiveSignal } from "@preact/signals/utils";
import type { PublisherSetupJobStage } from "../../../server/lib/github-app/setup-types";
import { activeOrganizationId } from "../../models/active-organization";
import type { PublicGithubAppInstallation } from "../../models/github-app";
import { PublisherSetupModel } from "../../models/publisher-setup";
import { ReleaseTargetsModel } from "../../models/release-targets";
import { scanDetailPath } from "../../lib/scan-detail-path";
import { Alert } from "../../components/Alert";
import { Badge } from "../../components/Badge";
import { Button, LinkButton } from "../../components/Button";
import { SettingsCardBody, SettingsCardHeader } from "../../components/Card";
import { CopyButton } from "../../components/CopyButton";
import { DiffView } from "../../components/DiffView";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { Select } from "../../components/Select";
import { Muted } from "../../components/Typography";

type SetupModel = InstanceType<typeof PublisherSetupModel>;

export function PublisherSetup({
  installations,
  targets,
}: {
  installations: PublicGithubAppInstallation[];
  targets: InstanceType<typeof ReleaseTargetsModel>;
}) {
  const model = useModel(PublisherSetupModel);
  const inspectDisabled = useComputed(() => !model.canInspect.value);
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

  return (
    <div>
      <SettingsCardHeader title="Prepare a release workflow" />
      <SettingsCardBody inset="belowHeader">
        <Muted class="m-0 text-[13px] max-w-[680px]">
          Inspect your publishing workflow, review a proposed change, and open a draft pull request.
          GitHub environment configuration stays under your control.
        </Muted>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Installation" for="publisherSetupInstallation">
            <Select
              id="publisherSetupInstallation"
              value={model.installationRowId}
              disabled={model.busy}
              onChange={(value) => void model.selectInstallation(value)}
            >
              <option value="">Choose an installation…</option>
              {availableInstallations.value.map((installation) => (
                <option key={installation.id} value={installation.id}>
                  {installation.accountLogin}
                </option>
              ))}
            </Select>
          </Field>
          <RepositoryField model={model} />
        </div>
        <Show when={model.repositoryError}>
          {(message) => <Alert tone="critical">{message}</Alert>}
        </Show>
        <div class="flex flex-wrap items-center gap-3">
          <Button disabled={inspectDisabled} onClick={() => void model.inspect()}>
            <Show when={() => model.operation.value === "inspecting"} fallback="Inspect workflow">
              Inspecting…
            </Show>
          </Button>
          <Show when={model.loadingRepositories}>
            <Muted class="m-0 font-mono text-[12px]">Loading repositories…</Muted>
          </Show>
        </div>
        <Show when={model.inspection}>
          <DraftFields model={model} />
        </Show>
        <Show when={model.error}>{(message) => <Alert tone="critical">{message}</Alert>}</Show>
        <Show when={model.draftJobId}>
          <DraftProgress model={model} />
        </Show>
        <Show when={model.draft}>
          <ProposalReview model={model} />
        </Show>
        <Show when={() => Boolean(model.repositoryFullName.value)}>
          <SetupChecks model={model} targets={targets} />
        </Show>
      </SettingsCardBody>
    </div>
  );
}

function RepositoryField({ model }: { model: SetupModel }) {
  const disabled = useComputed(
    () => model.busy.value || model.loadingRepositories.value || !model.installationRowId.value,
  );
  return (
    <Field label="Repository" for="publisherSetupRepository">
      <Select
        id="publisherSetupRepository"
        value={model.repositoryFullName}
        disabled={disabled}
        onChange={model.selectRepository}
      >
        <option value="">Choose a repository…</option>
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

function DraftFields({ model }: { model: SetupModel }) {
  const inspection = model.inspection.value!;
  const disabled = useComputed(() => !model.canDraft.value);
  return (
    <div class="flex flex-col gap-4">
      <Show when={() => model.inspection.value!.workflows.length === 0}>
        <Alert tone="warn">
          No supported workflow files were found; add a publishing workflow before preparing a
          change.
        </Alert>
      </Show>
      {inspection.warnings.map((warning) => (
        <Alert key={warning} tone="warn">
          {warning}
        </Alert>
      ))}
      <Field label="Publishing workflow" for="publisherSetupWorkflow">
        <Select
          id="publisherSetupWorkflow"
          value={model.workflowPath}
          disabled={model.busy}
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
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Package ecosystem" for="publisherSetupEcosystem">
          <Select
            id="publisherSetupEcosystem"
            value={model.ecosystem}
            disabled={model.busy}
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
            disabled={model.busy}
            maxLength={255}
            onInput={(event) => model.setEnvironment(event.currentTarget.value)}
          />
        </Field>
      </div>
      <Muted class="m-0 text-[13px] max-w-[680px]">
        Drafting sends this workflow to the configured AI model. Review the full change before
        merging; a generated workflow does not establish that your release is protected.
      </Muted>
      <div>
        <Button disabled={disabled} onClick={() => void model.draftWorkflow()}>
          <Show when={() => model.operation.value === "drafting"} fallback="Draft workflow change">
            Drafting workflow…
          </Show>
        </Button>
      </div>
    </div>
  );
}

function ProposalReview({ model }: { model: SetupModel }) {
  const draft = model.draft.value!;
  const original = model.inspection.value?.workflows.find(
    (workflow) => workflow.path === draft.proposal.workflowPath,
  );
  const disabled = useComputed(() => !model.canCreatePullRequest.value);
  return (
    <div class="flex flex-col gap-4">
      <h4 class="m-0 text-[16px] font-medium">Review the proposed change</h4>
      <Muted class="m-0 text-[13px] max-w-[680px]">{draft.proposal.summary}</Muted>
      <DiffView
        path={draft.proposal.workflowPath}
        status="modified"
        before={{ textSample: model.originalContent.value ?? original?.content ?? "" }}
        after={{ textSample: draft.proposal.content }}
        beforeLabel="Current workflow"
        afterLabel="Proposed workflow"
      />
      <ol class="m-0 pl-5 flex flex-col gap-2 text-[13px] leading-[1.55]">
        {draft.proposal.manualSteps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <label class="flex items-start gap-2 text-[13px] leading-[1.55]">
        <input
          type="checkbox"
          checked={model.reviewed}
          disabled={model.busy}
          onChange={(event) => model.setReviewed(event.currentTarget.checked)}
          class="mt-0.5 accent-accent"
        />
        <span>I reviewed the workflow changes and the remaining configuration steps.</span>
      </label>
      <div class="flex flex-wrap items-center gap-3">
        <CopyButton text={draft.proposal.content} label="Copy proposed workflow" />
        <Button disabled={disabled} onClick={() => void model.createPullRequest()}>
          <Show
            when={() => model.operation.value === "creating-pr"}
            fallback="Create draft pull request"
          >
            Creating pull request…
          </Show>
        </Button>
        <Show when={model.pullRequest}>
          {(pullRequest) => (
            <LinkButton
              href={pullRequest.url}
              target="_blank"
              rel="noopener noreferrer"
              variant="secondary"
            >
              Open pull request #{pullRequest.number}
            </LinkButton>
          )}
        </Show>
      </div>
      <Show when={model.pullRequest}>
        <Alert tone="info">
          The pull request is a draft; review and merge it in GitHub, then finish the environment
          configuration below.
        </Alert>
      </Show>
    </div>
  );
}

const DRAFT_STAGE_LABELS: Record<PublisherSetupJobStage, string> = {
  queued: "Waiting for the draft to start…",
  fetch_source: "Reading the pinned workflow…",
  draft: "Drafting the workflow change…",
  validate: "Checking the proposed workflow structure…",
  judge: "Running a second review of the change…",
  ready: "Draft ready for your review.",
};

function DraftProgress({ model }: { model: SetupModel }) {
  const job = model.draftJob.value;
  const judge = job?.judge;
  const progress = useComputed(() => {
    const current = model.draftJob.value;
    if (!current) return "Restoring draft status…";
    if (current.status === "failed") return "Draft needs another attempt.";
    return DRAFT_STAGE_LABELS[current.stage];
  });
  return (
    <div class="flex flex-col gap-3">
      <div aria-live="polite">
        <Muted class="m-0 font-mono text-[12px]">{progress}</Muted>
      </div>
      <Show when={model.draftPending}>
        <Muted class="m-0 text-[13px] max-w-[680px]">
          The draft runs in the background. You can change your selection or return to this page
          while it completes.
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
      {judge ? (
        <div class="flex flex-col gap-2">
          <h4 class="m-0 text-[14px] font-medium">Second review · advisory</h4>
          <Muted class="m-0 text-[13px] max-w-[680px]">{judge.summary}</Muted>
          <ul class="m-0 pl-5 text-[13px] leading-[1.55]">
            {judge.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
          <Muted class="m-0 text-[12px]">
            {judge.verdict === "pass"
              ? "No changes requested by the second reviewer; your review is still required."
              : "Changes requested; this attempt cannot create a pull request."}
          </Muted>
        </div>
      ) : null}
      <Show when={model.draftPending}>
        <div>
          <Button variant="ghost" onClick={model.discardDraft}>
            Discard this draft
          </Button>
        </div>
      </Show>
    </div>
  );
}

function SetupChecks({
  model,
  targets,
}: {
  model: SetupModel;
  targets: InstanceType<typeof ReleaseTargetsModel>;
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
      <h4 class="m-0 text-[16px] font-medium">Finish setup and verify a release</h4>
      <Muted class="m-0 text-[13px] max-w-[680px]">
        Configure the named GitHub environment with the Drydock deployment protection rule, map the
        release target, and run your publishing workflow. Only the configured publish job is held.
      </Muted>
      <div class="flex flex-wrap items-center gap-3">
        <LinkButton
          href={settingsUrl}
          target="_blank"
          rel="noopener noreferrer"
          variant="secondary"
        >
          Open GitHub environments
        </LinkButton>
        <Button disabled={disabled} variant="secondary" onClick={() => void model.checkStatus()}>
          <Show when={() => model.operation.value === "checking"} fallback="Check setup status">
            Checking setup…
          </Show>
        </Button>
      </div>
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
      <ul class="m-0 p-0 list-none divide-y divide-border">
        {status.checks.map((check) => (
          <li key={check.label} class="py-3 flex flex-col gap-1.5">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="text-[13px] font-medium">{check.label}</span>
              <Badge tone={check.status === "passed" ? "ok" : "neutral"}>{check.status}</Badge>
            </div>
            <Muted class="m-0 text-[13px]">{check.detail}</Muted>
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
