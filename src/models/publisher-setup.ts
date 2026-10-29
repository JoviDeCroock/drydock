import { computed, createModel, effect, signal } from "@preact/signals";
import {
  SETUP_ARTIFACT_NAMES,
  type PublisherSetupDraft,
  type PublisherSetupDraftJob,
  type PublisherSetupDraftRequest,
  type PublisherSetupInspection,
  type PublisherSetupPullRequest,
  type PublisherSetupStatus,
} from "../../server/lib/github-app/setup-types";
import { activeOrganizationId } from "./active-organization";
import { ApiError, apiFetch, apiJson, errorMessage } from "./api";
import type { InstallationRepository } from "./release-targets";
import { normalizeGithubEnvironmentName } from "../../server/lib/github-app/validation";

type SetupOperation = "idle" | "inspecting" | "drafting" | "checking" | "mapping";

interface SavedDraftJob {
  id: string;
  request: PublisherSetupDraftRequest;
}

const DRAFT_POLL_INTERVAL_MS = 3_000;
const DRAFT_POLL_MAX_ATTEMPTS = 300;

function savedJobKey(organizationId: string) {
  return `drydock:publisher-draft:${organizationId}`;
}

function sameDraftRequest(left: PublisherSetupDraftRequest, right: PublisherSetupDraftRequest) {
  return (
    left.installationRowId === right.installationRowId &&
    left.repositoryFullName === right.repositoryFullName &&
    left.baseSha === right.baseSha &&
    left.workflowPath === right.workflowPath &&
    left.environment === right.environment &&
    left.ecosystem === right.ecosystem
  );
}

