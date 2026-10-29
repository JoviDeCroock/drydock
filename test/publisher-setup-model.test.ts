import { afterEach, describe, expect, test, vi } from "vitest";
import { PublisherSetupModel } from "../src/models/publisher-setup";
import { setActiveOrganizationId } from "../src/models/active-organization";
import type {
  PublisherSetupDraft,
  PublisherSetupDraftJob,
  PublisherSetupDraftRequest,
  PublisherSetupInspection,
} from "../server/lib/github-app/setup-types";
import { jsonResponse, stubFetchRoutes } from "./helpers/fetch-stub";

const inspection: PublisherSetupInspection = {
  installationRowId: "installation-1",
  repositoryFullName: "example/package",
  repositoryId: 7,
  defaultBranch: "main",
  baseSha: "a".repeat(40),
  warnings: [],
  workflows: [
    { path: ".github/workflows/release.yml", sha: "b".repeat(40), content: "name: Release\n" },
  ],
};
const draft: PublisherSetupDraft = {
  proposal: {
    ...inspection,
    workflowPath: inspection.workflows[0].path,
    originalSha: "b".repeat(40),
    environment: "drydock",
    ecosystem: "npm",
    content: "name: Reviewed release\n",
    summary: "Hold the publish job.",
    manualSteps: ["Configure the environment."],
    expiresAt: 100,
  },
};

function draftRequest(): PublisherSetupDraftRequest {
  const { installationRowId, repositoryFullName, workflowPath, baseSha, environment, ecosystem } =
    draft.proposal;
  return {
    installationRowId,
    repositoryFullName,
    workflowPath,
    baseSha,
    environment,
    ecosystem,
    createPullRequest: true,
  };
}

const pullRequest = {
  number: 8,
  url: "https://github.com/example/package/pull/8",
  branch: "drydock/setup",
};

function draftJob(overrides: Partial<PublisherSetupDraftJob> = {}): PublisherSetupDraftJob {
  return {
    id: "job-1",
    status: "ready",
    stage: "ready",
    request: draftRequest(),
    createdAt: "2026-10-29T10:00:00Z",
    updatedAt: "2026-10-29T10:00:00Z",
    expiresAt: "2026-10-29T11:00:00Z",
    failure: null,
    judge: {
      verdict: "pass",
      summary: "The change preserves the release artifacts.",
      issues: [],
      model: "test-judge",
      digest: "d".repeat(64),
    },
    result: { ...draft, originalContent: inspection.workflows[0].content, pullRequest },
    ...overrides,
  };
}

function completedDraftRoutes() {
  let request = draftRequest();
  return {
    "/setup/draft-jobs/": () =>
      jsonResponse({
        job: draftJob({
          request,
          result: {
            ...draft,
            proposal: { ...draft.proposal, ...request },
            originalContent: inspection.workflows[0].content,
            pullRequest,
          },
        }),
      }),
    "/setup/draft": (_url: string, init?: RequestInit) => {
      request = JSON.parse(String(init?.body)) as PublisherSetupDraftRequest;
      return jsonResponse(
        {
          job: draftJob({ request, status: "queued", stage: "queued", judge: null, result: null }),
        },
        202,
      );
    },
  };
}

async function draftWorkflow(model: InstanceType<typeof PublisherSetupModel>) {
  await model.preparePullRequest();
  await vi.waitFor(() => expect(model.draft.value).not.toBeNull());
}

const models: InstanceType<typeof PublisherSetupModel>[] = [];
function createModel() {
  const model = new PublisherSetupModel();
  models.push(model);
  return model;
}

function repositories() {
  return jsonResponse({
    repositories: [{ id: 7, fullName: "example/package", defaultBranch: "main" }],
  });
}

async function inspect(model: InstanceType<typeof PublisherSetupModel>) {
  await model.selectInstallation("installation-1");
  model.selectRepository("example/package");
  await model.inspect();
}

function stubSessionStorage(initial: Record<string, unknown> = {}) {
  const values = new Map<string, string>(
    Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]),
  );
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  return values;
}

