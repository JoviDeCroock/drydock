import { afterEach, describe, expect, test, vi } from "vitest";
import type { ReleaseAuthorityDelta } from "../server/lib/release-authority/delta";
import { ScanDetailModel, type PersistedScanDetail } from "../src/models/scan";

function authorityDelta(subject: string): ReleaseAuthorityDelta {
  return {
    schema: "drydock.release-authority-delta.v1",
    status: "changed",
    baseline: null,
    changes: [
      {
        kind: "action_ref_changed",
        significance: "high",
        scope: ".github/workflows/release.yml/publish",
        subject,
        before: "actions/example@old",
        after: "actions/example@new",
      },
    ],
    changeCount: 1,
    highestSignificance: "high",
    standing: {
      mutableRefs: [],
      coverageComplete: true,
      unresolved: [],
      artifactsWithoutDigest: 0,
    },
    requiresApproval: true,
  };
}

function scanDetail(delta: ReleaseAuthorityDelta): PersistedScanDetail {
  return {
    scan: {
      id: "scan-1",
      stageId: "workflow-gate:gate-1:npm:example",
      source: "workflow_gate",
      packageName: "example",
      stagedVersion: "1.0.1",
      previousVersion: "1.0.0",
      risk: "high",
      status: "complete",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
    },
    releaseAuthority: {
      id: "authority-1",
      gateId: "gate-1",
      runId: 1,
      workflowPath: ".github/workflows/release.yml",
      headSha: "old-head",
      snapshot: null,
      delta,
      approvedAt: null,
      approvedByUserId: null,
      artifactBindingDigest: "old-binding",
      createdAt: "2026-08-23T00:00:00.000Z",
    },
    files: [],
    findings: [],
    events: [],
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("ScanDetailModel release authority", () => {
  let model: InstanceType<typeof ScanDetailModel> | null = null;

  afterEach(() => {
    model?.[Symbol.dispose]();
    model = null;
    vi.unstubAllGlobals();
  });

  test("displays the refreshed delta paired with the acknowledgement token", async () => {
    const persistedDelta = authorityDelta("persisted delta");
    const refreshedDelta = authorityDelta("refreshed delta");
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          gate: {
            id: "gate-1",
            organizationId: "org-1",
            releaseTargetId: "target-1",
            repositoryFullName: "example/repository",
            environment: "npm",
            runId: 2,
            status: "pending",
            decision: null,
            decisionComment: null,
            reportUrl: null,
            scanId: "scan-1",
            failureReason: null,
            organizationRequiresTwoFactor: false,
            packages: [],
            requestedAt: "2026-08-23T00:01:00.000Z",
            decidedAt: null,
            createdAt: "2026-08-23T00:01:00.000Z",
            updatedAt: "2026-08-23T00:01:00.000Z",
          },
          releaseAuthority: {
            capturedAt: "2026-08-23T00:01:00.000Z",
            runId: 2,
            workflowPath: ".github/workflows/release.yml",
            headSha: "new-head",
            artifactBindingDigest: "new-binding",
            approvedAt: null,
            acknowledgementToken: "new-token",
            delta: refreshedDelta,
            workflows: [],
            run: null,
          },
          organizationRequiresAuthorityApproval: true,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    model = new ScanDetailModel("scan-1");
    model.detail.value = scanDetail(persistedDelta);
    expect(model.reviewReleaseAuthority.value?.delta).toBe(persistedDelta);

    await model.loadGate();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/github-app/workflow-gates/by-scan/scan-1",
      expect.any(Object),
    );
    expect(model.gateAuthority.value?.acknowledgementToken).toBe("new-token");
    expect(model.reviewReleaseAuthority.value).toBe(model.gateAuthority.value);
    expect(model.reviewReleaseAuthority.value?.delta).toEqual(refreshedDelta);
  });

  test("binds a policy-off approval to the displayed authority revision", async () => {
    const delta = authorityDelta("displayed delta");
    const gate = {
      id: "gate-1",
      organizationId: "org-1",
      releaseTargetId: "target-1",
      repositoryFullName: "example/repository",
      environment: "npm",
      runId: 2,
      status: "pending",
      decision: null,
      decisionComment: null,
      reportUrl: null,
      scanId: "scan-1",
      failureReason: null,
      organizationRequiresTwoFactor: false,
      packages: [],
      requestedAt: "2026-08-23T00:01:00.000Z",
      decidedAt: null,
      createdAt: "2026-08-23T00:01:00.000Z",
      updatedAt: "2026-08-23T00:01:00.000Z",
    };
    let decisionBody: unknown;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/decision")) {
        decisionBody = JSON.parse(String(init?.body));
        return Promise.resolve(jsonResponse({ gate: { ...gate, status: "approved" } }));
      }
      if (url === "/api/v1/scans/scan-1") {
        return Promise.resolve(jsonResponse(scanDetail(delta)));
      }
      return Promise.resolve(
        jsonResponse({
          gate,
          releaseAuthority: {
            capturedAt: "2026-08-23T00:01:00.000Z",
            runId: 2,
            workflowPath: ".github/workflows/release.yml",
            headSha: "new-head",
            artifactBindingDigest: "new-binding",
            approvedAt: null,
            acknowledgementToken: "displayed-token",
            delta,
            workflows: [],
            run: null,
          },
          organizationRequiresAuthorityApproval: false,
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    model = new ScanDetailModel("scan-1");
    model.detail.value = scanDetail(delta);
    await model.loadGate();
    await model.decideGate("approved", null);

    expect(decisionBody).toEqual({
      scanId: "scan-1",
      decision: "approved",
      authorityAcknowledgementToken: "displayed-token",
    });
  });
});
