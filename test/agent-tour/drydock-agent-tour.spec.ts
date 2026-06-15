import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const appPort = Number(process.env.E2E_APP_PORT || process.env.CONDUCTOR_PORT || 5173);
const registryUrl = process.env.E2E_NPM_REGISTRY || `http://127.0.0.1:${appPort + 1}`;
const tourDir = path.resolve(process.env.AGENT_TOUR_DIR || "agent-tour-output");
const screenshotsDir = path.join(tourDir, "screenshots");
const reportPath = path.join(tourDir, "report.md");
const exportedReportPath = path.join(tourDir, "exported-report.json");
const registryStateDir = path.resolve(
  process.env.E2E_REGISTRY_STATE_DIR || path.join(tourDir, "registry-state"),
);
const journalPath = path.join(registryStateDir, "requests.jsonl");
const playwrightReportDir = path.join(tourDir, "playwright-report");

interface ScanDetailBody {
  scan: {
    id: string;
    stageId: string;
    status: string;
    risk: string;
    packageName: string | null;
    stagedVersion: string | null;
    errorJson?: { code?: string; message?: string } | null;
  };
  riskSummary?: { artifactRisk: string; releaseRisk: string } | null;
  findings: Array<{ ruleId?: string | null; severity?: string | null; file?: string | null }>;
}

test("agent tour: local Drydock release review walkthrough", async ({
  page,
  baseURL,
}, testInfo) => {
  const tour = new TourReport(testInfo, baseURL ?? `http://127.0.0.1:${appPort}`);
  await tour.prepare(page);

  try {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "See exactly what your next publish ships." }),
    ).toBeVisible();
    await tour.capture(page, "landing", "Marketing entry point and product promise.");

    await page.goto("/docs");
    await expect(
      page.getByRole("heading", { name: "How Drydock guards a publish." }),
    ).toBeVisible();
    await tour.capture(page, "docs", "Setup documentation for staged publishing and gates.");

    await register(page);
    await expect(page.getByRole("heading", { name: "Ready for the next release" })).toBeVisible();
    await tour.capture(page, "dashboard-no-npm", "Fresh workspace before npm access is connected.");

    await connectNpmThroughSettings(page);
    await tour.capture(page, "settings-npm-connected", "Organization npm access saved and valid.");

    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Ready for the next release" })).toBeVisible();
    const reviewScan = await createScan(page, "stage-implicit-node-gyp-000001");
    tour.note(`Started targeted review scan ${reviewScan.scan.id}.`);
    await tour.capture(
      page,
      "dashboard-review-started",
      "Dashboard after starting a fixture scan.",
    );

    const completed = await pollScanUntilTerminal(page, reviewScan.scan.id);
    expect(completed.scan.status).toBe("complete");
    expect(completed.scan.packageName).toBe("@drydock/e2e-native");
    tour.note(
      `Completed ${completed.scan.packageName}@${completed.scan.stagedVersion} with release risk ${completed.riskSummary?.releaseRisk ?? completed.scan.risk}.`,
    );

    await page.goto(`/dashboard/scans/${reviewScan.scan.id}`);
    await expect(page.getByRole("heading", { name: "@drydock/e2e-native" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText("install-script.implicit-node-gyp").first()).toBeVisible();
    await tour.capture(page, "scan-report", "Completed report with recommendation and diff tree.");

    await page.getByPlaceholder("Filter files").fill("binding");
    await page
      .getByRole("complementary")
      .getByRole("button", { name: /binding\.gyp/ })
      .click();
    await expect(page).toHaveURL(/path=binding\.gyp/);
    await tour.capture(
      page,
      "diff-workbench",
      "File-level diff with the finding pinned to evidence.",
    );

    await page.getByText("Risk signals").scrollIntoViewIfNeeded();
    await tour.capture(page, "risk-signals", "Risk signal index below the diff workbench.");

    const download = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Export JSON" }).click(),
    ]).then(([file]) => file);
    await download.saveAs(exportedReportPath);
    tour.note(`Exported canonical report JSON to ${relative(exportedReportPath)}.`);

    await page.getByRole("button", { name: "Decide" }).click();
    await expect(page.getByRole("heading", { name: "Publish decision" })).toBeVisible();
    await page.getByLabel("Reason (optional)").fill("Agent tour: high-risk implicit node-gyp.");
    await tour.capture(page, "decision-dialog", "Maintainer decision dialog before blocking.");
    await page.getByRole("button", { name: "Block publish" }).click();
    await expect(page.getByText("blocked").first()).toBeVisible({ timeout: 30_000 });
    await tour.capture(page, "decision-recorded", "Audit decision recorded on the report.");

    const failedScan = await createScan(page, "stage-registry-failure-000001");
    const failed = await pollScanUntilTerminal(page, failedScan.scan.id);
    expect(failed.scan.status).toBe("failed");
    await page.goto(`/dashboard/scans/${failedScan.scan.id}`);
    await expect(page.getByText("code: sandbox_download_transient")).toBeVisible({
      timeout: 60_000,
    });
    await tour.capture(page, "failed-review", "Fail-closed review state for unavailable evidence.");

    await page.goto("/dashboard?filter=all");
    await expect(page.getByRole("button", { name: "Check npm" })).toBeEnabled({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Check npm" }).click();
    await expect(
      page.getByText(/Started \d+ new reviews? from npm|No open staged publishes found/),
    ).toBeVisible({ timeout: 60_000 });
    await tour.capture(page, "dashboard-discovery", "Manual npm discovery from the dashboard.");

    tour.pass();
  } catch (err) {
    tour.fail(err);
    await tour.capture(page, "failure", "State at the moment the tour failed.").catch(() => {});
    throw err;
  } finally {
    await tour.write();
  }
});

