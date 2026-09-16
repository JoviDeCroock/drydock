import { useEffect } from "preact/hooks";
import { useModel } from "@preact/signals";
import type { PublicGithubAppInstallation } from "../../../models/github-app";
import { ReleaseTargetsModel } from "../../../models/release-targets";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { SettingsCardForm } from "../../../components/Card";
import { Field } from "../../../components/Field";
import { Select } from "../../../components/Select";
import { Muted } from "../../../components/Typography";

type ReleaseTargets = ReturnType<typeof useModel<typeof ReleaseTargetsModel.prototype>>;

export function ReleaseTargetForm({
  targets,
  activeInstallations,
}: {
  targets: ReleaseTargets;
  activeInstallations: PublicGithubAppInstallation[];
}) {
  const installationRowId = targets.formInstallationRowId.value;
  const formError = targets.formError.value;
  const submitting = targets.formSubmitting.value;
  const formValid = targets.formValid.value;

  // Always default to the first active installation; the picker is intentionally
  // not surfaced, so keep the selected installation pinned to the one we have.
  const installationIds = activeInstallations.map((row) => row.id).join(",");
  useEffect(() => {
    const stillValid = activeInstallations.some((row) => row.id === installationRowId);
    if (!stillValid && activeInstallations.length) {
      targets.selectInstallation(activeInstallations[0].id);
    }
  }, [installationIds, installationRowId]);

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    await targets.createReleaseTarget();
  };

  return (
    <SettingsCardForm onSubmit={onSubmit}>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <RepositorySelector targets={targets} />
        <EnvironmentSelector targets={targets} />
      </div>

      {formError ? <Alert tone="critical">{formError}</Alert> : null}

      <div class="flex items-center gap-3">
        <Button type="submit" disabled={submitting || !formValid}>
          {submitting ? "Mapping…" : "Map release target"}
        </Button>
      </div>
    </SettingsCardForm>
  );
}

function RepositorySelector({ targets }: { targets: ReleaseTargets }) {
  const installationRowId = targets.formInstallationRowId.value;
  const repositoryFullName = targets.formRepositoryFullName.value;
  const submitting = targets.formSubmitting.value;
  const repositories = targets.availableRepositories.value;
  const accessibleCount = targets.activeRepositories.value.length;
  const repositoryStatus = targets.activeRepositoryStatus.value;
  const repositoryError = targets.activeRepositoryError.value;
  // Repositories disappear from the picker once they have a release target, so
  // an empty list with accessible repos behind it means every one is mapped.
  const allMapped = accessibleCount > 0 && repositories.length === 0;

  return (
    <Field label="Repository" for="releaseTargetRepo">
      <Select
        id="releaseTargetRepo"
        value={repositoryFullName}
        disabled={submitting || !installationRowId || repositoryStatus === "loading"}
        onChange={(value) => targets.selectRepository(value)}
      >
        <option value="">
          {!installationRowId
            ? "Pick an installation first…"
            : repositoryStatus === "loading"
              ? "Loading repositories…"
              : repositories.length
                ? "Pick a repository…"
                : allMapped
                  ? "All repositories already mapped"
                  : "No repositories visible"}
        </option>
        {repositories.map((repo: { id: number; fullName: string }) => (
          <option key={repo.id} value={repo.fullName}>
            {repo.fullName}
          </option>
        ))}
      </Select>
      {repositoryError ? (
        <Muted tone="danger" class="text-[12px] mt-1.5">
          {repositoryError}
        </Muted>
      ) : null}
      {installationRowId && !repositoryError && repositoryStatus === "idle" && allMapped ? (
        <Muted class="text-[12px] mt-1.5">
          Every repository this installation can see already has a release target. Remove one below
          to remap it, or grant the GitHub App access to another repository.
        </Muted>
      ) : null}
      {installationRowId &&
      !repositoryError &&
      repositoryStatus === "idle" &&
      accessibleCount === 0 ? (
        <Muted class="text-[12px] mt-1.5">
          This installation has no accessible repositories. Grant the GitHub App access to a
          repository in{" "}
          <a
            class="underline"
            href="https://github.com/settings/installations"
            target="_blank"
            rel="noreferrer"
          >
            GitHub App settings
          </a>{" "}
          and refresh.
        </Muted>
      ) : null}
    </Field>
  );
}

function EnvironmentSelector({ targets }: { targets: ReleaseTargets }) {
  const repositoryFullName = targets.formRepositoryFullName.value;
  const environment = targets.formEnvironment.value;
  const submitting = targets.formSubmitting.value;
  const environments = targets.activeEnvironments.value;
  const environmentStatus = targets.activeEnvironmentStatus.value;
  const environmentError = targets.activeEnvironmentError.value;

  return (
    <Field label="GitHub environment" for="releaseTargetEnv">
      <Select
        id="releaseTargetEnv"
        value={environment}
        disabled={submitting || !repositoryFullName || environmentStatus === "loading"}
        onChange={(value) => targets.selectEnvironment(value)}
      >
        <option value="">
          {!repositoryFullName
            ? "Pick a repository first…"
            : environmentStatus === "loading"
              ? "Loading environments…"
              : environments.length
                ? "Pick an environment…"
                : "No environments configured"}
        </option>
        {environments.map((env: { name: string }) => (
          <option key={env.name} value={env.name}>
            {env.name}
          </option>
        ))}
      </Select>
      {environmentError ? (
        <Muted tone="danger" class="text-[12px] mt-1.5">
          {environmentError}
        </Muted>
      ) : null}
      {repositoryFullName &&
      !environmentError &&
      environmentStatus === "idle" &&
      !environments.length ? (
        <Muted class="text-[12px] mt-1.5">
          No environments on this repo yet. Create one in{" "}
          <a
            class="underline"
            href="https://docs.github.com/en/actions/deployment/targeting-different-environments/managing-environments-for-deployment"
            target="_blank"
            rel="noreferrer"
          >
            GitHub Actions environments
          </a>
          , then refresh.
        </Muted>
      ) : null}
    </Field>
  );
}
