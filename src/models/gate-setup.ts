import { computed, createModel, signal } from "@preact/signals";
import { activeOrganizationId } from "./active-organization";
import { apiFetch, apiJson, errorMessage } from "./api";
import type {
  InstallationRepository,
  PublicReleaseTarget,
  RepositoryEnvironment,
} from "./github-app";
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
 * Drydock makes no change to the maintainer's repository — it generates the
 * workflow, points at the GitHub screen for each step, and reads the result
 * back. So the wizard has no per-step mutation results to track; it has one
 * verification of what GitHub actually has, which is also what the "gate armed"
 * claim is allowed to rest on.
 */

type GateSetupAction = "verify" | "preview" | "release_target" | "release_target_delete";

/**
 * `unknown` is the answer when Drydock could not read GitHub, and it is why
 * these are three values rather than a boolean: the wizard must be able to say
 * "I could not check" without that reading as "not configured".
 */
type GateSetupCheck = "present" | "absent" | "unknown";

export interface GateSetupVerification {
  environment: GateSetupCheck;
  protectionRule: GateSetupCheck;
  defaultBranch: string | null;
  unavailableReason?: string;
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

  const verification = signal<GateSetupVerification | null>(null);
  const releaseTarget = signal<PublicReleaseTarget | null>(null);
  const preview = signal<GateSetupPreview | null>(null);

  const busyStep = signal<GateSetupAction | null>(null);
  const error = signal<string | null>(null);
  // Which action raised `error`, so the wizard can render it against the step
  // the maintainer just acted on rather than in a banner at the top of a card
  // they have already scrolled past.
  const errorStep = signal<GateSetupAction | null>(null);
  let repositoriesRequestId = 0;
  let environmentsRequestId = 0;
  let actionRequestId = 0;

  // GitHub lowercases environment names, and the server normalizes the same
  // way, so the client shows the maintainer the value that will actually exist.
  const environment = computed(() =>
    environmentChoice.value === NEW_ENVIRONMENT_CHOICE
      ? newEnvironmentName.value.trim().toLowerCase()
      : environmentChoice.value.trim().toLowerCase(),
  );

  // The generated workflow interpolates these into YAML, so the server refuses
  // shapes it will not quote. Only the workflow step is affected: an existing
  // GitHub environment outside the allowlist can still be verified and mapped,
  // so this must not block steps 2, 3 or 6.
  const environmentIssue = computed<string | null>(() => {
    const value = environment.value;
    if (!value || GATE_SETUP_ENVIRONMENT_NAME_RE.test(value)) return null;
    return `Drydock cannot generate a workflow for an environment named "${value}" — the name goes into the YAML, and only 1-128 letters, digits, spaces, or . _ - are quoted safely. Every other step still works; write the publish workflow by hand.`;
  });
  const packageNameIssue = computed<string | null>(() => {
    const value = packageName.value.trim();
    if (!value || GATE_SETUP_PACKAGE_NAME_RE.test(value)) return null;
    return "Use 1-214 characters of letters, digits, or @ . _ / - — this name goes into the generated workflow.";
  });

  const repositoryPicked = computed(
    () => installationRowId.value !== "" && repositoryFullName.value !== "",
  );
  const environmentPicked = computed(() => repositoryPicked.value && environment.value !== "");
  const templateReady = computed(
    () =>
      environmentPicked.value &&
      environmentIssue.value === null &&
      ecosystem.value !== "" &&
      packageName.value.trim() !== "" &&
      packageNameIssue.value === null,
  );
  const busy = computed(() => busyStep.value !== null);

  /**
   * The only claim the wizard is allowed to make about the gate.
   *
   * A mapped release target means Drydock knows where to send a held
   * deployment; it says nothing about whether GitHub will ever hold one. Only a
   * verified protection rule does, so a green summary requires both.
   */
  const gateArmed = computed(
    () => verification.value?.protectionRule === "present" && releaseTarget.value !== null,
  );

  function draft() {
    return {
      installationRowId: installationRowId.peek(),
      repositoryFullName: repositoryFullName.peek(),
      environment: environment.peek(),
      ecosystem: ecosystem.peek(),
      packageName: packageName.peek().trim(),
    };
  }