async function register(page: Page) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await page.goto("/register");
  await page.getByLabel("Name").fill("Agent Tour");
  await page.getByLabel("Email").fill(`agent-tour-${unique}@example.test`);
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 30_000 });
}

async function connectNpmThroughSettings(page: Page) {
  await page.goto("/dashboard/settings?tab=integrations");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Connection name").fill("Fake npm staging registry");
  await page.getByLabel("Registry").fill(registryUrl);
  await page.getByLabel("npm token").fill("npm_agent_tour_token_0123456789");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("valid").first()).toBeVisible({ timeout: 30_000 });
}

async function createScan(page: Page, stageId: string): Promise<{ scan: { id: string } }> {
  const { status, body } = await evaluateOnStablePage(
    page,
    async (inputStageId) => {
      const response = await fetch("/api/v1/scans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stageId: inputStageId }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    stageId,
  );
  expect(status, `${stageId} accepted`).toBe(202);
  expect(body?.scan?.id, `${stageId} scan id`).toBeTruthy();
  return body;
}

async function pollScanUntilTerminal(
  page: Page,
  scanId: string,
  timeoutMs = 120_000,
): Promise<ScanDetailBody> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: string | undefined;
  for (;;) {
    const { status, body } = await evaluateOnStablePage(
      page,
      async (id) => {
        const response = await fetch(`/api/v1/scans/${encodeURIComponent(id)}?poll=1`);
        return { status: response.status, body: await response.json().catch(() => null) };
      },
      scanId,
    );
    expect(status, `scan ${scanId} detail fetch`).toBe(200);
    const detail = body as ScanDetailBody;
    lastStatus = detail?.scan?.status;
    if (lastStatus === "complete" || lastStatus === "failed") return detail;
    if (Date.now() > deadline) {
      throw new Error(
        `scan ${scanId} did not reach a terminal status within ${timeoutMs}ms (last status: ${lastStatus})`,
      );
    }
    await page.waitForTimeout(1_000);
  }
}

async function evaluateOnStablePage<Arg, Result>(
  page: Page,
  pageFunction: (arg: Arg) => Promise<Result>,
  arg: Arg,
): Promise<Result> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await page.evaluate(pageFunction, arg);
    } catch (err) {
      if (!isNavigationContextError(err) || attempt === 2) throw err;
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    }
  }
  throw new Error("page evaluation failed");
}

