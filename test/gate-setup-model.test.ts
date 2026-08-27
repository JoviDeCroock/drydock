import { afterEach, describe, expect, test, vi } from "vitest";
import { GateSetupModel } from "../src/models/gate-setup";
import type { PublicReleaseTarget } from "../src/models/github-app";

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
  vi.unstubAllGlobals();
});

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

  test("invalidates the workflow and release target when the ecosystem changes", () => {
    const model = new GateSetupModel();
    model.environmentStep.value = { step: "environment", status: "created" };
    model.protectionStep.value = { step: "protection_rule", status: "created" };
    model.pullRequestStep.value = { step: "pull_request", status: "created" };
    model.pullRequest.value = { number: 1, url: "https://example.test/pr/1", branch: "drydock/1" };
    model.releaseTarget.value = releaseTarget("npm");

    model.selectEcosystem("pypi");

    expect(model.environmentStep.value?.status).toBe("created");
    expect(model.protectionStep.value?.status).toBe("created");
    expect(model.pullRequestStep.value).toBe(null);
    expect(model.pullRequest.value).toBe(null);
    expect(model.releaseTarget.value).toBe(null);
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
});
