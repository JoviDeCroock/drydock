import { expect, test, type Page, type Route } from "@playwright/test";

const scanId = "gate-smoke-scan-000001";
const gateId = "gate-smoke-000001";
const now = "2026-06-15T12:00:00.000Z";

test("renders and decides a workflow-gate review", async ({ page }) => {
  await installWorkflowGateMocks(page);

  await page.goto(`/dashboard/scans/${scanId}`);

  await expect(page.getByRole("heading", { name: "@drydock/gate-demo" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("link", { name: "Drydock dashboard" })).toHaveAttribute(
    "href",
    "/dashboard",
  );
  await expect(page.getByText("Deployment gate")).toBeVisible();
  await expect(page.getByText("awaiting decision").first()).toBeVisible();
  await expect(page.getByText("drydock/example").first()).toBeVisible();
  await expect(page.getByText("Release packages")).toBeVisible();
  await expect(page.getByText("@drydock/sidecar@0.4.0")).toBeVisible();

  await page.getByRole("button", { name: "Decide", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Package decision" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve package" })).toBeVisible();
  await page.getByRole("button", { name: "Reject & block release" }).click();

  await expect(page.getByText("rejected · job blocked").first()).toBeVisible();
  await expect(page.getByText("blocked").first()).toBeVisible();
});

async function installWorkflowGateMocks(page: Page) {
  let packageDecision: "publish" | "no_publish" | null = null;
  let gateStatus: "pending" | "rejected" = "pending";

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/api/auth/get-session") {
      await fulfillJson(route, {
        user: {
          id: "user-smoke",
          name: "Smoke Tester",
          email: "smoke@example.test",
          twoFactorEnabled: false,
        },
      });
      return;
    }

    if (path === `/api/v1/scans/${scanId}`) {
      await fulfillJson(route, scanDetail(packageDecision));
      return;
    }

    if (path === `/api/v1/scans/${scanId}/versions`) {
      await fulfillJson(route, {
        packageName: "@drydock/gate-demo",
        stagedVersion: "1.2.0",
        defaultPreviousVersion: null,
        versions: [],
      });
      return;
    }

    if (path === `/api/v1/github-app/workflow-gates/by-scan/${scanId}`) {
      await fulfillJson(route, { gate: workflowGate(gateStatus, packageDecision) });
      return;
    }

    if (path === `/api/v1/github-app/workflow-gates/${gateId}/decision`) {
      expect(request.method()).toBe("POST");
      const body = JSON.parse(request.postData() || "{}") as {
        scanId?: string;
        decision?: string;
      };
      expect(body.scanId).toBe(scanId);
      expect(body.decision).toBe("rejected");
      packageDecision = "no_publish";
      gateStatus = "rejected";
      await fulfillJson(route, { gate: workflowGate(gateStatus, packageDecision) });
      return;
    }

    await fulfillJson(route, { error: `unexpected e2e smoke API request: ${path}` }, 404);
  });
}

function scanDetail(packageDecision: "publish" | "no_publish" | null) {
  return {
    scan: {
      id: scanId,
      stageId: `workflow-gate:${gateId}:pypi:@drydock/gate-demo`,
      source: "workflow_gate",
      organizationId: "org-smoke",
      ownerUserId: "user-smoke",
      packageName: "@drydock/gate-demo",
      stagedVersion: "1.2.0",
      previousVersion: "1.1.0",
      risk: "high",
      status: "complete",
      decision: packageDecision,
      decisionReason: null,
      decidedByUserId: packageDecision ? "user-smoke" : null,
      decidedAt: packageDecision ? now : null,
      changedFileCount: 1,
      findingCount: 1,
      riskSummary: riskSummary(),
      summaryJson: {
        report: {
          version: 1,
          digest: "a".repeat(64),
          digestAlgorithm: "sha256",
          generatedAt: now,
          rulesVersion: "smoke",
        },
        diff: [
          {
            path: "src/gate_demo/__init__.py",
            status: "added",
            stagedSize: 102,
            stagedSha256: "b".repeat(64),
            flags: [],
          },
        ],
      },
      aiJson: {
        status: "unavailable",
        risk: "low",
        releaseAssessment: "not_assessed",
        summary: "AI review unavailable for smoke fixture.",
        findings: [],
        requiresManualReview: false,
        model: null,
      },
      errorJson: null,
      reportVersion: 1,
      reportDigest: "a".repeat(64),
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    riskSummary: riskSummary(),
    files: [
      {
        id: "file-smoke-1",
        scanId,
        path: "src/gate_demo/__init__.py",
        status: "added",
        size: 102,
        sha256: "b".repeat(64),
        flagsJson: [],
        textSample:
          "import os\nimport urllib.request\nurllib.request.urlopen(os.environ['TOKEN'])\n",
      },
    ],
    findings: [
      {
        id: "finding-smoke-1",
        scanId,
        severity: "high",
        file: "src/gate_demo/__init__.py",
        evidence: "network call reads an environment secret",
        reason: "credential access and network egress appear in release-added code",
        line: 3,
        source: "deterministic",
        ruleId: "code.network-credential-exfil",
        ruleVersion: "smoke",
        diffStatus: "added",
        releaseDelta: true,
      },
    ],
    events: [],
  };
}

function riskSummary() {
  return {
    artifactRisk: "high",
    releaseRisk: "high",
    contextRisk: "low",
    releaseFindingCount: 1,
    contextFindingCount: 0,
    unknownFindingCount: 0,
  };
}

function workflowGate(
  status: "pending" | "rejected",
  packageDecision: "publish" | "no_publish" | null,
) {
  return {
    id: gateId,
    organizationId: "org-smoke",
    releaseTargetId: "target-smoke",
    repositoryFullName: "drydock/example",
    environment: "pypi",
    runId: 12345,
    status,
    decision: status === "rejected" ? "rejected" : null,
    decisionComment: null,
    reportUrl: null,
    scanId,
    failureReason: null,
    packages: [
      {
        scanId,
        packageName: "@drydock/gate-demo",
        version: "1.2.0",
        status: "complete",
        releaseRisk: "high",
        decision: packageDecision,
      },
      {
        scanId: "gate-smoke-sidecar-000001",
        packageName: "@drydock/sidecar",
        version: "0.4.0",
        status: "complete",
        releaseRisk: "low",
        decision: "publish",
      },
    ],
    requestedAt: now,
    decidedAt: status === "rejected" ? now : null,
    createdAt: now,
    updatedAt: now,
  };
}

async function fulfillJson(route: Route, json: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(json),
  });
}