function isNavigationContextError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("Execution context was destroyed") ||
    message.includes("Cannot find context with specified id")
  );
}

class TourReport {
  private screenshotIndex = 0;
  private status: "running" | "passed" | "failed" = "running";
  private failure: string | null = null;
  private readonly steps: Array<{ title: string; url: string; image: string; note: string }> = [];
  private readonly notes: string[] = [];
  private readonly browserEvents: string[] = [];

  constructor(
    private readonly testInfo: TestInfo,
    private readonly baseUrl: string,
  ) {}

  async prepare(page: Page) {
    await mkdir(screenshotsDir, { recursive: true });
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        this.browserEvents.push(`console.${message.type()}: ${message.text()}`);
      }
    });
    page.on("pageerror", (err) => {
      this.browserEvents.push(`pageerror: ${err.message}`);
    });
    page.on("requestfailed", (request) => {
      this.browserEvents.push(
        `requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown"})`,
      );
    });
  }

  async capture(page: Page, title: string, note: string) {
    const file = path.join(
      screenshotsDir,
      `${String(++this.screenshotIndex).padStart(2, "0")}-${slug(title)}.png`,
    );
    await page.screenshot({ path: file, fullPage: true });
    this.steps.push({ title, url: page.url(), image: relative(file), note });
    await this.testInfo.attach(title, { path: file, contentType: "image/png" });
  }

  note(message: string) {
    this.notes.push(message);
  }

  pass() {
    this.status = "passed";
  }

  fail(err: unknown) {
    this.status = "failed";
    this.failure = err instanceof Error ? err.stack || err.message : String(err);
  }

  async write() {
    const journal = await readJournalSummary();
    const lines = [
      "# Drydock Agent Tour",
      "",
      `Status: ${this.status}`,
      `App URL: ${this.baseUrl}`,
      `Fake registry: ${registryUrl}`,
      `Generated: ${new Date().toISOString()}`,
      "",
      "## Artifacts",
      "",
      `- Screenshots: ${relative(screenshotsDir)}`,
      `- Exported report JSON: ${relative(exportedReportPath)}`,
      `- Registry journal: ${relative(journalPath)}`,
      `- Playwright report: ${relative(playwrightReportDir)}/`,
      "",
      "## Walkthrough",
      "",
      ...this.steps.flatMap((step, index) => [
        `${index + 1}. ${step.title}`,
        `   - URL: ${step.url}`,
        `   - Screenshot: ${step.image}`,
        `   - Note: ${step.note}`,
      ]),
      "",
      "## Notes",
      "",
      ...(this.notes.length ? this.notes.map((note) => `- ${note}`) : ["- No extra notes."]),
      "",
      "## Browser Events",
      "",
      ...(this.browserEvents.length
        ? this.browserEvents.map((event) => `- ${event}`)
        : [
            "- No console warnings, console errors, page errors, or failed browser requests recorded.",
          ]),
      "",
      "## Registry Journal Summary",
      "",
      ...journal,
    ];
    if (this.failure) {
      lines.push("", "## Failure", "", "```text", this.failure, "```");
    }
    await writeFile(reportPath, `${lines.join("\n")}\n`);
  }
}

async function readJournalSummary() {
  const text = await readFile(journalPath, "utf8").catch(() => "");
  const entries = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { path: string; authorization: string; status: number });
  if (!entries.length) return ["- No registry requests recorded."];
  const authorized = entries.filter((entry) => entry.authorization === "present").length;
  const statusCounts = new Map<number, number>();
  for (const entry of entries) {
    statusCounts.set(entry.status, (statusCounts.get(entry.status) ?? 0) + 1);
  }
  return [
    `- Requests: ${entries.length}`,
    `- Requests with Authorization: ${authorized}`,
    `- Statuses: ${[...statusCounts].map(([status, count]) => `${status}=${count}`).join(", ")}`,
    `- First paths: ${entries
      .slice(0, 8)
      .map((entry) => entry.path)
      .join(", ")}`,
  ];
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function relative(filePath: string) {
  return path.relative(process.cwd(), filePath);
}