function runningJobRoutes(onPoll: (id: string) => void = () => {}) {
  return {
    "/repositories": repositories,
    "/setup/inspect": () => jsonResponse({ inspection }),
    "/setup/draft-jobs/": (url: string) => {
      const id = decodeURIComponent(url.split("/").pop()!);
      onPoll(id);
      return jsonResponse({
        job: draftJob({ id, status: "running", stage: "judge", judge: null, result: null }),
      });
    },
    "/setup/draft": () =>
      jsonResponse(
        { job: draftJob({ status: "queued", stage: "queued", judge: null, result: null }) },
        202,
      ),
  };
}

afterEach(() => {
  for (const model of models.splice(0)) model[Symbol.dispose]();
  setActiveOrganizationId(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("publisher setup", () => {
  test("does not resume legacy metadata without explicit automatic PR authorization", () => {
    setActiveOrganizationId("org-a");
    const legacyRequest = { ...draftRequest(), createPullRequest: undefined };
    vi.stubGlobal("sessionStorage", {
      getItem: () => JSON.stringify({ id: "legacy-job", request: legacyRequest }),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const model = createModel();

    expect(fetch).not.toHaveBeenCalled();
    expect(model.draftJobId.value).toBeNull();
    expect(model.pullRequest.value).toBeNull();
  });

  test("a ready response without an opened PR cannot expose a completed result", async () => {
    vi.useFakeTimers();
    const incomplete = { ...draft, originalContent: inspection.workflows[0].content };
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () => jsonResponse({ inspection }),
      "/setup/draft-jobs/": () => jsonResponse({ job: { ...draftJob(), result: incomplete } }),
      "/setup/draft": () =>
        jsonResponse(
          { job: draftJob({ status: "queued", stage: "queued", judge: null, result: null }) },
          202,
        ),
    });
    const model = createModel();
    await inspect(model);

    await model.preparePullRequest();
    await vi.advanceTimersByTimeAsync(0);

    expect(model.draft.value).toBeNull();
    expect(model.pullRequest.value).toBeNull();
    expect(model.error.value).toContain("did not complete its checks");
  });

  test("normalizes a mixed-case environment before queueing and accepting its job", async () => {
    const bodies: unknown[] = [];
    const completed = completedDraftRoutes();
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () => jsonResponse({ inspection }),
      "/setup/draft-jobs/": completed["/setup/draft-jobs/"],
      "/setup/draft": (url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return completed["/setup/draft"](url, init);
      },
    });
    const model = createModel();
    await inspect(model);
    model.setEnvironment("  ProDucTion  ");

    await draftWorkflow(model);

    expect(bodies).toEqual([{ ...draftRequest(), environment: "production" }]);
    expect(model.draft.value?.proposal.environment).toBe("production");
    expect(model.error.value).toBeNull();
  });
  test("polls background stages until a separately judged proposal is ready", async () => {
    vi.useFakeTimers();
    const stages = ["draft", "validate", "judge", "create_pr", "ready"] as const;
    let polls = 0;
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () => jsonResponse({ inspection }),
      "/setup/draft-jobs/": () => {
        const stage = stages[polls++];
        return jsonResponse({
          job: draftJob(
            stage === "ready"
              ? {}
              : {
                  status: "running",
                  stage,
                  judge: null,
                  result: null,
                },
          ),
        });
      },
      "/setup/draft": () =>
        jsonResponse(
          { job: draftJob({ status: "queued", stage: "queued", judge: null, result: null }) },
          202,
        ),
    });
    const model = createModel();
    await inspect(model);
    await model.preparePullRequest();
    await vi.advanceTimersByTimeAsync(0);
    expect(model.draftJob.value?.stage).toBe("draft");
    expect(model.operation.value).toBe("idle");
    expect(model.canDraft.value).toBe(false);
    expect(model.draft.value).toBeNull();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(model.draftJob.value?.stage).toBe("validate");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(model.draftJob.value?.stage).toBe("judge");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(model.draftJob.value?.stage).toBe("create_pr");
    expect(model.pullRequest.value).toBeNull();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(model.draft.value).toEqual(draft);
    expect(model.originalContent.value).toBe(inspection.workflows[0].content);
    expect(model.draftPending.value).toBe(false);
    expect(model.pullRequest.value).toEqual(pullRequest);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a negative judge cannot expose a proposal or enable PR creation", async () => {
    vi.useFakeTimers();
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () => jsonResponse({ inspection }),
      "/setup/draft-jobs/": () =>
        jsonResponse({
          job: draftJob({
            status: "failed",
            stage: "judge",
            judge: {
              verdict: "changes_requested",
              summary: "The publish step rebuilds the package.",
              issues: ["Publish the reviewed artifact."],
              model: "test-judge",
              digest: "d".repeat(64),
            },
            result: null,
            failure: {
              code: "judge_changes_requested",
              message: "The second review requested changes. Draft again.",
            },
          }),
        }),
      "/setup/draft": () =>
        jsonResponse(
          { job: draftJob({ status: "queued", stage: "queued", judge: null, result: null }) },
          202,
        ),
    });
    const model = createModel();
    await inspect(model);
    await model.preparePullRequest();
    await vi.advanceTimersByTimeAsync(0);

    expect(model.draft.value).toBeNull();
    expect(model.pullRequest.value).toBeNull();
    expect(model.error.value).toContain("second review requested changes");
    expect(model.draftJob.value?.judge?.issues).toEqual(["Publish the reviewed artifact."]);
    expect(model.canDraft.value).toBe(true);
  });

  test("rejects a status or proposal from another workflow scope", async () => {
    vi.useFakeTimers();
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () => jsonResponse({ inspection }),
      "/setup/draft-jobs/": () =>
        jsonResponse({ job: draftJob({ request: { ...draftRequest(), environment: "foreign" } }) }),
      "/setup/draft": () =>
        jsonResponse(
          { job: draftJob({ status: "queued", stage: "queued", judge: null, result: null }) },
          202,
        ),
    });
    const model = createModel();
    await inspect(model);
    await model.preparePullRequest();
    await vi.advanceTimersByTimeAsync(0);

    expect(model.draft.value).toBeNull();
    expect(model.draftJob.value).toBeNull();
    expect(model.error.value).toContain("did not match the selected workflow");
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a pending job locks its inputs until cancel stops it; disposal stops polling", async () => {
    vi.useFakeTimers();
    let polls = 0;
    let cancels = 0;
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () => jsonResponse({ inspection }),
      "/cancel": () => {
        cancels += 1;
        return jsonResponse({
          job: draftJob({
            status: "failed",
            stage: "draft",
            judge: null,
            result: null,
            failure: {
              code: "setup_cancelled",
              message: "Pull request preparation was cancelled.",
            },
          }),
        });
      },
      "/setup/draft-jobs/": () => {
        polls += 1;
        return jsonResponse({
          job: draftJob({ status: "running", stage: "draft", judge: null, result: null }),
        });
      },
      "/setup/draft": () =>
        jsonResponse(
          { job: draftJob({ status: "queued", stage: "queued", judge: null, result: null }) },
          202,
        ),
    });
    const model = createModel();
    await inspect(model);
    await model.preparePullRequest();
    await vi.advanceTimersByTimeAsync(0);
    expect(model.inputsLocked.value).toBe(true);
    const repository = model.repositoryFullName.value;
    model.setEnvironment("publish");
    model.selectRepository("drydock/other");
    expect(model.environment.value).toBe("drydock");
    expect(model.repositoryFullName.value).toBe(repository);

    await model.cancelJob();
    expect(cancels).toBe(1);
    expect(model.draftJob.value).toBeNull();
    expect(model.inputsLocked.value).toBe(false);
    const pollsAtCancel = polls;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(polls).toBe(pollsAtCancel);

    model.setEnvironment("publish");
    expect(model.environment.value).toBe("publish");
    model.setEnvironment("drydock");
    await model.preparePullRequest();
    await vi.advanceTimersByTimeAsync(0);
    model[Symbol.dispose]();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(polls).toBe(pollsAtCancel + 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a cancel refused after PR creation started keeps following the job", async () => {
    vi.useFakeTimers();
    const opening = draftJob({ status: "running", stage: "create_pr", judge: null, result: null });
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () => jsonResponse({ inspection }),
      "/cancel": () => jsonResponse({ job: opening }),
      "/setup/draft-jobs/": () => jsonResponse({ job: opening }),
      "/setup/draft": () =>
        jsonResponse(
          { job: draftJob({ status: "queued", stage: "queued", judge: null, result: null }) },
          202,
        ),
    });
    const model = createModel();
    await inspect(model);
    await model.preparePullRequest();
    await vi.advanceTimersByTimeAsync(0);
    await model.cancelJob();
    expect(model.draftJobId.value).toBe("job-1");
    expect(model.draftJob.value?.stage).toBe("create_pr");
    expect(model.inputsLocked.value).toBe(true);
    model[Symbol.dispose]();
  });

  test("a draft-status response cannot land after switching organizations", async () => {
    vi.useFakeTimers();
    setActiveOrganizationId("org-a");
    let finishPoll!: (response: Response) => void;
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () => jsonResponse({ inspection }),
      "/setup/draft-jobs/": () =>
        new Promise<Response>((resolve) => {
          finishPoll = resolve;
        }),
      "/setup/draft": () =>
        jsonResponse(
          { job: draftJob({ status: "queued", stage: "queued", judge: null, result: null }) },
          202,
        ),
    });
    const model = createModel();
    await inspect(model);
    await model.preparePullRequest();
    setActiveOrganizationId("org-b");
    finishPoll(jsonResponse({ job: draftJob() }));
    await vi.advanceTimersByTimeAsync(0);

    expect(model.draft.value).toBeNull();
    expect(model.draftJob.value).toBeNull();
    expect(model.repositoryFullName.value).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a new failed submission cannot leave the previous job pending", async () => {
    let rejectSubmission = false;
    const completed = completedDraftRoutes();
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () => jsonResponse({ inspection }),
      "/setup/draft-jobs/": completed["/setup/draft-jobs/"],
      "/setup/draft": (url, init) =>
        rejectSubmission
          ? jsonResponse({ error: "AI drafting is temporarily unavailable." }, 503)
          : completed["/setup/draft"](url, init),
    });
    const model = createModel();
    await inspect(model);
    await draftWorkflow(model);
    rejectSubmission = true;

    await model.preparePullRequest();

    expect(model.draftJobId.value).toBeNull();
    expect(model.draftPending.value).toBe(false);
    expect(model.canDraft.value).toBe(true);
    expect(model.error.value).toContain("temporarily unavailable");
  });

  test("restores a pending job after reload using only its id and scoped request", async () => {
    vi.useFakeTimers();
    setActiveOrganizationId("org-a");
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    let complete = false;
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () => jsonResponse({ inspection }),
      "/setup/draft-jobs/": () =>
        jsonResponse({
          job: complete
            ? draftJob()
            : draftJob({ status: "running", stage: "judge", judge: null, result: null }),
        }),
      "/setup/draft": () =>
        jsonResponse(
          { job: draftJob({ status: "queued", stage: "queued", judge: null, result: null }) },
          202,
        ),
    });
    const model = createModel();
    await inspect(model);
    await model.preparePullRequest();
    await vi.advanceTimersByTimeAsync(0);
    const saved = values.get("drydock:publisher-draft:org-a")!;
    expect(JSON.parse(saved)).toEqual({ id: "job-1", request: draftRequest() });
    expect(saved).not.toContain("signed-proposal");
    expect(saved).not.toContain("name: Release");
    model[Symbol.dispose]();
    complete = true;

    const resumed = createModel();
    await vi.advanceTimersByTimeAsync(0);

    expect(resumed.repositoryFullName.value).toBe("example/package");
    expect(resumed.draft.value).toEqual(draft);
    expect(resumed.originalContent.value).toBe(inspection.workflows[0].content);
    expect(resumed.pullRequest.value).toEqual(pullRequest);
    expect(values.size).toBe(0);
  });

  test("pauses repeated status failures and supports an explicit retry", async () => {
    vi.useFakeTimers();
    let available = false;
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () => jsonResponse({ inspection }),
      "/setup/draft-jobs/": () =>
        available
          ? jsonResponse({ job: draftJob() })
          : jsonResponse({ error: "Temporarily unavailable." }, 503),
      "/setup/draft": () =>
        jsonResponse(
          { job: draftJob({ status: "queued", stage: "queued", judge: null, result: null }) },
          202,
        ),
    });
    const model = createModel();
    await inspect(model);
    await model.preparePullRequest();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(model.pollingPaused.value).toBe(true);
    expect(model.pollingError.value).toContain("Resume status checks");
    expect(vi.getTimerCount()).toBe(0);

    available = true;
    model.resumeDraftStatus();
    await vi.advanceTimersByTimeAsync(0);
    expect(model.draft.value).toEqual(draft);
    expect(model.pollingError.value).toBeNull();
  });

  test("authorizes automatic PR preparation explicitly and receives its link without another request", async () => {
    const completed = completedDraftRoutes();
    const submitted: unknown[] = [];
    const routes = stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () => jsonResponse({ inspection }),
      "/setup/draft-jobs/": completed["/setup/draft-jobs/"],
      "/setup/draft": (url, init) => {
        submitted.push(JSON.parse(String(init?.body)));
        return completed["/setup/draft"](url, init);
      },
    });
    const model = createModel();
    await inspect(model);
    await draftWorkflow(model);

    expect(submitted).toEqual([draftRequest()]);
    expect(model.pullRequest.value).toEqual(pullRequest);
    expect(routes.mock.calls.some(([url]) => String(url).includes("/setup/pull-request"))).toBe(
      false,
    );
  });

  test("changing the repository hides a pending job and prevents stale PR links", async () => {
    let finishDraft!: (response: Response) => void;
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () => jsonResponse({ inspection }),
      "/setup/draft": () =>
        new Promise<Response>((resolve) => {
          finishDraft = resolve;
        }),
    });
    const model = createModel();
    await inspect(model);
    const pending = model.preparePullRequest();
    model.selectRepository("example/other");
    finishDraft(jsonResponse({ job: draftJob() }, 202));
    await pending;

    expect(model.draft.value).toBeNull();
    expect(model.inspection.value).toBeNull();
    expect(model.pullRequest.value).toBeNull();
    expect(model.operation.value).toBe("idle");
    expect(model.repositoryFullName.value).toBe("example/other");
  });

  test("an organization A to B to A switch invalidates old inspection and repository responses", async () => {
    setActiveOrganizationId("org-a");
    let finishInspection!: (response: Response) => void;
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () =>
        new Promise<Response>((resolve) => {
          finishInspection = resolve;
        }),
    });
    const model = createModel();
    await model.selectInstallation("installation-1");
    model.selectRepository("example/package");
    const pending = model.inspect();
    setActiveOrganizationId("org-b");
    setActiveOrganizationId("org-a");
    finishInspection(jsonResponse({ inspection }));
    await pending;

    expect(model.inspection.value).toBeNull();
    expect(model.installationRowId.value).toBe("");
    expect(model.repositories.value).toEqual([]);
    expect(model.error.value).toBeNull();
  });

  test("changing environment or ecosystem requires a new preparation job", async () => {
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () => jsonResponse({ inspection }),
      ...completedDraftRoutes(),
    });
    const model = createModel();
    await inspect(model);
    await draftWorkflow(model);
    model.setEnvironment("publish");
    expect(model.draft.value).toBeNull();
    expect(model.pullRequest.value).toBeNull();
    await draftWorkflow(model);
    model.setEcosystem("pypi");
    expect(model.draft.value).toBeNull();
    expect(model.pullRequest.value).toBeNull();
  });

  test("AI failure preserves inspection and permits retry without a PR", async () => {
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () => jsonResponse({ inspection }),
      "/setup/draft": () =>
        jsonResponse({ error: "AI drafting is disabled for this organization." }, 409),
    });
    const model = createModel();
    await inspect(model);
    await model.preparePullRequest();

    expect(model.inspection.value).toEqual(inspection);
    expect(model.draft.value).toBeNull();
    expect(model.error.value).toContain("AI drafting is disabled");
    expect(model.failedOperation.value).toBe("drafting");
    expect(model.canDraft.value).toBe(true);

    model.setEnvironment("release");
    expect(model.error.value).toBeNull();
    expect(model.failedOperation.value).toBeNull();
  });

  test("maps only the selected ecosystem and candidate artifact without credentials", async () => {
    const bodies: unknown[] = [];
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () => jsonResponse({ inspection }),
      "/release-targets": (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ releaseTarget: { id: "target-1" } }, 201);
      },
    });
    const model = createModel();
    await inspect(model);
    model.setEnvironment("publish");
    model.setEcosystem("pypi");

    expect(await model.mapReleaseTarget()).toBe(true);
    expect(bodies).toEqual([
      {
        installationRowId: "installation-1",
        repositoryFullName: "example/package",
        environment: "publish",
        ecosystem: "pypi",
        artifactName: "pypi-release-candidate",
      },
    ]);
  });

  test("disposal prevents a late result from repopulating setup state", async () => {
    let finishInspection!: (response: Response) => void;
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () =>
        new Promise<Response>((resolve) => {
          finishInspection = resolve;
        }),
    });
    const model = createModel();
    await model.selectInstallation("installation-1");
    model.selectRepository("example/package");
    const pending = model.inspect();
    model[Symbol.dispose]();
    finishInspection(jsonResponse({ inspection }));
    await pending;

    expect(model.inspection.value).toBeNull();
  });

  test("checks activation for the selected ecosystem and environment", async () => {
    const bodies: unknown[] = [];
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () => jsonResponse({ inspection }),
      "/setup/status": (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          status: {
            repositoryFullName: "example/package",
            environment: "publish",
            targetMapped: false,
            environmentExists: true,
            protectionEnabled: true,
            administratorsCanBypass: false,
            firstReview: null,
            checks: [],
          },
        });
      },
    });
    const model = createModel();
    await inspect(model);
    model.setEnvironment("publish");
    model.setEcosystem("vscode");

    await model.checkStatus();

    expect(bodies).toEqual([
      {
        installationRowId: "installation-1",
        repositoryFullName: "example/package",
        environment: "publish",
        ecosystem: "vscode",
      },
    ]);
    expect(model.setupStatus.value?.firstReview).toBeNull();
  });

  test("keeps polling a healthy job through the server's twenty-minute wall", async () => {
    vi.useFakeTimers();
    stubFetchRoutes(runningJobRoutes());
    const model = createModel();
    await inspect(model);
    await model.preparePullRequest();

    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(model.pollingPaused.value).toBe(false);
    expect(model.pollingError.value).toBeNull();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(model.pollingPaused.value).toBe(true);
    expect(model.pollingError.value).toContain("still running");
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a job restored on organization switch gets a fresh poll window", async () => {
    vi.useFakeTimers();
    setActiveOrganizationId("org-a");
    stubSessionStorage({
      "drydock:publisher-draft:org-b": { id: "job-b", request: draftRequest() },
    });
    const polls: string[] = [];
    stubFetchRoutes(runningJobRoutes((id) => polls.push(id)));
    const model = createModel();
    await inspect(model);
    await model.preparePullRequest();
    await vi.advanceTimersByTimeAsync(23 * 60_000);
    expect(model.pollingPaused.value).toBe(true);

    setActiveOrganizationId("org-b");
    await vi.advanceTimersByTimeAsync(3 * 3_000);

    expect(model.draftJobId.value).toBe("job-b");
    expect(polls.filter((id) => id === "job-b")).toHaveLength(4);
    expect(model.pollingPaused.value).toBe(false);
    expect(model.pollingError.value).toBeNull();
  });

  test("a restored job that is no longer available reports it as a drafting failure", async () => {
    vi.useFakeTimers();
    setActiveOrganizationId("org-a");
    const values = stubSessionStorage({
      "drydock:publisher-draft:org-a": { id: "job-gone", request: draftRequest() },
    });
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/draft-jobs/": () => jsonResponse({ error: "Not found." }, 404),
    });
    const model = createModel();
    await vi.advanceTimersByTimeAsync(0);

    expect(model.draftJobId.value).toBeNull();
    expect(model.inspection.value).toBeNull();
    expect(model.repositoryFullName.value).toBe("example/package");
    expect(model.failedOperation.value).toBe("drafting");
    expect(model.error.value).toContain("no longer available");
    expect(values.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a cancel that loses to an independent-review failure keeps that feedback", async () => {
    vi.useFakeTimers();
    const values = stubSessionStorage();
    setActiveOrganizationId("org-a");
    const judge = {
      verdict: "changes_requested" as const,
      summary: "The publish step rebuilds the package.",
      issues: ["Publish the reviewed artifact."],
      model: "test-judge",
      digest: "d".repeat(64),
    };
    let polls = 0;
    stubFetchRoutes({
      "/cancel": () =>
        jsonResponse({
          job: draftJob({
            status: "failed",
            stage: "judge",
            judge,
            result: null,
            feedback: ["The release job needs the reviewed tarball."],
            failure: {
              code: "judge_changes_requested",
              message: "The second review requested changes. Draft again.",
            },
          }),
        }),
      ...runningJobRoutes(() => {
        polls += 1;
      }),
    });
    const model = createModel();
    await inspect(model);
    await model.preparePullRequest();
    await vi.advanceTimersByTimeAsync(0);

    await model.cancelJob();

    expect(model.draftJobId.value).toBe("job-1");
    expect(model.draftJob.value?.judge).toEqual(judge);
    expect(model.draftJob.value?.feedback).toEqual(["The release job needs the reviewed tarball."]);
    expect(model.error.value).toContain("second review requested changes");
    expect(model.failedOperation.value).toBe("drafting");
    expect(model.draftPending.value).toBe(false);
    expect(model.canDraft.value).toBe(true);
    expect(values.size).toBe(0);
    const pollsAtCancel = polls;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(polls).toBe(pollsAtCancel);
  });

  test("a job queued before an organization switch is kept for its organization", async () => {
    vi.useFakeTimers();
    setActiveOrganizationId("org-a");
    const values = stubSessionStorage();
    let finishDraft!: (response: Response) => void;
    const polls: string[] = [];
    stubFetchRoutes({
      ...runningJobRoutes((id) => polls.push(id)),
      "/setup/draft": () =>
        new Promise<Response>((resolve) => {
          finishDraft = resolve;
        }),
    });
    const model = createModel();
    await inspect(model);
    const pending = model.preparePullRequest();
    setActiveOrganizationId("org-b");
    finishDraft(
      jsonResponse(
        { job: draftJob({ status: "queued", stage: "queued", judge: null, result: null }) },
        202,
      ),
    );
    await pending;

    expect(model.draftJobId.value).toBeNull();
    expect(polls).toEqual([]);
    expect(JSON.parse(values.get("drydock:publisher-draft:org-a")!)).toEqual({
      id: "job-1",
      request: draftRequest(),
    });
    expect(values.has("drydock:publisher-draft:org-b")).toBe(false);

    setActiveOrganizationId("org-a");
    await vi.advanceTimersByTimeAsync(0);
    expect(model.draftJobId.value).toBe("job-1");
    expect(model.repositoryFullName.value).toBe("example/package");
    expect(model.draftPending.value).toBe(true);
    expect(polls).toEqual(["job-1"]);
  });

  test("inspecting leaves ecosystem and environment editable without aborting it", async () => {
    let finishInspection!: (response: Response) => void;
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () =>
        new Promise<Response>((resolve) => {
          finishInspection = resolve;
        }),
    });
    const model = createModel();
    await model.selectInstallation("installation-1");
    model.selectRepository("example/package");
    const pending = model.inspect();
    expect(model.operation.value).toBe("inspecting");
    expect(model.inputsLocked.value).toBe(false);

    model.setEnvironment("publish");
    model.setEcosystem("pypi");
    finishInspection(jsonResponse({ inspection }));
    await pending;

    expect(model.inspection.value).toEqual(inspection);
    expect(model.environment.value).toBe("publish");
    expect(model.ecosystem.value).toBe("pypi");
    expect(model.canDraft.value).toBe(true);
  });
});