  async function request<T>(
    step: GateSetupAction,
    perform: () => Promise<T>,
    apply: (data: T) => void,
  ): Promise<T | null> {
    const requestId = ++actionRequestId;
    const organizationId = activeOrganizationId.peek();
    busyStep.value = step;
    if (errorStep.peek() === step) {
      error.value = null;
      errorStep.value = null;
    }
    try {
      const data = await perform();
      if (requestId !== actionRequestId || activeOrganizationId.peek() !== organizationId) {
        return null;
      }
      apply(data);
      return data;
    } catch (err) {
      if (requestId === actionRequestId && activeOrganizationId.peek() === organizationId) {
        error.value = errorMessage(err);
        errorStep.value = step;
      }
      return null;
    } finally {
      if (requestId === actionRequestId) busyStep.value = null;
    }
  }

  function post<T>(
    step: GateSetupAction,
    path: string,
    body: unknown,
    apply: (data: T) => void,
  ): Promise<T | null> {
    return request(step, () => apiJson<T>(path, body), apply);
  }

  function invalidatePendingActions() {
    ++actionRequestId;
    busyStep.value = null;
  }

  function clearError() {
    error.value = null;
    errorStep.value = null;
  }

  function resetDownstream() {
    invalidatePendingActions();
    verification.value = null;
    releaseTarget.value = null;
    preview.value = null;
    clearError();
  }

  function resetAfterTemplateChange() {
    invalidatePendingActions();
    preview.value = null;
    clearError();
  }

