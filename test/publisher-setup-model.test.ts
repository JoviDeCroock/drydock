import { afterEach, describe, expect, test, vi } from "vitest";
import { PublisherSetupModel } from "../src/models/publisher-setup";
import { setActiveOrganizationId } from "../src/models/active-organization";
import type {
  PublisherSetupDraft,
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
  proposalToken: "signed-proposal",
};

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

afterEach(() => {
  for (const model of models.splice(0)) model[Symbol.dispose]();
  setActiveOrganizationId(null);
  vi.unstubAllGlobals();
});

describe("publisher setup", () => {
  test("creates only the exact reviewed signed proposal after explicit review", async () => {
    const bodies: unknown[] = [];
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () => jsonResponse({ inspection }),
      "/setup/draft": () => jsonResponse(draft),
      "/setup/pull-request": (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          pullRequest: {
            number: 8,
            url: "https://github.com/example/package/pull/8",
            branch: "drydock/setup",
          },
        });
      },
    });
    const model = createModel();
    await inspect(model);
    await model.draftWorkflow();
    await model.createPullRequest();
    expect(bodies).toEqual([]);

    model.setReviewed(true);
    await model.createPullRequest();

    expect(bodies).toEqual([draft]);
    expect(model.pullRequest.value?.number).toBe(8);
    expect(model.canCreatePullRequest.value).toBe(false);
  });

  test("changing the repository discards a pending draft and its review authorization", async () => {
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
    const pending = model.draftWorkflow();
    model.selectRepository("example/other");
    finishDraft(jsonResponse(draft));
    await pending;

    expect(model.draft.value).toBeNull();
    expect(model.inspection.value).toBeNull();
    expect(model.reviewed.value).toBe(false);
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

  test("changing environment or ecosystem requires a new signed proposal and review", async () => {
    stubFetchRoutes({
      "/repositories": repositories,
      "/setup/inspect": () => jsonResponse({ inspection }),
      "/setup/draft": () => jsonResponse(draft),
    });
    const model = createModel();
    await inspect(model);
    await model.draftWorkflow();
    model.setReviewed(true);
    model.setEnvironment("publish");
    expect(model.draft.value).toBeNull();
    expect(model.reviewed.value).toBe(false);
    await model.draftWorkflow();
    model.setEcosystem("pypi");
    expect(model.draft.value).toBeNull();
    expect(model.canCreatePullRequest.value).toBe(false);
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
    await model.draftWorkflow();

    expect(model.inspection.value).toEqual(inspection);
    expect(model.draft.value).toBeNull();
    expect(model.error.value).toContain("AI drafting is disabled");
    expect(model.canDraft.value).toBe(true);
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
});
