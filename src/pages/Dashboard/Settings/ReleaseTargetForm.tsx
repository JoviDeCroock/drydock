import { useModel } from "@preact/signals";
import { GithubAppModel, type PublicGithubAppInstallation } from "../../../models/github-app";
import { Alert, Button, Field, Input, Muted, Select } from "../../../components";

type GithubApp = ReturnType<typeof useModel<typeof GithubAppModel.prototype>>;

export function ReleaseTargetForm({
  githubApp,
  activeInstallations,
}: {
  githubApp: GithubApp;
  activeInstallations: PublicGithubAppInstallation[];
}) {
  const installationRowId = githubApp.formInstallationRowId.value;
  const packageName = githubApp.formPackageName.value;
  const environment = githubApp.formEnvironment.value;
  const trustedPublisherEnv = githubApp.formPypiTrustedPublisherEnvironment.value;
  const workflowFilename = githubApp.formWorkflowFilename.value;
  const formError = githubApp.formError.value;
  const submitting = githubApp.formSubmitting.value;
  const formValid = githubApp.formValid.value;

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    await githubApp.createReleaseTarget();
  };

  const trustedPublisherDiffers =
    environment.trim().toLowerCase() !== trustedPublisherEnv.trim().toLowerCase() &&
    trustedPublisherEnv.trim() !== "";

  return (
    <form class="px-5 pb-5 flex flex-col gap-4" onSubmit={onSubmit}>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Installation" for="releaseTargetInstallation">
          <Select
            id="releaseTargetInstallation"
            value={installationRowId}
            disabled={submitting}
            onChange={(value) => githubApp.selectInstallation(value)}
          >
            <option value="">Pick an installation…</option>
            {activeInstallations.map((row) => (
              <option key={row.id} value={row.id}>
                {row.accountLogin} · installation {row.installationId}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="PyPI package name" for="releaseTargetPackage">
          <Input
            id="releaseTargetPackage"
            type="text"
            value={packageName}
            placeholder="example-package"
            onInput={(e) =>
              (githubApp.formPackageName.value = (e.target as HTMLInputElement).value)
            }
            disabled={submitting}
            autoComplete="off"
            spellcheck={false}
          />
        </Field>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <RepositorySelector githubApp={githubApp} />
        <EnvironmentSelector githubApp={githubApp} />
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="PyPI Trusted Publisher environment" for="releaseTargetTrustedPublisher">
          <Input
            id="releaseTargetTrustedPublisher"
            type="text"
            value={trustedPublisherEnv}
            placeholder="Defaults to the GitHub environment"
            onInput={(e) =>
              githubApp.setPypiTrustedPublisherEnvironment((e.target as HTMLInputElement).value)
            }
            disabled={submitting || !environment}
            autoComplete="off"
            spellcheck={false}
          />
          <Muted class="text-[12px] mt-1.5 m-0">
            Defaults to the GitHub environment so the gate runs against the same job as the Trusted
            Publisher exchange. Edit only if you renamed the publisher environment.
          </Muted>
          {trustedPublisherDiffers ? (
            <Muted class="text-[12px] mt-1.5 text-danger">
              Must match the GitHub environment exactly.
            </Muted>
          ) : null}
        </Field>
        <Field label="Workflow filename (optional)" for="releaseTargetWorkflow">
          <Input
            id="releaseTargetWorkflow"
            type="text"
            value={workflowFilename}
            placeholder="release.yml"
            onInput={(e) =>
              (githubApp.formWorkflowFilename.value = (e.target as HTMLInputElement).value)
            }
            disabled={submitting}
            autoComplete="off"
            spellcheck={false}
          />
        </Field>
      </div>

      {formError ? <Alert tone="critical">{formError}</Alert> : null}

      <div class="flex items-center gap-3">
        <Button type="submit" disabled={submitting || !formValid}>
          {submitting ? "Mapping…" : "Map release target"}
        </Button>
        <Muted class="text-[12px] m-0">
          Drydock revalidates installation, repo access, and environment names before saving.
        </Muted>
      </div>
    </form>
  );
}

function RepositorySelector({ githubApp }: { githubApp: GithubApp }) {
  const installationRowId = githubApp.formInstallationRowId.value;
  const repositoryFullName = githubApp.formRepositoryFullName.value;
  const submitting = githubApp.formSubmitting.value;
  const repositories = githubApp.activeRepositories.value;
  const repositoryStatus = githubApp.activeRepositoryStatus.value;
  const repositoryError = githubApp.activeRepositoryError.value;

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
                : "No repositories visible"}
        </option>
        {repositories.map((repo: { id: number; fullName: string }) => (
          <option key={repo.id} value={repo.fullName}>
            {repo.fullName}
          </option>
        ))}
      </Select>
      {repositoryError ? (
        <Muted class="text-[12px] mt-1.5 text-danger">{repositoryError}</Muted>
      ) : null}
      {installationRowId &&
      !repositoryError &&
      repositoryStatus === "idle" &&
      !repositories.length ? (
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
        <Muted class="text-[12px] mt-1.5 text-danger">{environmentError}</Muted>
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
