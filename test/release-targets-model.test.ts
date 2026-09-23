import { afterEach, describe, expect, test, vi } from "vitest";
import { setActiveOrganizationId } from "../src/models/active-organization";
import { ReleaseTargetsModel, type PublicReleaseTarget } from "../src/models/release-targets";

function target(id: string): PublicReleaseTarget {
  return {
    id,
    organizationId: "org-1",
    installationRowId: "installation-1",
    ecosystem: "npm",
    artifactName: null,
    repositoryId: 1,
    repositoryFullName: "octo/widgets",
    environment: `env-${id}`,
    createdAt: "2026-08-26T00:00:00Z",
    updatedAt: "2026-08-26T00:00:00Z",
  };
}

function respond(responses: Array<() => Response>) {
  const queue = [...responses];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve((queue.shift() ?? (() => new Response(null, { status: 500 })))())),
  );
}

afterEach(() => {
  setActiveOrganizationId(null);
  vi.unstubAllGlobals();
});

describe("ReleaseTargetsModel", () => {
  test("a failed delete leaves the list healthy, and a retry that succeeds clears it", async () => {
    const model = new ReleaseTargetsModel();
    respond([
      () => Response.json({ releaseTargets: [target("a"), target("b")] }),
      () => Response.json({ error: "try again" }, { status: 503 }),
      () => Response.json({ ok: true }),
    ]);
    await model.load();

    expect(await model.deleteReleaseTarget("a")).toBe(false);
    // The card reports the failure; the list itself did not go stale, so the
    // setup wizard keeps reading it rather than freezing on the last copy.
    expect(model.releaseTargetsError.value).not.toBe(null);
    expect(model.releaseTargetsLoadError.value).toBe(null);

    expect(await model.deleteReleaseTarget("a")).toBe(true);
    expect(model.releaseTargetsError.value).toBe(null);
    expect(model.releaseTargets.value.map((row) => row.id)).toEqual(["b"]);
  });

  test("a failed load is a load error, not an empty list anyone may trust", async () => {
    const model = new ReleaseTargetsModel();
    respond([() => Response.json({ error: "unavailable" }, { status: 503 })]);
    await model.load();

    expect(model.releaseTargetsLoaded.value).toBe(true);
    expect(model.releaseTargetsLoadError.value).not.toBe(null);
  });
});
