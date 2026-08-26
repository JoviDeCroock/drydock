import { computed, createModel, signal } from "@preact/signals";
import { apiFetch, apiJson, errorMessage } from "./api";
import type {
  InstallationRepository,
  PublicReleaseTarget,
  RepositoryEnvironment,
} from "./github-app";
import { ECOSYSTEM_LABELS } from "../../server/lib/ecosystems/labels";
import {
  GATE_SETUP_ENVIRONMENT_NAME_RE,
  GATE_SETUP_PACKAGE_NAME_RE,
} from "../../server/lib/github-app/validation";

/**
 * State for the guided workflow-gate setup wizard.
 *
 * Deliberately separate from `GithubAppModel`: that model's form signals back
 * the plain "map a release target" form, and the wizard walks the same
 * repository/environment pickers with its own, longer-lived draft. Sharing the
 * signals would make one form reset the other mid-flow.
 *
 * Every GitHub-side step is independent, so each keeps its own result signal.
 * A step that fails with a permission problem does not block the next one — the
 * wizard renders that step's manual fallback and carries on.
 */

/** Ecosystems with a gate adapter. atpm has no gate; see docs/workflow-gates.md. */
export const GATE_ECOSYSTEMS = [
  { id: "npm", label: ECOSYSTEM_LABELS.npm },
  { id: "pypi", label: ECOSYSTEM_LABELS.pypi },
  { id: "vscode", label: `${ECOSYSTEM_LABELS.vscode} extension` },
] as const;

export type GateSetupStep = "environment" | "protection_rule" | "pull_request";
type GateSetupStatus = "created" | "already_configured" | "failed";

type GateSetupFailureCode =
  | "permission_denied"
  | "workflow_scope_missing"
  | "repository_not_accessible"
  | "already_exists"
  | "invalid_request"
  | "github_unavailable";

interface GateSetupFailure {
  code: GateSetupFailureCode;
  message: string;
  manualFallback: string;
}

export interface GateSetupStepResult {
  step: GateSetupStep;
  status: GateSetupStatus;
  failure?: GateSetupFailure;
}

export interface GateSetupPullRequest {
  number: number;
  url: string;
  branch: string;
}

export interface GateSetupPreview {
  workflowPath: string;
  yaml: string;
  notes: string[];
}

/** Sentinel option in the environment picker: type a new name instead. */
export const NEW_ENVIRONMENT_CHOICE = "__new__";

