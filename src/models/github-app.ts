import { computed, createModel, signal } from "@preact/signals";
import { ApiError, apiFetch, apiJson, errorMessage } from "./api";
import { busySignal, runAction } from "./async-action";
import { createKeyedCache } from "./keyed-cache";

export type InstallationStatus = "active" | "suspended" | "uninstalled";

export interface PublicGithubAppInstallation {
  id: string;
  organizationId: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  targetType: string;
  status: InstallationStatus;
  installedAt: string;
  createdAt: string;
  updatedAt: string;
}

export type SupportedEcosystem = "pypi" | "npm" | "vscode";

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

export interface GithubAppConfigState {
  configured: boolean;
  appSlug?: string;
}

export type GithubAppInstallStatus = "idle" | "starting" | "completing" | "loading";

export type GithubAppCallbackErrorCode =
  | "github_app_not_configured"
  | "installation_missing"
  | "installation_inactive"
  | "installation_not_authorized"
  | "invalid_input"
  | "state_invalid"
  | "state_org_mismatch"
  | "state_user_mismatch"
  | "installation_not_active"
  | "unknown";

export interface CallbackError {
  code: GithubAppCallbackErrorCode;
  message: string;
}

export interface CallbackQuery {
  state: string;
  code: string;
  installationId: string;
  setupAction: string;
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

export const GithubAppModel = createModel(() => {
  const config = signal<GithubAppConfigState | null>(null);
  const installations = signal<PublicGithubAppInstallation[]>([]);
  const status = signal<GithubAppInstallStatus>("idle");
  const error = signal<string | null>(null);
  const callbackError = signal<CallbackError | null>(null);
  const lastLinked = signal<PublicGithubAppInstallation | null>(null);
  const configLoaded = signal(false);
  const installationsLoaded = signal(false);

  const releaseTargets = signal<PublicReleaseTarget[]>([]);
  const releaseTargetsLoaded = signal(false);
  const releaseTargetsError = signal<string | null>(null);

  const formInstallationRowId = signal<string>("");
  const formRepositoryFullName = signal<string>("");
  const formEnvironment = signal<string>("");
  const formStatus = signal<ReleaseTargetFormStatus>("idle");
  const formError = signal<string | null>(null);

  const repositoryCache = createKeyedCache<InstallationRepository, RepositoryListStatus>({
    idle: "idle",
    loading: "loading",
    error: "error",
  });

  const environmentCache = createKeyedCache<RepositoryEnvironment, EnvironmentListStatus>({
    idle: "idle",
    loading: "loading",
    error: "error",
  });

  const busy = busySignal(status);
  const notConfigured = computed(() => config.value?.configured === false);
  const loaded = computed(
    () => configLoaded.value && installationsLoaded.value && releaseTargetsLoaded.value,
  );
  const formSubmitting = computed(() => formStatus.value === "submitting");

  const activeRepositories = computed<InstallationRepository[]>(() =>
    repositoryCache.valueFor(formInstallationRowId.value),
  );
  const activeRepositoryStatus = computed<RepositoryListStatus>(() =>
    repositoryCache.statusFor(formInstallationRowId.value),
  );
  const activeRepositoryError = computed<string | null>(() =>
    repositoryCache.errorFor(formInstallationRowId.value),
  );
  const availableRepositories = computed<InstallationRepository[]>(() =>
    selectUnmappedRepositories(activeRepositories.value, releaseTargets.value),
  );

  const environmentCacheKey = computed<string>(() => {
    const installationId = formInstallationRowId.value;
    const repo = formRepositoryFullName.value;
    return installationId && repo ? `${installationId}::${repo}` : "";
  });
  const activeEnvironments = computed<RepositoryEnvironment[]>(() =>
    environmentCache.valueFor(environmentCacheKey.value),
  );
  const activeEnvironmentStatus = computed<EnvironmentListStatus>(() =>
    environmentCache.statusFor(environmentCacheKey.value),
  );
  const activeEnvironmentError = computed<string | null>(() =>
    environmentCache.errorFor(environmentCacheKey.value),
  );

  const formValid = computed(
    () =>
      formInstallationRowId.value.trim() !== "" &&
      formRepositoryFullName.value.trim() !== "" &&
      formEnvironment.value.trim() !== "",
  );

  function clearForm() {
    formInstallationRowId.value = "";
    formRepositoryFullName.value = "";
    formEnvironment.value = "";
    formError.value = null;
  }

  return {
    config,
    installations,
    status,
    error,
    callbackError,
    lastLinked,
    configLoaded,
    installationsLoaded,
    busy,
    notConfigured,
    loaded,

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

    async loadConfig(): Promise<void> {
      try {
        const data = await apiFetch<GithubAppConfigState>("/api/v1/github-app/config");
        config.value = data;
      } catch (err) {
        error.value = errorMessage(err);
        config.value = { configured: false };
      } finally {
        configLoaded.value = true;
      }
    },

    async loadInstallations(): Promise<void> {
      try {
        const data = await apiFetch<{ installations: PublicGithubAppInstallation[] }>(
          "/api/v1/github-app/installations",
        );
        installations.value = data.installations;
      } catch (err) {
        error.value = errorMessage(err);
        installations.value = [];
      } finally {
        installationsLoaded.value = true;
      }
    },

    async loadReleaseTargets(): Promise<void> {
      try {
        const data = await apiFetch<{ releaseTargets: PublicReleaseTarget[] }>(
          "/api/v1/github-app/release-targets",
        );
        releaseTargets.value = data.releaseTargets;
        releaseTargetsError.value = null;
      } catch (err) {
        releaseTargetsError.value = errorMessage(err);
        releaseTargets.value = [];
      } finally {
        releaseTargetsLoaded.value = true;
      }
    },

    async loadInstallationRepositories(
      installationRowId: string,
      { force = false }: { force?: boolean } = {},
    ): Promise<void> {
      if (!installationRowId) return;
      await repositoryCache.load(
        installationRowId,
        async () => {
          const data = await apiFetch<{ repositories: InstallationRepository[] }>(
            `/api/v1/github-app/installations/${encodeURIComponent(installationRowId)}/repositories`,
          );
          return data.repositories;
        },
        { force },
      );
    },

    async loadRepositoryEnvironments(
      installationRowId: string,
      repositoryFullName: string,
      { force = false }: { force?: boolean } = {},
    ): Promise<void> {
      if (!installationRowId || !repositoryFullName) return;
      const key = `${installationRowId}::${repositoryFullName}`;
      if (!force && environmentCache.values.peek()[key]) return;
      const [owner, repo] = repositoryFullName.split("/", 2);
      if (!owner || !repo) {
        environmentCache.setError(key, "repository must be in owner/repo form");
        environmentCache.setStatus(key, "error");
        return;
      }
      await environmentCache.load(
        key,
        async () => {
          const data = await apiFetch<{ environments: RepositoryEnvironment[] }>(
            `/api/v1/github-app/installations/${encodeURIComponent(installationRowId)}/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/environments`,
          );
          return data.environments;
        },
        { force },
      );
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
      return (
        (await runAction({
          status: formStatus,
          error: formError,
          pending: "submitting",
          run: async () => {
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
          },
        })) ?? null
      );
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

    async startInstall(): Promise<void> {
      status.value = "starting";
      error.value = null;
      try {
        const data = await apiJson<{
          installUrl: string;
          state: string;
          expiresInSeconds: number;
        }>("/api/v1/github-app/install", {});
        window.location.assign(data.installUrl);
      } catch (err) {
        if (err instanceof ApiError && err.code === "github_app_not_configured") {
          config.value = { configured: false };
          error.value =
            "GitHub App is not configured yet on this Drydock instance. Ask the operator to add the GitHub App secrets.";
        } else {
          error.value = errorMessage(err);
        }
        status.value = "idle";
      }
    },

    async completeInstall(query: CallbackQuery): Promise<PublicGithubAppInstallation | null> {
      status.value = "completing";
      callbackError.value = null;
      error.value = null;
      lastLinked.value = null;
      try {
        const data = await apiJson<{ installation: PublicGithubAppInstallation }>(
          "/api/v1/github-app/install/callback",
          query,
        );
        lastLinked.value = data.installation;
        const existing = installations.peek();
        installations.value = [
          data.installation,
          ...existing.filter((row) => row.id !== data.installation.id),
        ];
        return data.installation;
      } catch (err) {
        callbackError.value = mapCallbackError(err);
        return null;
      } finally {
        status.value = "idle";
      }
    },

    reset() {
      error.value = null;
      callbackError.value = null;
      lastLinked.value = null;
    },
  };
});

function mapCallbackError(err: unknown): CallbackError {
  if (err instanceof ApiError) {
    if (err.code === "github_app_not_configured") {
      return {
        code: "github_app_not_configured",
        message:
          "GitHub App is not configured yet on this Drydock instance. Ask the operator to add the GitHub App secrets.",
      };
    }
    if (err.code) {
      return { code: err.code as GithubAppCallbackErrorCode, message: err.message };
    }
    if (err.status === 400 && /state token/i.test(err.message)) {
      return { code: "state_invalid", message: err.message };
    }
    if (err.status === 403 && /organization/i.test(err.message)) {
      return { code: "state_org_mismatch", message: err.message };
    }
    if (err.status === 403 && /user/i.test(err.message)) {
      return { code: "state_user_mismatch", message: err.message };
    }
    if (err.status === 409) {
      return { code: "installation_not_active", message: err.message };
    }
    return { code: "unknown", message: err.message };
  }
  return { code: "unknown", message: errorMessage(err) };
}