function readSavedJob(organizationId: string | null): SavedDraftJob | null {
  if (!organizationId || typeof sessionStorage === "undefined") return null;
  try {
    const value = JSON.parse(
      sessionStorage.getItem(savedJobKey(organizationId)) ?? "null",
    ) as SavedDraftJob | null;
    if (!value || typeof value.id !== "string" || value.id.length > 200 || !value.request)
      return null;
    const request = value.request;
    if (
      ![
        request.installationRowId,
        request.repositoryFullName,
        request.baseSha,
        request.workflowPath,
        request.environment,
      ].every((field) => typeof field === "string" && field.length > 0 && field.length <= 500)
    )
      return null;
    if (
      !["npm", "pypi", "vscode"].includes(request.ecosystem) ||
      request.createPullRequest !== true
    )
      return null;
    return {
      id: value.id,
      request: {
        installationRowId: request.installationRowId,
        repositoryFullName: request.repositoryFullName,
        baseSha: request.baseSha,
        workflowPath: request.workflowPath,
        environment: request.environment,
        ecosystem: request.ecosystem,
        createPullRequest: true,
      },
    };
  } catch {
    return null;
  }
}

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
  const draftJob = signal<PublisherSetupDraftJob | null>(null);
  const draftJobId = signal<string | null>(null);
  const originalContent = signal<string | null>(null);
  const pollingPaused = signal(false);
  const pollingError = signal<string | null>(null);
  const draftPending = computed(
    () =>
      Boolean(draftJobId.value) &&
      (!draftJob.value ||
        draftJob.value.status === "queued" ||
        draftJob.value.status === "running"),
  );
  const pullRequest = signal<PublisherSetupPullRequest | null>(null);
  const setupStatus = signal<PublisherSetupStatus | null>(null);
  const busy = computed(() => operation.value !== "idle");
  const canInspect = computed(
    () => Boolean(installationRowId.value && repositoryFullName.value) && !busy.value,
  );
  const canDraft = computed(
    () =>
      Boolean(inspection.value && workflowPath.value && environment.value.trim()) &&
      !busy.value &&
      !draftPending.value,
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
  let pollController: AbortController | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollAttempts = 0;
  let pollFailures = 0;
  let currentJob: SavedDraftJob | null = null;

  function saveJob(value: SavedDraftJob | null) {
    if (!selectedOrganizationId || typeof sessionStorage === "undefined") return;
    try {
      if (value) sessionStorage.setItem(savedJobKey(selectedOrganizationId), JSON.stringify(value));
      else sessionStorage.removeItem(savedJobKey(selectedOrganizationId));
    } catch {}
  }

  function stopPolling() {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
    pollController?.abort();
    pollController = null;
  }

  function invalidateProposal(forgetJob = true) {
    generation += 1;
    stopPolling();
    if (forgetJob) saveJob(null);
    currentJob = null;
    draftJob.value = null;
    draftJobId.value = null;
    originalContent.value = null;
    pollingPaused.value = false;
    pollingError.value = null;
    operationController?.abort();
    operationController = null;
    operation.value = "idle";
    draft.value = null;
    pullRequest.value = null;
    setupStatus.value = null;
    error.value = null;
  }

  function clearRepository(forgetJob = true) {
    invalidateProposal(forgetJob);
    repositoryFullName.value = "";
    inspection.value = null;
    workflowPath.value = "";
  }

  effect(() => {
    clearRepository(false);
    selectedOrganizationId = activeOrganizationId.value;
    installationRowId.value = "";
    repositories.value = [];
    repositoryError.value = null;
    loadingRepositories.value = false;
    environment.value = "drydock";
    ecosystem.value = "npm";
    const saved = readSavedJob(selectedOrganizationId);
    if (saved) {
      installationRowId.value = saved.request.installationRowId;
      repositoryFullName.value = saved.request.repositoryFullName;
      workflowPath.value = saved.request.workflowPath;
      environment.value = saved.request.environment;
      ecosystem.value = saved.request.ecosystem;
      currentJob = saved;
      draftJobId.value = saved.id;
      pollingPaused.value = true;
      void loadRepositories(saved.request.installationRowId);
      void pollJob(saved, generation);
    }
    return () => {
      generation += 1;
      repositoryRequest += 1;
      operationController?.abort();
      repositoryController?.abort();
      stopPolling();
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

  async function loadRepositories(value: string) {
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
  }

  async function pollJob(expected: SavedDraftJob, requestGeneration: number) {
    stopPolling();
    const organizationId = selectedOrganizationId;
    const controller = new AbortController();
    pollController = controller;
    const current = () =>
      generation === requestGeneration &&
      activeOrganizationId.peek() === organizationId &&
      currentJob?.id === expected.id &&
      !controller.signal.aborted;
    pollAttempts += 1;
    pollingPaused.value = false;
    try {
      const { job } = await apiFetch<{ job: PublisherSetupDraftJob }>(
        `/api/v1/github-app/setup/draft-jobs/${encodeURIComponent(expected.id)}`,
        { signal: controller.signal },
      );
      if (!current()) return;
      if (
        job.id !== expected.id ||
        !sameDraftRequest(job.request, expected.request) ||
        job.request.createPullRequest !== true ||
        (job.result && !sameDraftRequest(job.result.proposal, expected.request))
      ) {
        invalidateProposal();
        error.value =
          "The draft status did not match the selected workflow. Inspect the repository and draft again.";
        return;
      }
      draftJob.value = job;
      pollingError.value = null;
      pollFailures = 0;
      if (job.status === "ready") {
        saveJob(null);
        if (job.judge?.verdict !== "pass" || !job.result?.pullRequest) {
          error.value =
            "The draft pull request did not complete its checks. Prepare another attempt.";
          return;
        }
        draft.value = { proposal: job.result.proposal, proposalToken: job.result.proposalToken };
        originalContent.value = job.result.originalContent;
        pullRequest.value = job.result.pullRequest;
        return;
      }
      if (job.status === "failed") {
        saveJob(null);
        error.value =
          job.failure?.message ?? "The workflow draft could not complete. Try drafting again.";
        return;
      }
      if (pollAttempts >= DRAFT_POLL_MAX_ATTEMPTS) {
        pollingPaused.value = true;
        pollingError.value =
          "The draft is still running. Resume status checks to retrieve its result.";
        return;
      }
      pollTimer = setTimeout(() => {
        void pollJob(expected, requestGeneration);
      }, DRAFT_POLL_INTERVAL_MS);
    } catch (err) {
      if (!current()) return;
      if (err instanceof ApiError && [403, 404, 410].includes(err.status)) {
        invalidateProposal();
        error.value = "This draft is no longer available. Inspect the repository and draft again.";
        return;
      }
      pollFailures += 1;
      if (pollFailures >= 3 || pollAttempts >= DRAFT_POLL_MAX_ATTEMPTS) {
        pollingPaused.value = true;
        pollingError.value = `Could not check the draft status. ${errorMessage(err)} Resume status checks to try again.`;
        return;
      }
      pollTimer = setTimeout(() => {
        void pollJob(expected, requestGeneration);
      }, DRAFT_POLL_INTERVAL_MS);
    } finally {
      if (pollController === controller) pollController = null;
    }
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
    draftJob,
    draftJobId,
    originalContent,
    draftPending,
    pollingPaused,
    pollingError,
    pullRequest,
    setupStatus,
    busy,
    canInspect,
    canDraft,
    canCheck,

    async selectInstallation(value: string) {
      clearRepository();
      installationRowId.value = value;
      await loadRepositories(value);
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
    async preparePullRequest() {
      if (!canDraft.peek()) return;
      const payload: PublisherSetupDraftRequest = {
        ...scope(),
        baseSha: inspection.peek()!.baseSha,
        workflowPath: workflowPath.peek(),
        environment: normalizeGithubEnvironmentName(environment.peek()),
        ecosystem: ecosystem.peek(),
        createPullRequest: true,
      };
      invalidateProposal();
      await run(
        "drafting",
        (signal) =>
          apiJson<{ job: PublisherSetupDraftJob }>("/api/v1/github-app/setup/draft", payload, {
            signal,
          }),
        (response) => {
          if (
            !sameDraftRequest(response.job.request, payload) ||
            response.job.request.createPullRequest !== true
          ) {
            error.value =
              "The draft request did not match the selected workflow. Inspect the repository and draft again.";
            return;
          }
          draftJob.value = response.job;
          draftJobId.value = response.job.id;
          currentJob = { id: response.job.id, request: payload };
          pollAttempts = 0;
          pollFailures = 0;
          saveJob(currentJob);
          void pollJob(currentJob, generation);
        },
      );
    },
    resumeDraftStatus() {
      if (!currentJob) return;
      pollAttempts = 0;
      pollFailures = 0;
      void pollJob(currentJob, generation);
    },
    hideJob() {
      invalidateProposal();
    },
    async checkStatus() {
      if (!canCheck.peek()) return;
      const payload = {
        ...scope(),
        environment: normalizeGithubEnvironmentName(environment.peek()),
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
        environment: normalizeGithubEnvironmentName(environment.peek()),
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