  async function runVerify(): Promise<void> {
    if (!environmentPicked.peek()) return;
    await post<{ state: GateSetupVerification }>(
      "verify",
      "/api/v1/github-app/gate-setup/verify",
      draft(),
      (data) => {
        verification.value = data.state;
        // A verified environment may not be in the picker's list yet — the
        // maintainer just created it on GitHub. Add it so a later reload and
        // the release-target step see a consistent choice.
        if (data.state.environment === "present") {
          const name = environment.peek();
          const known = environments.peek();
          if (!known.some((entry) => entry.name === name)) {
            environments.value = [...known, { name }];
          }
        }
      },
    );
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
    verification,
    releaseTarget,
    preview,
    busyStep,
    busy,
    error,
    errorStep,
    environment,
    repositoryPicked,
    environmentPicked,
    environmentIssue,
    packageNameIssue,
    templateReady,
    gateArmed,

    async selectInstallation(nextId: string): Promise<void> {
      const requestId = ++repositoriesRequestId;
      const organizationId = activeOrganizationId.peek();
      ++environmentsRequestId;
      installationRowId.value = nextId;
      repositoryFullName.value = "";
      environmentChoice.value = "";
      repositories.value = [];
      environments.value = [];
      resetDownstream();
      repositoriesLoading.value = Boolean(nextId);
      environmentsLoading.value = false;
      if (!nextId) return;
      try {
        const data = await apiFetch<{ repositories: InstallationRepository[] }>(
          `/api/v1/github-app/installations/${encodeURIComponent(nextId)}/repositories`,
        );
        if (
          requestId !== repositoriesRequestId ||
          activeOrganizationId.peek() !== organizationId ||
          installationRowId.peek() !== nextId
        ) {
          return;
        }
        repositories.value = data.repositories;
      } catch (err) {
        if (
          requestId === repositoriesRequestId &&
          activeOrganizationId.peek() === organizationId &&
          installationRowId.peek() === nextId
        ) {
          error.value = errorMessage(err);
          errorStep.value = null;
        }
      } finally {
        if (requestId === repositoriesRequestId) repositoriesLoading.value = false;
      }
    },

    async selectRepository(fullName: string): Promise<void> {
      const requestId = ++environmentsRequestId;
      const organizationId = activeOrganizationId.peek();
      repositoryFullName.value = fullName;
      environmentChoice.value = "";
      environments.value = [];
      resetDownstream();
      const rowId = installationRowId.peek();
      const [owner, repo] = fullName.split("/", 2);
      environmentsLoading.value = Boolean(rowId && owner && repo);
      if (!rowId || !owner || !repo) return;
      try {
        const data = await apiFetch<{ environments: RepositoryEnvironment[] }>(
          `/api/v1/github-app/installations/${encodeURIComponent(rowId)}/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/environments`,
        );
        if (
          requestId !== environmentsRequestId ||
          activeOrganizationId.peek() !== organizationId ||
          installationRowId.peek() !== rowId ||
          repositoryFullName.peek() !== fullName
        ) {
          return;
        }
        environments.value = data.environments;
        // Nothing to pick from means the maintainer has to create one on
        // GitHub; open that path instead of showing an empty select.
        if (!data.environments.length) environmentChoice.value = NEW_ENVIRONMENT_CHOICE;
      } catch (err) {
        if (
          requestId === environmentsRequestId &&
          activeOrganizationId.peek() === organizationId &&
          installationRowId.peek() === rowId &&
          repositoryFullName.peek() === fullName
        ) {
          error.value = errorMessage(err);
          errorStep.value = null;
        }
      } finally {
        if (requestId === environmentsRequestId) environmentsLoading.value = false;
      }
    },

    async selectEnvironmentChoice(choice: string): Promise<void> {
      environmentChoice.value = choice;
      resetDownstream();
      // Verify an environment the maintainer picked from GitHub's own list
      // straight away: it is the check they would click next, and its result is
      // what steps 2 and 3 report.
      if (choice !== NEW_ENVIRONMENT_CHOICE) await runVerify();
    },

    setNewEnvironmentName(name: string) {
      newEnvironmentName.value = name;
      resetDownstream();
    },

    verify: runVerify,

    selectEcosystem(id: string) {
      if (releaseTarget.peek()?.ecosystem != null) return;
      ecosystem.value = id;
      resetAfterTemplateChange();
    },

    setPackageName(name: string) {
      packageName.value = name;
      resetAfterTemplateChange();
    },

    async loadPreview(): Promise<void> {
      if (!templateReady.peek()) return;
      await post<GateSetupPreview>(
        "preview",
        "/api/v1/github-app/gate-setup/preview",
        draft(),
        (data) => {
          preview.value = data;
        },
      );
    },

    async createReleaseTarget(): Promise<PublicReleaseTarget | null> {
      const {
        installationRowId: rowId,
        repositoryFullName: repo,
        environment: env,
        ecosystem: pinned,
      } = draft();
      // The wizard knows the ecosystem, so it pins it rather than leaving the
      // target on auto-detect. Pinning is what enables the ecosystem's own
      // artifact-name matching — notably PyPI's `pypi-release-candidate-*`
      // shards, which auto-detect has no name to match. An empty value (the
      // maintainer skipped the package step) still means auto-detect.
      const data = await post<{ releaseTarget: PublicReleaseTarget }>(
        "release_target",
        "/api/v1/github-app/release-targets",
        {
          installationRowId: rowId,
          repositoryFullName: repo,
          environment: env,
          ...(pinned ? { ecosystem: pinned } : {}),
        },
        (response) => {
          releaseTarget.value = response.releaseTarget;
        },
      );
      return data?.releaseTarget ?? null;
    },

    async removeReleaseTarget(id: string): Promise<boolean> {
      const data = await request(
        "release_target_delete",
        () =>
          apiFetch<{ ok: true }>(`/api/v1/github-app/release-targets/${encodeURIComponent(id)}`, {
            method: "DELETE",
          }),
        () => {
          if (releaseTarget.peek()?.id === id) releaseTarget.value = null;
        },
      );
      return data !== null;
    },

    reset() {
      ++repositoriesRequestId;
      ++environmentsRequestId;
      installationRowId.value = "";
      repositoryFullName.value = "";
      environmentChoice.value = "";
      newEnvironmentName.value = "production";
      ecosystem.value = "";
      packageName.value = "";
      repositories.value = [];
      environments.value = [];
      repositoriesLoading.value = false;
      environmentsLoading.value = false;
      resetDownstream();
    },
  };
});

/** GitHub's own screen for each step the maintainer takes there. */
export function environmentSettingsUrl(repositoryFullName: string): string {
  return `https://github.com/${repositoryFullName}/settings/environments`;
}

/**
 * GitHub's new-file editor, with the workflow path and body prefilled.
 *
 * The `filename`/`value` query parameters are long-standing but undocumented,
 * so the link is built to stay useful without them: it lands on the editor for
 * the right branch either way, and the copy button beside it is the affordance
 * the flow actually depends on. Oversized bodies drop `value` rather than risk
 * a truncated URL.
 */
export function newWorkflowFileUrl(
  repositoryFullName: string,
  defaultBranch: string | null,
  workflowPath: string,
  yaml: string,
): string {
  const base = `https://github.com/${repositoryFullName}/new/${encodeURIComponent(defaultBranch ?? "main")}`;
  const withValue = `${base}?filename=${encodeURIComponent(workflowPath)}&value=${encodeURIComponent(yaml)}`;
  return withValue.length <= 6000
    ? withValue
    : `${base}?filename=${encodeURIComponent(workflowPath)}`;
}
