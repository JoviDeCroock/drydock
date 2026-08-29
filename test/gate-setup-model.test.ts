import { afterEach, describe, expect, test, vi } from "vitest";
import { setActiveOrganizationId } from "../src/models/active-organization";
import { GateSetupModel } from "../src/models/gate-setup";
import type { PublicReleaseTarget } from "../src/models/github-app";

type GateSetup = InstanceType<typeof GateSetupModel>;

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function releaseTarget(ecosystem: "npm" | "pypi" = "npm"): PublicReleaseTarget {
  return {
    id: "target-1",
    organizationId: "org-1",
    installationRowId: "installation-1",
    ecosystem,
    artifactName: null,
    repositoryId: 1,
    repositoryFullName: "octo/widgets",
    environment: "production",
    createdAt: "2026-08-26T00:00:00Z",
    updatedAt: "2026-08-26T00:00:00Z",
  };
}

afterEach(() => {
  setActiveOrganizationId(null);
  vi.unstubAllGlobals();
});

function readyModel(): GateSetup {
  const model = new GateSetupModel();
  model.installationRowId.value = "installation-1";
  model.repositoryFullName.value = "octo/widgets";
  model.environmentChoice.value = "production";
  model.ecosystem.value = "npm";
  model.packageName.value = "@acme/toolkit";
  return model;
}

