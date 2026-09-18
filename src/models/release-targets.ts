/**
 * Release targets: which (installation, repository, environment) triples gate
 * a GitHub Actions publish job, plus the form that maps a new one and the
 * per-installation repository and environment lists it picks from. Kept apart
 * from `GithubAppModel` (config, installations, the install flow) because the
 * form only ever needs the active installation ids, which arrive as a prop.
 */
import { computed, createModel, signal } from "@preact/signals";
import { apiFetch, apiJson, errorMessage } from "./api";

type SupportedEcosystem = "pypi" | "npm" | "vscode";

export interface PublicReleaseTarget {
  id: string;
  organizationId: string;
  installationRowId: string;
  // null = auto-detect each package's ecosystem from the uploaded artifacts
  // (the monorepo-friendly default).
  ecosystem: SupportedEcosystem | null;
  // null = inspect every non-expired workflow artifact; non-null narrows to one
  // GitHub Actions artifact name.
  artifactName: string | null;
  repositoryId: number;
  repositoryFullName: string;
  environment: string;
  createdAt: string;
  updatedAt: string;
}

export interface InstallationRepository {
  id: number;
  fullName: string;
  defaultBranch: string | null;
}

export interface RepositoryEnvironment {
  name: string;
}

export type ReleaseTargetFormStatus = "idle" | "submitting";
export type RepositoryListStatus = "idle" | "loading" | "error";
export type EnvironmentListStatus = "idle" | "loading" | "error";

// A release target is unique per (org, repositoryId, environment). The picker
// already scopes to the org, so a repository that already has any release
// target is dropped from the options to keep the user from re-submitting a
// duplicate.
export function selectUnmappedRepositories(
  repositories: InstallationRepository[],
  releaseTargets: Pick<PublicReleaseTarget, "repositoryId">[],
): InstallationRepository[] {
  if (!releaseTargets.length) return repositories;
  const mapped = new Set(releaseTargets.map((target) => target.repositoryId));
  return repositories.filter((repo) => !mapped.has(repo.id));
}

