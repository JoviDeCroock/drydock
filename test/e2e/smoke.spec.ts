import { expect, test, type Page, type Route } from "@playwright/test";

const scanId = "gate-smoke-scan-000001";
const gateId = "gate-smoke-000001";
const now = "2026-06-15T12:00:00.000Z";
const shareToken = "s".repeat(43);
const longFindingEvidence = `4278592 byte binary; sha256 ${"c".repeat(64)}`;

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

  const evidence = page.getByText(longFindingEvidence, { exact: true });
  await expect(evidence).toHaveCSS("overflow-wrap", "break-word");
  const evidenceSize = await evidence.evaluate((element) => ({
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
    scrollWidth: element.scrollWidth,
  }));
  expect(evidenceSize.clientHeight).toBeGreaterThan(evidenceSize.lineHeight);
  expect(evidenceSize.scrollWidth).toBeLessThanOrEqual(evidenceSize.clientWidth);

  const findingCard = evidence.locator("xpath=ancestor::li[1]");
  const cardWidth = await findingCard.evaluate(({ clientWidth, scrollWidth }) => ({
    clientWidth,
    scrollWidth,
  }));
  expect(cardWidth.scrollWidth).toBeLessThanOrEqual(cardWidth.clientWidth);

  await page.getByRole("button", { name: "Decide", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Package decision" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve package" })).toBeVisible();
  await page.getByRole("button", { name: "Reject & block release" }).click();

  await expect(page.getByText("rejected · job blocked").first()).toBeVisible();
  await expect(page.getByText("blocked").first()).toBeVisible();
});

// The public report is the one review surface with no session and no npm
// credentials, so its diff has to come entirely from the report export plus the
// share-token file route. Mocked here rather than driven through the seeded
// harness because a share token is the whole fixture.
test("a shared public report opens on the diff", async ({ page }) => {
  const fileRequests: string[] = [];
  await installPublicReportMocks(page, fileRequests, true);

  await page.goto(`/reports/${shareToken}`);

  await expect(page.getByRole("heading", { name: "@drydock/gate-demo" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Release risk: high")).toBeVisible();

  // The page selects the first changed file itself: landing a shared link on
  // "select a file" makes the reader hunt for the change.
  await expect(page.getByRole("heading", { name: "Release tree" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "File diff" })).toBeVisible();
  await expect(page.getByText("urllib.request.urlopen", { exact: false }).first()).toBeVisible();
  expect(fileRequests).toEqual(["src/gate_demo/__init__.py"]);

  // Deterministic findings ride the hunk, not a separate list.
  await expect(page.getByText("code.network-credential-exfil").first()).toBeVisible();

  // A binary body was never captured, so the panel says so instead of spinning
  // on a request that would only 404.
  await page.getByText("qrb.it.darwin-arm64.node").first().click();
  await expect(page.getByText("No text sample was retained for this file.")).toBeVisible();
  expect(fileRequests).toEqual(["src/gate_demo/__init__.py"]);
});

test("a legacy public report stays evidence-only", async ({ page }) => {
  const fileRequests: string[] = [];
  await installPublicReportMocks(page, fileRequests, false);

  await page.goto(`/reports/${shareToken}`);

  await expect(
    page.getByText("This link was created before shared file diffs were available.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Risk signals" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Release changes" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Release tree" })).toHaveCount(0);
  expect(fileRequests).toEqual([]);
});

async function installPublicReportMocks(
  page: Page,
  fileRequests: string[],
  includesFiles: boolean,
) {
  await page.route("**/api/**", async (route) => {
    await fulfillJson(route, {});
  });

  await page.route("**/public/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/public/attestation-key") {
      await fulfillJson(route, { error: "attestations are not configured" }, 503);
      return;
    }
    if (path === `/public/reports/${shareToken}`) {
      await fulfillJson(route, publicReportExport(), 200, {
        "x-drydock-share-includes-files": includesFiles ? "1" : "0",
      });
      return;
    }
    if (path === `/public/reports/${shareToken}/file`) {
      const requested = new URL(route.request().url()).searchParams.get("path") ?? "";
      fileRequests.push(requested);
      const file = publicReportExport().files.find((entry) => entry.path === requested);
      if (!file) {
        await fulfillJson(route, { error: "not found" }, 404);
        return;
      }
      await fulfillJson(route, { file });
      return;
    }
    await fulfillJson(route, { error: `unexpected public request: ${path}` }, 404);
  });
}

// The export shape `/public/reports/:token` serves, plus the samples the file
// route hands back one at a time (`files` is not part of the export itself).
function publicReportExport() {
  const detail = scanDetail(null);
  return {
    schema: "drydock.report.v2",
    scan: {
      id: scanId,
      status: "complete",
      source: "workflow_gate",
      risk: "high",
      decision: null,
      createdAt: now,
      completedAt: now,
    },
    package: { name: "@drydock/gate-demo", stagedVersion: "1.2.0", previousVersion: "1.1.0" },
    riskSummary: riskSummary(),
    diff: detail.scan.summaryJson.diff,
    findings: detail.findings.map((finding) => ({
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      ruleId: finding.ruleId,
      diffStatus: finding.diffStatus,
      releaseDelta: finding.releaseDelta,
      evidence: finding.evidence,
      reason: finding.reason,
    })),
    files: detail.files,
  };
}

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
      changedFileCount: 2,
      findingCount: 2,
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
          {
            path: "dist/qrb.it.darwin-arm64.node",
            status: "modified",
            stagedSize: 4_278_592,
            stagedSha256: "c".repeat(64),
            flags: ["binary"],
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
        path: "src/gate_demo/__init__.py",
        status: "added",
        size: 102,
        sha256: "b".repeat(64),
        flagsJson: [],
        textSample:
          "import os\nimport urllib.request\nurllib.request.urlopen(os.environ['TOKEN'])\n",
      },
      {
        path: "dist/qrb.it.darwin-arm64.node",
        status: "modified",
        size: 4_278_592,
        sha256: "c".repeat(64),
        flagsJson: ["binary"],
        textSample: null,
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
      {
        id: "finding-smoke-2",
        scanId,
        severity: "info",
        file: "dist/qrb.it.darwin-arm64.node",
        evidence: longFindingEvidence,
        reason: "large binary should be reviewed manually",
        line: null,
        source: "deterministic",
        ruleId: "file.large-binary",
        ruleVersion: "smoke",
        diffStatus: "modified",
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
    releaseFindingCount: 2,
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
    // One approval per package — the default policy, and what the smoke flow
    // asserts. Multi-party approval has its own coverage in test/workers.
    requiredApprovals: 1,
    packages: [
      {
        scanId,
        packageName: "@drydock/gate-demo",
        version: "1.2.0",
        status: "complete",
        releaseRisk: "high",
        decision: packageDecision,
        approvalCount: packageDecision === "publish" ? 1 : 0,
      },
      {
        scanId: "gate-smoke-sidecar-000001",
        packageName: "@drydock/sidecar",
        version: "0.4.0",
        status: "complete",
        releaseRisk: "low",
        decision: "publish",
        approvalCount: 1,
      },
    ],
    requestedAt: now,
    decidedAt: status === "rejected" ? now : null,
    createdAt: now,
    updatedAt: now,
  };
}

async function fulfillJson(
  route: Route,
  json: unknown,
  status = 200,
  headers?: Record<string, string>,
) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers,
    body: JSON.stringify(json),
  });
}