export const GateSetupModel = createModel(() => {
  const installationRowId = signal("");
  const repositoryFullName = signal("");
  const environmentChoice = signal("");
  const newEnvironmentName = signal("production");
  const ecosystem = signal("");
  const packageName = signal("");

  const repositories = signal<InstallationRepository[]>([]);
  const repositoriesLoading = signal(false);
  const environments = signal<RepositoryEnvironment[]>([]);
  const environmentsLoading = signal(false);

  const environmentStep = signal<GateSetupStepResult | null>(null);
  const protectionStep = signal<GateSetupStepResult | null>(null);
  const pullRequestStep = signal<GateSetupStepResult | null>(null);
  const pullRequest = signal<GateSetupPullRequest | null>(null);
  const releaseTarget = signal<PublicReleaseTarget | null>(null);

  const preview = signal<GateSetupPreview | null>(null);
  const previewLoading = signal(false);

  const busyStep = signal<GateSetupStep | "release_target" | "preview" | null>(null);
  const error = signal<string | null>(null);

  // GitHub lowercases environment names, and the server normalizes the same
  // way, so the client shows the maintainer the value that will actually exist.
  const environment = computed(() =>
    environmentChoice.value === NEW_ENVIRONMENT_CHOICE
      ? newEnvironmentName.value.trim().toLowerCase()
      : environmentChoice.value.trim().toLowerCase(),
  );

  // The server refuses identities it would have to interpolate into generated
  // YAML, and an environment that already exists on GitHub can be outside that
  // allowlist. Check the same shapes here so the wizard says so next to the
  // picker instead of letting the maintainer discover it as a bare error after
  // two irreversible GitHub mutations.
  const environmentIssue = computed<string | null>(() => {
    const value = environment.value;
    if (!value) return null;
    if (GATE_SETUP_ENVIRONMENT_NAME_RE.test(value)) return null;
    return `Drydock can only automate environment names of 1-128 letters, digits, spaces, or . _ - — "${value}" is outside that. Set this environment up by hand and map it as a release target.`;
  });
  const packageNameIssue = computed<string | null>(() => {
    const value = packageName.value.trim();
    if (!value) return null;
    if (GATE_SETUP_PACKAGE_NAME_RE.test(value)) return null;
    return "Use 1-214 characters of letters, digits, or @ . _ / - — this name goes into the generated workflow.";
  });

  const repositoryPicked = computed(
    () => installationRowId.value !== "" && repositoryFullName.value !== "",
  );
  const environmentPicked = computed(
    () => repositoryPicked.value && environment.value !== "" && environmentIssue.value === null,
  );
  const templateReady = computed(
    () =>
      environmentPicked.value &&
      ecosystem.value !== "" &&
      packageName.value.trim() !== "" &&
      packageNameIssue.value === null,
  );
  const busy = computed(() => busyStep.value !== null);

  function draft() {
    return {
      installationRowId: installationRowId.peek(),
      repositoryFullName: repositoryFullName.peek(),
      environment: environment.peek(),
      ecosystem: ecosystem.peek(),
      packageName: packageName.peek().trim(),
    };
  }

  /**
   * Run one wizard step.
   *
   * A transport/auth failure surfaces in `error`; a step that GitHub refused
   * comes back as a 200 with `status: "failed"` and is stored in the step's own
   * signal, because that is the case the UI degrades rather than reports.
   */
  async function post<T>(
    step: GateSetupStep | "release_target" | "preview",
    path: string,
    body: unknown,
  ): Promise<T | null> {
    busyStep.value = step;
    error.value = null;
    try {
      return await apiJson<T>(path, body);
    } catch (err) {
      error.value = errorMessage(err);
      return null;
    } finally {
      busyStep.value = null;
    }
  }

  function resetDownstream() {
    environmentStep.value = null;
    protectionStep.value = null;
    pullRequestStep.value = null;
    pullRequest.value = null;
    releaseTarget.value = null;
    preview.value = null;
    error.value = null;
  }

  return {
    installationRowId,
    repositoryFullName,
    environmentChoice,
    newEnvironmentName,
    ecosystem,
    packageName,
    repositories,
    repositoriesLoading,
    environments,
    environmentsLoading,
    environmentStep,
    protectionStep,
    pullRequestStep,
    pullRequest,
    releaseTarget,
    preview,
    previewLoading,
    busyStep,
    busy,
    error,
    environment,
    repositoryPicked,
    environmentPicked,
    environmentIssue,
    packageNameIssue,
    templateReady,

    async selectInstallation(nextId: string): Promise<void> {
      installationRowId.value = nextId;
      repositoryFullName.value = "";
      environmentChoice.value = "";
      repositories.value = [];
      environments.value = [];
      resetDownstream();
      if (!nextId) return;
      repositoriesLoading.value = true;
      try {
        const data = await apiFetch<{ repositories: InstallationRepository[] }>(
          `/api/v1/github-app/installations/${encodeURIComponent(nextId)}/repositories`,
        );
        repositories.value = data.repositories;
      } catch (err) {
        error.value = errorMessage(err);
      } finally {
        repositoriesLoading.value = false;
      }
    },

    async selectRepository(fullName: string): Promise<void> {
      repositoryFullName.value = fullName;
      environmentChoice.value = "";
      environments.value = [];
      resetDownstream();
      const rowId = installationRowId.peek();
      const [owner, repo] = fullName.split("/", 2);
      if (!rowId || !owner || !repo) return;
      environmentsLoading.value = true;
      try {
        const data = await apiFetch<{ environments: RepositoryEnvironment[] }>(
          `/api/v1/github-app/installations/${encodeURIComponent(rowId)}/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/environments`,
        );
        environments.value = data.environments;
        // Nothing to pick from means the wizard's own "create it" path is the
        // only way forward; open it instead of showing an empty select.
        if (!data.environments.length) environmentChoice.value = NEW_ENVIRONMENT_CHOICE;
      } catch (err) {
        error.value = errorMessage(err);
      } finally {
        environmentsLoading.value = false;
      }
    },

    selectEnvironmentChoice(choice: string) {
      environmentChoice.value = choice;
      resetDownstream();
    },

    setNewEnvironmentName(name: string) {
      newEnvironmentName.value = name;
      preview.value = null;
    },

    selectEcosystem(id: string) {
      ecosystem.value = id;
      preview.value = null;
    },

    setPackageName(name: string) {
      packageName.value = name;
      preview.value = null;
    },

    async loadPreview(): Promise<void> {
      if (!templateReady.peek()) return;
      previewLoading.value = true;
      const data = await post<GateSetupPreview>(
        "preview",
        "/api/v1/github-app/gate-setup/preview",
        draft(),
      );
      previewLoading.value = false;
      if (data) preview.value = data;
    },

    async createEnvironment(): Promise<void> {
      const data = await post<{ step: GateSetupStepResult }>(
        "environment",
        "/api/v1/github-app/gate-setup/environment",
        draft(),
      );
      if (!data) return;
      environmentStep.value = data.step;
      // A freshly created environment is not in the picker's list yet; add it so
      // the rest of the wizard (and a later reload) sees a consistent choice.
      if (data.step.status !== "failed") {
        const name = environment.peek();
        const known = environments.peek();
        if (!known.some((entry) => entry.name === name)) {
          environments.value = [...known, { name }];
        }
      }
    },

    async enableProtectionRule(): Promise<void> {
      const data = await post<{ step: GateSetupStepResult }>(
        "protection_rule",
        "/api/v1/github-app/gate-setup/protection-rule",
        draft(),
      );
      if (data) protectionStep.value = data.step;
    },

    async openPullRequest(): Promise<void> {
      const data = await post<{
        step: GateSetupStepResult;
        pullRequest: GateSetupPullRequest | null;
        workflowPath: string;
        yaml: string;
        notes: string[];
      }>("pull_request", "/api/v1/github-app/gate-setup/pull-request", draft());
      if (!data) return;
      pullRequestStep.value = data.step;
      pullRequest.value = data.pullRequest;
      // The response always carries the YAML so the failure path has the exact
      // bytes to offer for a manual commit.
      preview.value = { workflowPath: data.workflowPath, yaml: data.yaml, notes: data.notes };
    },

    async createReleaseTarget(): Promise<PublicReleaseTarget | null> {
      const {
        installationRowId: rowId,
        repositoryFullName: repo,
        environment: env,
        ecosystem: pinned,
      } = draft();
      busyStep.value = "release_target";
      error.value = null;
      try {
        // The wizard knows the ecosystem, so it pins it rather than leaving the
        // target on auto-detect. Pinning is what enables the ecosystem's own
        // artifact-name matching — notably PyPI's `pypi-release-candidate-*`
        // shards, which auto-detect has no name to match. An empty value (the
        // maintainer skipped the package step) still means auto-detect.
        const data = await apiJson<{ releaseTarget: PublicReleaseTarget }>(
          "/api/v1/github-app/release-targets",
          {
            installationRowId: rowId,
            repositoryFullName: repo,
            environment: env,
            ...(pinned ? { ecosystem: pinned } : {}),
          },
        );
        releaseTarget.value = data.releaseTarget;
        return data.releaseTarget;
      } catch (err) {
        error.value = errorMessage(err);
        return null;
      } finally {
        busyStep.value = null;
      }
    },

    reset() {
      installationRowId.value = "";
      repositoryFullName.value = "";
      environmentChoice.value = "";
      newEnvironmentName.value = "production";
      ecosystem.value = "";
      packageName.value = "";
      repositories.value = [];
      environments.value = [];
      resetDownstream();
    },
  };
});

/** Copy for a step's badge; `null` means the step has not run yet. */
export function gateSetupStatusLabel(result: GateSetupStepResult | null): string | null {
  if (!result) return null;
  if (result.status === "created") return "done";
  if (result.status === "already_configured") return "already set";
  return "needs you";
}
