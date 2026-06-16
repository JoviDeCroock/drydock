import { useEffect } from "preact/hooks";
import { useModel } from "@preact/signals";
import { GithubAppModel, type PublicGithubAppInstallation } from "../../../models/github-app";
import { Alert, Button, Field, Muted, Select, SettingsCardForm } from "../../../components";

type GithubApp = ReturnType<typeof useModel<typeof GithubAppModel.prototype>>;

export function ReleaseTargetForm({
  githubApp,
  activeInstallations,
}: {
  githubApp: GithubApp;
  activeInstallations: PublicGithubAppInstallation[];
}) {
  const installationRowId = githubApp.formInstallationRowId.value;
  const formError = githubApp.formError.value;
  const submitting = githubApp.formSubmitting.value;
  const formValid = githubApp.formValid.value;

  // Always default to the first active installation; the picker is intentionally
  // not surfaced, so keep the selected installation pinned to the one we have.
  const installationIds = activeInstallations.map((row) => row.id).join(",");
  useEffect(() => {
    const stillValid = activeInstallations.some((row) => row.id === installationRowId);
    if (!stillValid && activeInstallations.length) {
      githubApp.selectInstallation(activeInstallations[0].id);
    }
  }, [installationIds, installationRowId]);

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    await githubApp.createReleaseTarget();
  };

  return (
    <SettingsCardForm onSubmit={onSubmit}>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <RepositorySelector githubApp={githubApp} />
        <EnvironmentSelector githubApp={githubApp} />
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

function RepositorySelector({ githubApp }: { githubApp: GithubApp }) {
  const installationRowId = githubApp.formInstallationRowId.value;
  const repositoryFullName = githubApp.formRepositoryFullName.value;
  const submitting = githubApp.formSubmitting.value;
  const repositories = githubApp.availableRepositories.value;
  const accessibleCount = githubApp.activeRepositories.value.length;
  const repositoryStatus = githubApp.activeRepositoryStatus.value;
  const repositoryError = githubApp.activeRepositoryError.value;
  // Repositories disappear from the picker once they have a release target, so
  // an empty list with accessible repos behind it means every one is mapped.
  const allMapped = accessibleCount > 0 && repositories.length === 0;

  return (
    <Field label="Repository" for="releaseTargetRepo">
      <Select
        id="releaseTargetRepo"
        value={repositoryFullName}
        disabled={submitting || !installationRowId || repositoryStatus === "loading"}
        onChange={(value) => githubApp.selectRepository(value)}
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
        <Muted class="text-[12px] mt-1.5 text-danger-text">{repositoryError}</Muted>
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

function EnvironmentSelector({ githubApp }: { githubApp: GithubApp }) {
  const repositoryFullName = githubApp.formRepositoryFullName.value;
  const environment = githubApp.formEnvironment.value;
  const submitting = githubApp.formSubmitting.value;
  const environments = githubApp.activeEnvironments.value;
  const environmentStatus = githubApp.activeEnvironmentStatus.value;
  const environmentError = githubApp.activeEnvironmentError.value;

  return (
    <Field label="GitHub environment" for="releaseTargetEnv">
      <Select
        id="releaseTargetEnv"
        value={environment}
        disabled={submitting || !repositoryFullName || environmentStatus === "loading"}
        onChange={(value) => githubApp.selectEnvironment(value)}
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
        <Muted class="text-[12px] mt-1.5 text-danger-text">{environmentError}</Muted>
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