export const ReleaseTargetsModel = createModel(() => {
  // Settings reloads release targets on every organization switch. A slower
  // response from the previous organization must not land on top of the new
  // one, so the loader only commits the newest call.
  let releaseTargetsRequestId = 0;

  const releaseTargets = signal<PublicReleaseTarget[]>([]);
  const releaseTargetsLoaded = signal(false);
  const releaseTargetsError = signal<string | null>(null);

  const formInstallationRowId = signal<string>("");
  const formRepositoryFullName = signal<string>("");
  const formEnvironment = signal<string>("");
  const formStatus = signal<ReleaseTargetFormStatus>("idle");
  const formError = signal<string | null>(null);

  const repositoryCache = signal<Record<string, InstallationRepository[]>>({});
  const repositoryStatus = signal<Record<string, RepositoryListStatus>>({});
  const repositoryErrors = signal<Record<string, string>>({});

  const environmentCache = signal<Record<string, RepositoryEnvironment[]>>({});
  const environmentStatus = signal<Record<string, EnvironmentListStatus>>({});
  const environmentErrors = signal<Record<string, string>>({});

  const formSubmitting = computed(() => formStatus.value === "submitting");

  const activeRepositories = computed<InstallationRepository[]>(() => {
    const id = formInstallationRowId.value;
    const cache = repositoryCache.value;
    return id ? (cache[id] ?? []) : [];
  });
  const activeRepositoryStatus = computed<RepositoryListStatus>(() => {
    const id = formInstallationRowId.value;
    const statusMap = repositoryStatus.value;
    return id ? (statusMap[id] ?? "idle") : "idle";
  });
  const activeRepositoryError = computed<string | null>(() => {
    const id = formInstallationRowId.value;
    const errors = repositoryErrors.value;
    return id ? (errors[id] ?? null) : null;
  });
  const availableRepositories = computed<InstallationRepository[]>(() =>
    selectUnmappedRepositories(activeRepositories.value, releaseTargets.value),
  );

  const environmentCacheKey = computed<string>(() => {
    const installationId = formInstallationRowId.value;
    const repo = formRepositoryFullName.value;
    return installationId && repo ? `${installationId}::${repo}` : "";
  });
  const activeEnvironments = computed<RepositoryEnvironment[]>(() => {
    const key = environmentCacheKey.value;
    const cache = environmentCache.value;
    return key ? (cache[key] ?? []) : [];
  });
  const activeEnvironmentStatus = computed<EnvironmentListStatus>(() => {
    const key = environmentCacheKey.value;
    const statusMap = environmentStatus.value;
    return key ? (statusMap[key] ?? "idle") : "idle";
  });
  const activeEnvironmentError = computed<string | null>(() => {
    const key = environmentCacheKey.value;
    const errors = environmentErrors.value;
    return key ? (errors[key] ?? null) : null;
  });

  const formValid = computed(
    () =>
      formInstallationRowId.value.trim() !== "" &&
      formRepositoryFullName.value.trim() !== "" &&
      formEnvironment.value.trim() !== "",
  );

  function setRepositoryStatus(installationRowId: string, value: RepositoryListStatus) {
    repositoryStatus.value = { ...repositoryStatus.peek(), [installationRowId]: value };
  }

  function setRepositoryError(installationRowId: string, message: string | null) {
    const next = { ...repositoryErrors.peek() };
    if (message) next[installationRowId] = message;
    else delete next[installationRowId];
    repositoryErrors.value = next;
  }

  function setEnvironmentStatus(key: string, value: EnvironmentListStatus) {
    environmentStatus.value = { ...environmentStatus.peek(), [key]: value };
  }

  function setEnvironmentError(key: string, message: string | null) {
    const next = { ...environmentErrors.peek() };
    if (message) next[key] = message;
    else delete next[key];
    environmentErrors.value = next;
  }

  function clearForm() {
    formInstallationRowId.value = "";
    formRepositoryFullName.value = "";
    formEnvironment.value = "";
    formError.value = null;
  }

  return {
    releaseTargets,
    releaseTargetsLoaded,
    releaseTargetsError,

    formInstallationRowId,
    formRepositoryFullName,
    formEnvironment,
    formStatus,
    formError,
    formSubmitting,
    formValid,

    activeRepositories,
    activeRepositoryStatus,
    activeRepositoryError,
    availableRepositories,
    activeEnvironments,
    activeEnvironmentStatus,
    activeEnvironmentError,

    async load(): Promise<void> {
      const requestId = ++releaseTargetsRequestId;
      try {
        const data = await apiFetch<{ releaseTargets: PublicReleaseTarget[] }>(
          "/api/v1/github-app/release-targets",
        );
        if (requestId !== releaseTargetsRequestId) return;
        releaseTargets.value = data.releaseTargets;
        releaseTargetsError.value = null;
      } catch (err) {
        if (requestId !== releaseTargetsRequestId) return;
        releaseTargetsError.value = errorMessage(err);
        releaseTargets.value = [];
      } finally {
        if (requestId === releaseTargetsRequestId) releaseTargetsLoaded.value = true;
      }
    },

    async loadInstallationRepositories(
      installationRowId: string,
      { force = false }: { force?: boolean } = {},
    ): Promise<void> {
      if (!installationRowId) return;
      if (!force && repositoryCache.peek()[installationRowId]) return;
      setRepositoryStatus(installationRowId, "loading");
      setRepositoryError(installationRowId, null);
      try {
        const data = await apiFetch<{ repositories: InstallationRepository[] }>(
          `/api/v1/github-app/installations/${encodeURIComponent(installationRowId)}/repositories`,
        );
        repositoryCache.value = {
          ...repositoryCache.peek(),
          [installationRowId]: data.repositories,
        };
        setRepositoryStatus(installationRowId, "idle");
      } catch (err) {
        setRepositoryError(installationRowId, errorMessage(err));
        setRepositoryStatus(installationRowId, "error");
      }
    },

    async loadRepositoryEnvironments(
      installationRowId: string,
      repositoryFullName: string,
      { force = false }: { force?: boolean } = {},
    ): Promise<void> {
      if (!installationRowId || !repositoryFullName) return;
      const key = `${installationRowId}::${repositoryFullName}`;
      if (!force && environmentCache.peek()[key]) return;
      setEnvironmentStatus(key, "loading");
      setEnvironmentError(key, null);
      const [owner, repo] = repositoryFullName.split("/", 2);
      if (!owner || !repo) {
        setEnvironmentError(key, "repository must be in owner/repo form");
        setEnvironmentStatus(key, "error");
        return;
      }
      try {
        const data = await apiFetch<{ environments: RepositoryEnvironment[] }>(
          `/api/v1/github-app/installations/${encodeURIComponent(installationRowId)}/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/environments`,
        );
        environmentCache.value = { ...environmentCache.peek(), [key]: data.environments };
        setEnvironmentStatus(key, "idle");
      } catch (err) {
        setEnvironmentError(key, errorMessage(err));
        setEnvironmentStatus(key, "error");
      }
    },

    selectInstallation(installationRowId: string) {
      formInstallationRowId.value = installationRowId;
      formRepositoryFullName.value = "";
      formEnvironment.value = "";
      formError.value = null;
      if (installationRowId) {
        void this.loadInstallationRepositories(installationRowId);
      }
    },

    selectRepository(repositoryFullName: string) {
      formRepositoryFullName.value = repositoryFullName;
      formEnvironment.value = "";
      formError.value = null;
      const installationRowId = formInstallationRowId.value;
      if (installationRowId && repositoryFullName) {
        void this.loadRepositoryEnvironments(installationRowId, repositoryFullName);
      }
    },

    selectEnvironment(environment: string) {
      formEnvironment.value = environment;
      formError.value = null;
    },

    async createReleaseTarget(): Promise<PublicReleaseTarget | null> {
      if (formSubmitting.value) return null;
      formStatus.value = "submitting";
      formError.value = null;
      try {
        // Ecosystem and artifact name are intentionally omitted: the server
        // treats both as auto-detect (null), deriving each package's ecosystem
        // from the uploaded artifacts and scanning every artifact the held run
        // uploads — the monorepo-friendly default, now the only behavior.
        const payload: Record<string, string> = {
          installationRowId: formInstallationRowId.value.trim(),
          repositoryFullName: formRepositoryFullName.value.trim(),
          environment: formEnvironment.value.trim(),
        };
        const data = await apiJson<{ releaseTarget: PublicReleaseTarget }>(
          "/api/v1/github-app/release-targets",
          payload,
        );
        const next = [
          data.releaseTarget,
          ...releaseTargets.peek().filter((row) => row.id !== data.releaseTarget.id),
        ];
        releaseTargets.value = next;
        clearForm();
        return data.releaseTarget;
      } catch (err) {
        formError.value = errorMessage(err);
        return null;
      } finally {
        formStatus.value = "idle";
      }
    },

    async deleteReleaseTarget(id: string): Promise<boolean> {
      try {
        await apiFetch<{ ok: true }>(
          `/api/v1/github-app/release-targets/${encodeURIComponent(id)}`,
          { method: "DELETE" },
        );
        releaseTargets.value = releaseTargets.peek().filter((row) => row.id !== id);
        return true;
      } catch (err) {
        releaseTargetsError.value = errorMessage(err);
        return false;
      }
    },

    clearForm,
  };
});
