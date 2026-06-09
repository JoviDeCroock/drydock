import { computed, createModel, signal } from "@preact/signals";
import { ApiError, apiFetch, apiJson, errorMessage } from "./api";

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

export type SupportedEcosystem = "pypi" | "npm";

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

export type WorkflowGateStatus = "pending" | "approved" | "rejected" | "errored";
export type WorkflowGateDecision = "approved" | "rejected";
export type GatePackageDecision = "publish" | "no_publish";

// One entry per distinct package the gated release publishes. A monorepo fans
// out into several; the gate releases only once every package is approved.
export interface GatePackageScan {
  scanId: string;
  packageName: string | null;
  version: string | null;
  status: string;
  releaseRisk: string | null;
  decision: GatePackageDecision | null;
}

export interface PublicWorkflowGate {
  id: string;
  organizationId: string;
  releaseTargetId: string;
  repositoryFullName: string;
  environment: string;
  runId: number;
  status: WorkflowGateStatus;
  decision: WorkflowGateDecision | null;
  decisionComment: string | null;
  reportUrl: string | null;
  scanId: string | null;
  failureReason: string | null;
  packages: GatePackageScan[];
  requestedAt: string;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Returns null when no gate is mapped to the scan (404) so callers can treat a
// plain manual/auto-discovery scan and a not-yet-loaded gate the same way.
export async function getWorkflowGateByScan(scanId: string): Promise<PublicWorkflowGate | null> {
  try {
    const data = await apiFetch<{ gate: PublicWorkflowGate }>(
      `/api/v1/github-app/workflow-gates/by-scan/${encodeURIComponent(scanId)}`,
    );
    return data.gate;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

// Records a decision for a single package of the gate (`scanId`). The gate only
// finalizes — releasing or blocking the held GitHub job — once every package is
// approved, or the moment any one is rejected.
export function decideWorkflowGate(
  gateId: string,
  scanId: string,
  decision: WorkflowGateDecision,
  comment: string | null,
  totpCode?: string | null,
): Promise<{ gate: PublicWorkflowGate }> {
  const payload: {
    scanId: string;
    decision: WorkflowGateDecision;
    comment?: string;
    totpCode?: string;
  } = { scanId, decision };
  if (comment) payload.comment = comment;
  if (totpCode) payload.totpCode = totpCode;
  return apiJson<{ gate: PublicWorkflowGate }>(
    `/api/v1/github-app/workflow-gates/${encodeURIComponent(gateId)}/decision`,
    payload,
  ).catch((err) => {
    if (err instanceof ApiError && err.status === 401) {
      if (err.code === "two_factor_required") {
        throw new ApiError(
          "Enter your authentication code to decide this gate.",
          401,
          err.detail,
          err.code,
        );
      }
      if (err.code === "two_factor_invalid") {
        throw new ApiError("That authentication code is invalid.", 401, err.detail, err.code);
      }
    }
    throw err;
  });
}

export function retryWorkflowGate(gateId: string): Promise<{ gate: PublicWorkflowGate }> {
  return apiJson<{ gate: PublicWorkflowGate }>(
    `/api/v1/github-app/workflow-gates/${encodeURIComponent(gateId)}/retry`,
    {},
  );
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

  const repositoryCache = signal<Record<string, InstallationRepository[]>>({});
  const repositoryStatus = signal<Record<string, RepositoryListStatus>>({});
  const repositoryErrors = signal<Record<string, string>>({});

  const environmentCache = signal<Record<string, RepositoryEnvironment[]>>({});
  const environmentStatus = signal<Record<string, EnvironmentListStatus>>({});
  const environmentErrors = signal<Record<string, string>>({});

  const busy = computed(() => status.value !== "idle");
  const notConfigured = computed(() => config.value?.configured === false);
  const loaded = computed(
    () => configLoaded.value && installationsLoaded.value && releaseTargetsLoaded.value,
  );
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