describe("GateSetupModel", () => {
  test("does not let a stale installation lookup replace the current repositories", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        String(input).includes("installation-first") ? first.promise : second.promise,
      ),
    );
    const model = new GateSetupModel();

    const firstLoad = model.selectInstallation("installation-first");
    const secondLoad = model.selectInstallation("installation-second");
    second.resolve(Response.json({ repositories: [{ id: 2, fullName: "octo/second" }] }));
    await secondLoad;
    first.resolve(Response.json({ repositories: [{ id: 1, fullName: "octo/first" }] }));
    await firstLoad;

    expect(model.installationRowId.value).toBe("installation-second");
    expect(model.repositories.value.map((repository) => repository.fullName)).toEqual([
      "octo/second",
    ]);
    expect(model.repositoriesLoading.value).toBe(false);
  });

  test("does not let a stale repository lookup replace the current environments", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        String(input).includes("/first/") ? first.promise : second.promise,
      ),
    );
    const model = new GateSetupModel();
    model.installationRowId.value = "installation-1";

    const firstLoad = model.selectRepository("octo/first");
    const secondLoad = model.selectRepository("octo/second");
    second.resolve(Response.json({ environments: [{ name: "second-production" }] }));
    await secondLoad;
    first.resolve(Response.json({ environments: [{ name: "first-production" }] }));
    await firstLoad;

    expect(model.repositoryFullName.value).toBe("octo/second");
    expect(model.environments.value).toEqual([{ name: "second-production" }]);
    expect(model.environmentsLoading.value).toBe(false);
  });

  test("drops picker lookups after the active organization changes", async () => {
    const repositories = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => repositories.promise),
    );
    setActiveOrganizationId("org-1");
    const model = new GateSetupModel();

    const repositoryLoad = model.selectInstallation("installation-1");
    setActiveOrganizationId("org-2");
    repositories.resolve(
      Response.json({ repositories: [{ id: 1, fullName: "octo/old", defaultBranch: "main" }] }),
    );
    await repositoryLoad;

    expect(model.repositories.value).toEqual([]);
    expect(model.repositoriesLoading.value).toBe(false);
    expect(model.error.value).toBe(null);

    const environments = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => environments.promise),
    );
    setActiveOrganizationId("org-2");
    model.installationRowId.value = "installation-2";
    const environmentLoad = model.selectRepository("octo/widgets");
    setActiveOrganizationId("org-3");
    environments.resolve(Response.json({ environments: [{ name: "old-production" }] }));
    await environmentLoad;

    expect(model.environments.value).toEqual([]);
    expect(model.environmentsLoading.value).toBe(false);
    expect(model.error.value).toBe(null);
  });

  test("invalidates completed setup state when the environment name changes", () => {
    const model = new GateSetupModel();
    model.environmentStep.value = { step: "environment", status: "created" };
    model.protectionStep.value = { step: "protection_rule", status: "created" };
    model.pullRequestStep.value = { step: "pull_request", status: "created" };
    model.pullRequest.value = { number: 1, url: "https://example.test/pr/1", branch: "drydock/1" };
    model.releaseTarget.value = releaseTarget();
    model.preview.value = { workflowPath: "workflow.yml", yaml: "name: old", notes: [] };

    model.setNewEnvironmentName("next-production");

    expect(model.environmentStep.value).toBe(null);
    expect(model.protectionStep.value).toBe(null);
    expect(model.pullRequestStep.value).toBe(null);
    expect(model.pullRequest.value).toBe(null);
    expect(model.releaseTarget.value).toBe(null);
    expect(model.preview.value).toBe(null);
  });

  test("keeps a mapped ecosystem pinned until the release target is removed", () => {
    const model = new GateSetupModel();
    model.ecosystem.value = "npm";
    model.environmentStep.value = { step: "environment", status: "created" };
    model.protectionStep.value = { step: "protection_rule", status: "created" };
    model.pullRequestStep.value = { step: "pull_request", status: "created" };
    model.pullRequest.value = { number: 1, url: "https://example.test/pr/1", branch: "drydock/1" };
    model.releaseTarget.value = releaseTarget("npm");

    model.selectEcosystem("pypi");

    expect(model.ecosystem.value).toBe("npm");
    expect(model.environmentStep.value?.status).toBe("created");
    expect(model.protectionStep.value?.status).toBe("created");
    expect(model.pullRequestStep.value?.status).toBe("created");
    expect(model.pullRequest.value?.number).toBe(1);
    expect(model.releaseTarget.value?.id).toBe("target-1");
  });

  test("allows a workflow ecosystem beside an auto-detect release target", () => {
    const model = new GateSetupModel();
    model.releaseTarget.value = { ...releaseTarget(), ecosystem: null };

    model.selectEcosystem("pypi");

    expect(model.ecosystem.value).toBe("pypi");
    expect(model.releaseTarget.value?.ecosystem).toBe(null);
  });

  test("invalidates only the generated workflow when the package name changes", () => {
    const model = new GateSetupModel();
    const target = releaseTarget();
    model.pullRequestStep.value = { step: "pull_request", status: "created" };
    model.pullRequest.value = { number: 1, url: "https://example.test/pr/1", branch: "drydock/1" };
    model.releaseTarget.value = target;

    model.setPackageName("@acme/next");

    expect(model.pullRequestStep.value).toBe(null);
    expect(model.pullRequest.value).toBe(null);
    expect(model.releaseTarget.value).toBe(target);
  });

  test("allows a release target manual path for an environment outside the template allowlist", () => {
    const model = readyModel();
    model.environmentChoice.value = "production/eu";

    expect(model.environmentIssue.value).not.toBe(null);
    expect(model.environmentPicked.value).toBe(false);
    expect(model.releaseTargetReady.value).toBe(true);
  });

  test("drops every action response after the active organization changes", async () => {
    const cases: {
      start: (model: GateSetup) => Promise<unknown>;
      response: unknown;
      read: (model: GateSetup) => unknown;
    }[] = [
      {
        start: (model) => model.loadPreview(),
        response: { workflowPath: "old.yml", yaml: "name: old", notes: [] },
        read: (model) => model.preview.value,
      },
      {
        start: (model) => model.createEnvironment(),
        response: { step: { step: "environment", status: "created" } },
        read: (model) => model.environmentStep.value,
      },
      {
        start: (model) => model.enableProtectionRule(),
        response: { step: { step: "protection_rule", status: "created" } },
        read: (model) => model.protectionStep.value,
      },
      {
        start: (model) => model.openPullRequest(),
        response: {
          step: { step: "pull_request", status: "created" },
          pullRequest: { number: 1, url: "https://example.test/pr/1", branch: "old" },
          workflowPath: "old.yml",
          yaml: "name: old",
          notes: [],
        },
        read: (model) => model.pullRequestStep.value,
      },
      {
        start: (model) => model.createReleaseTarget(),
        response: { releaseTarget: releaseTarget() },
        read: (model) => model.releaseTarget.value,
      },
    ];

    for (const entry of cases) {
      const pending = deferredResponse();
      vi.stubGlobal(
        "fetch",
        vi.fn(() => pending.promise),
      );
      setActiveOrganizationId("org-1");
      const model = readyModel();

      const action = entry.start(model);
      setActiveOrganizationId("org-2");
      pending.resolve(Response.json(entry.response));
      await action;

      expect(entry.read(model)).toBe(null);
      expect(model.error.value).toBe(null);
      expect(model.busyStep.value).toBe(null);
    }
  });

  test("does not let an invalidated action clear or replace the next action", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    );
    setActiveOrganizationId("org-1");
    const model = readyModel();

    const firstLoad = model.loadPreview();
    model.selectEcosystem("pypi");
    const secondLoad = model.loadPreview();
    first.resolve(Response.json({ workflowPath: "old.yml", yaml: "name: old", notes: [] }));
    await firstLoad;

    expect(model.busyStep.value).toBe("preview");
    expect(model.preview.value).toBe(null);

    second.resolve(Response.json({ workflowPath: "new.yml", yaml: "name: new", notes: [] }));
    await secondLoad;

    expect(model.busyStep.value).toBe(null);
    expect(model.preview.value?.workflowPath).toBe("new.yml");
  });

  test("drops an action error after the active organization changes", async () => {
    const pending = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => pending.promise),
    );
    setActiveOrganizationId("org-1");
    const model = readyModel();

    const load = model.loadPreview();
    setActiveOrganizationId("org-2");
    pending.resolve(Response.json({ error: "old organization failed" }, { status: 500 }));
    await load;

    expect(model.error.value).toBe(null);
    expect(model.busyStep.value).toBe(null);
  });

  test("removes a mapped target before allowing another ecosystem", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ ok: true }))),
    );
    setActiveOrganizationId("org-1");
    const model = readyModel();
    model.releaseTarget.value = releaseTarget();

    expect(await model.removeReleaseTarget("target-1")).toBe(true);
    model.selectEcosystem("pypi");

    expect(model.releaseTarget.value).toBe(null);
    expect(model.ecosystem.value).toBe("pypi");
  });
});
