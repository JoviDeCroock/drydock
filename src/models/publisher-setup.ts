import { computed, createModel, effect, signal } from "@preact/signals";
import {
  SETUP_ARTIFACT_NAMES,
  type PublisherSetupDraft,
  type PublisherSetupDraftRequest,
  type PublisherSetupInspection,
  type PublisherSetupPullRequest,
  type PublisherSetupStatus,
} from "../../server/lib/github-app/setup-types";
import { activeOrganizationId } from "./active-organization";
import { apiFetch, apiJson, errorMessage } from "./api";
import type { InstallationRepository } from "./release-targets";

type SetupOperation = "idle" | "inspecting" | "drafting" | "creating-pr" | "checking" | "mapping";

export const PublisherSetupModel = createModel(() => {
  const installationRowId = signal("");
  const repositoryFullName = signal("");
  const repositories = signal<InstallationRepository[]>([]);
  const loadingRepositories = signal(false);
  const repositoryError = signal<string | null>(null);
  const workflowPath = signal("");
  const environment = signal("drydock");
  const ecosystem = signal<PublisherSetupDraftRequest["ecosystem"]>("npm");
  const operation = signal<SetupOperation>("idle");
  const error = signal<string | null>(null);
  const inspection = signal<PublisherSetupInspection | null>(null);
  const draft = signal<PublisherSetupDraft | null>(null);
  const reviewed = signal(false);
  const pullRequest = signal<PublisherSetupPullRequest | null>(null);
  const setupStatus = signal<PublisherSetupStatus | null>(null);
  const busy = computed(() => operation.value !== "idle");
  const canInspect = computed(
    () => Boolean(installationRowId.value && repositoryFullName.value) && !busy.value,
  );
  const canDraft = computed(
    () =>
      Boolean(inspection.value && workflowPath.value && environment.value.trim()) && !busy.value,
  );
  const canCreatePullRequest = computed(
    () => Boolean(draft.value && reviewed.value && !pullRequest.value) && !busy.value,
  );
  const canCheck = computed(
    () =>
      Boolean(installationRowId.value && repositoryFullName.value && environment.value.trim()) &&
      !busy.value,
  );
  let generation = 0;
  let selectedOrganizationId = activeOrganizationId.peek();
  let repositoryRequest = 0;
  let operationController: AbortController | null = null;
  let repositoryController: AbortController | null = null;

  function invalidateProposal() {
    generation += 1;
    operationController?.abort();
    operationController = null;
    operation.value = "idle";
    draft.value = null;
    reviewed.value = false;
    pullRequest.value = null;
    setupStatus.value = null;
    error.value = null;
  }

  function clearRepository() {
    invalidateProposal();
    repositoryFullName.value = "";
    inspection.value = null;
    workflowPath.value = "";
  }

  effect(() => {
    selectedOrganizationId = activeOrganizationId.value;
    installationRowId.value = "";
    repositories.value = [];
    repositoryError.value = null;
    loadingRepositories.value = false;
    environment.value = "drydock";
    ecosystem.value = "npm";
    clearRepository();
    return () => {
      generation += 1;
      repositoryRequest += 1;
      operationController?.abort();
      repositoryController?.abort();
    };
  });

  async function run<T>(
    name: SetupOperation,
    request: (signal: AbortSignal) => Promise<T>,
    apply: (value: T) => void,
  ) {
    if (busy.peek()) return;
    const requestGeneration = generation;
    const organizationId = selectedOrganizationId;
    const controller = new AbortController();
    operationController = controller;
    operation.value = name;
    error.value = null;
    const current = () =>
      requestGeneration === generation && activeOrganizationId.peek() === organizationId;
    try {
      const value = await request(controller.signal);
      if (current()) apply(value);
    } catch (err) {
      if (current() && !controller.signal.aborted) error.value = errorMessage(err);
    } finally {
      if (current()) {
        operation.value = "idle";
        operationController = null;
      }
    }
  }

  function scope() {
    return {
      installationRowId: installationRowId.peek(),
      repositoryFullName: repositoryFullName.peek(),
    };
  }

  return {
    installationRowId,
    repositoryFullName,
    repositories,
    loadingRepositories,
    repositoryError,
    workflowPath,
    environment,
    ecosystem,
    operation,
    error,
    inspection,
    draft,
    reviewed,
    pullRequest,
    setupStatus,
    busy,
    canInspect,
    canDraft,
    canCreatePullRequest,
    canCheck,

    async selectInstallation(value: string) {
      clearRepository();
      installationRowId.value = value;
      repositories.value = [];
      repositoryError.value = null;
      repositoryController?.abort();
      const requestId = ++repositoryRequest;
      loadingRepositories.value = Boolean(value);
      if (!value) return;
      const organizationId = activeOrganizationId.peek();
      const controller = new AbortController();
      repositoryController = controller;
      const current = () =>
        requestId === repositoryRequest && activeOrganizationId.peek() === organizationId;
      try {
        const response = await apiFetch<{ repositories: InstallationRepository[] }>(
          `/api/v1/github-app/installations/${encodeURIComponent(value)}/repositories`,
          { signal: controller.signal },
        );
        if (current()) repositories.value = response.repositories;
      } catch (err) {
        if (current() && !controller.signal.aborted) repositoryError.value = errorMessage(err);
      } finally {
        if (current()) loadingRepositories.value = false;
      }
    },

    selectRepository(value: string) {
      clearRepository();
      repositoryFullName.value = value;
    },
    selectWorkflow(value: string) {
      invalidateProposal();
      workflowPath.value = value;
    },
    setEnvironment(value: string) {
      invalidateProposal();
      environment.value = value;
    },
    setEcosystem(value: PublisherSetupDraftRequest["ecosystem"]) {
      invalidateProposal();
      ecosystem.value = value;
    },
    setReviewed(value: boolean) {
      reviewed.value = value;
    },

    async inspect() {
      if (!canInspect.peek()) return;
      const payload = scope();
      inspection.value = null;
      invalidateProposal();
      await run(
        "inspecting",
        (signal) =>
          apiJson<{ inspection: PublisherSetupInspection }>(
            "/api/v1/github-app/setup/inspect",
            payload,
            { signal },
          ),
        (response) => {
          inspection.value = response.inspection;
          workflowPath.value = response.inspection.workflows[0]?.path ?? "";
        },
      );
    },
    async draftWorkflow() {
      if (!canDraft.peek()) return;
      const payload: PublisherSetupDraftRequest = {
        ...scope(),
        baseSha: inspection.peek()!.baseSha,
        workflowPath: workflowPath.peek(),
        environment: environment.peek().trim(),
        ecosystem: ecosystem.peek(),
      };
      draft.value = null;
      reviewed.value = false;
      pullRequest.value = null;
      await run(
        "drafting",
        (signal) =>
          apiJson<PublisherSetupDraft>("/api/v1/github-app/setup/draft", payload, { signal }),
        (response) => {
          draft.value = response;
        },
      );
    },
    async createPullRequest() {
      if (!canCreatePullRequest.peek()) return;
      const payload = draft.peek()!;
      await run(
        "creating-pr",
        (signal) =>
          apiJson<{ pullRequest: PublisherSetupPullRequest }>(
            "/api/v1/github-app/setup/pull-request",
            payload,
            { signal },
          ),
        (response) => {
          pullRequest.value = response.pullRequest;
        },
      );
    },
    async checkStatus() {
      if (!canCheck.peek()) return;
      const payload = {
        ...scope(),
        environment: environment.peek().trim(),
        ecosystem: ecosystem.peek(),
      };
      await run(
        "checking",
        (signal) =>
          apiJson<{ status: PublisherSetupStatus }>("/api/v1/github-app/setup/status", payload, {
            signal,
          }),
        (response) => {
          setupStatus.value = response.status;
        },
      );
    },
    async mapReleaseTarget() {
      if (!canCheck.peek()) return false;
      const selectedEcosystem = ecosystem.peek();
      const payload = {
        ...scope(),
        environment: environment.peek().trim(),
        ecosystem: selectedEcosystem,
        artifactName: SETUP_ARTIFACT_NAMES[selectedEcosystem],
      };
      let mapped = false;
      await run(
        "mapping",
        (signal) => apiJson<unknown>("/api/v1/github-app/release-targets", payload, { signal }),
        () => {
          mapped = true;
        },
      );
      return mapped;
    },
  };
});
