import { afterEach, describe, expect, test, vi } from "vitest";
import { ScanDetailModel, type PersistedScanDetail } from "../src/models/scan";
import { reviewAgainRequest } from "../src/models/scan-api";
import { jsonResponse, stubFetchRoutes } from "./helpers/fetch-stub";

type Scan = PersistedScanDetail["scan"];

function failedScan(overrides: Partial<Scan> = {}): Scan {
  return {
    id: "scan-failed",
    stageId: "stage-1",
    organizationId: "org-1",
    packageName: "left-pad",
    stagedVersion: "1.0.1",
    previousVersion: null,
    risk: "unknown",
    status: "failed",
    source: "manual",
    errorJson: { code: "sandbox_download_transient", message: "temporarily failed" },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("reviewAgainRequest", () => {
  test("a failed staged review restarts from its stage id", () => {
    expect(reviewAgainRequest(failedScan())).toEqual({ stageId: "stage-1" });
    expect(reviewAgainRequest(failedScan({ source: "auto_discovery" }))).toEqual({
      stageId: "stage-1",
    });
  });

  test("a failed published-pair review restarts from the coordinates its stage id names", () => {
    expect(
      reviewAgainRequest(
        failedScan({ source: "published", stageId: "published:npm:@scope/pkg@2.0.0-beta.1" }),
      ),
    ).toEqual({ ecosystem: "npm", packageName: "@scope/pkg", version: "2.0.0-beta.1" });
    expect(
      reviewAgainRequest(failedScan({ source: "published", stageId: "published:npm:pkg@" })),
    ).toBeNull();
  });

  test("only a current failed review outside a gate is offered again", () => {
    expect(reviewAgainRequest(failedScan({ status: "complete" }))).toBeNull();
    expect(reviewAgainRequest(failedScan({ source: "workflow_gate" }))).toBeNull();
    expect(
      reviewAgainRequest(failedScan({ registryStatusSupersededAt: "2026-10-02T00:00:00.000Z" })),
    ).toBeNull();
  });

  test("a staged candidate npm no longer holds is not offered again", () => {
    for (const code of [
      "staged_release_published",
      "staged_release_deleted",
      "staged_release_blocked",
    ]) {
      expect(reviewAgainRequest(failedScan({ errorJson: { code } }))).toBeNull();
    }
  });

  test("a failure that needs settings fixed first is not offered again", () => {
    for (const code of ["npm_connection_missing", "npm_connection_unvalidated"]) {
      expect(reviewAgainRequest(failedScan({ errorJson: { code } }))).toBeNull();
    }
  });

  test.each(["published", "blocked", "deleted"])(
    "a transient failure npm has since settled as %s is not offered again",
    (registryVersionStatus) => {
      expect(reviewAgainRequest(failedScan({ registryVersionStatus }))).toBeNull();
    },
  );

  test("a published-pair review restarts against the baseline it recorded", () => {
    expect(
      reviewAgainRequest(
        failedScan({
          source: "published",
          stageId: "published:npm:pkg@3.0.0",
          previousVersion: "2.4.0",
        }),
      ),
    ).toEqual({ ecosystem: "npm", packageName: "pkg", version: "3.0.0", baselineVersion: "2.4.0" });
  });
});

describe("ScanDetailModel.reviewAgain", () => {
  let model: InstanceType<typeof ScanDetailModel> | null = null;

  afterEach(() => {
    model?.[Symbol.dispose]();
    model = null;
    vi.unstubAllGlobals();
  });

  function failedModel(): InstanceType<typeof ScanDetailModel> {
    const instance = new ScanDetailModel("scan-failed");
    instance.detail.value = { scan: failedScan(), files: [], findings: [], events: [] };
    return instance;
  }

  test("starts a fresh review through the normal start route and returns its id", async () => {
    const fetchMock = stubFetchRoutes({
      "/api/v1/scans": () => jsonResponse({ scan: { id: "scan-new" }, queued: true }, 202),
    });
    model = failedModel();
    expect(model.canReviewAgain.value).toBe(true);

    await expect(model.reviewAgain()).resolves.toBe("scan-new");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/v1\/scans$/);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ stageId: "stage-1" });
    expect(model.reviewAgainStatus.value).toBe("idle");
  });

  test("reports a refused start instead of navigating", async () => {
    stubFetchRoutes({
      "/api/v1/scans": () =>
        jsonResponse(
          { error: "This organization's npm token cannot access that staged publish." },
          403,
        ),
    });
    model = failedModel();

    await expect(model.reviewAgain()).resolves.toBeNull();
    expect(model.reviewAgainStatus.value).toBe("error");
    expect(model.reviewAgainError.value).toMatch(/cannot access that staged publish/);
  });
});
