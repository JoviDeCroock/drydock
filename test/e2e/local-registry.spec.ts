import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const appPort = Number(process.env.E2E_APP_PORT || process.env.CONDUCTOR_PORT || 5173);
const registryUrl = process.env.E2E_NPM_REGISTRY || `http://127.0.0.1:${appPort + 1}`;
const artifactsDir = path.resolve(".context/e2e-artifacts");
const authStatePath = path.join(artifactsDir, "auth-state.json");
const journalPath = path.resolve(".context/e2e-registry/requests.jsonl");
const scenariosRoot = path.resolve("test/e2e-fixtures/scenarios");
const uiStageId = "stage-implicit-node-gyp-000001";

interface RegistryScenario {
  name: string;
  stageId: string;
  packageName: string;
  expected: {
    releaseRisk?: string;
    artifactRisk?: string;
    packageName?: string | null;
    stagedVersion?: string;
    previousVersion?: string | null;
    ruleIds?: string[];
    baseline?: Record<string, unknown>;
    errorCode?: string;
    errorIncludes?: string;
  };
}

// Shape returned by GET /api/v1/scans/:id — mirrors PersistedScanDetail in
// src/models/scan.ts (the contract the browser UI actually consumes).
interface ScanDetailBody {
  scan: {
    id: string;
    stageId: string;
    status: string;
    risk: string;
    packageName: string | null;
    stagedVersion: string | null;
    previousVersion: string | null;
    summaryJson?: { baseline?: Record<string, unknown> } | null;
    errorJson?: { code?: string; message?: string } | null;
  };
  riskSummary?: { artifactRisk: string; releaseRisk: string } | null;
  findings: Array<{ ruleId?: string | null }>;
}

const scenarios = readScenarioDefinitions();

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser, baseURL }) => {
  await mkdir(artifactsDir, { recursive: true });
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await registerAndConnect(page);
  await context.storageState({ path: authStatePath });
  await context.close();
});

test("UI smoke: reviews the implicit node-gyp fixture", async ({ browser, baseURL }) => {
  const { context, page } = await openAuthenticatedPage(browser, baseURL);
  try {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Ready for the next release" })).toBeVisible({
      timeout: 30_000,
    });

    // Run the report assertions first via the async scan API. Check npm fans
    // out nine concurrent background scans on the dev Worker, and CI's workerd
    // serializes them so badly that one scan can take minutes to surface a
    // report — waiting for this scan to finish before that contention starts
    // keeps the test reliable.
    const created = await createScan(page, uiStageId);
    expect(created.status, "implicit-node-gyp scan accepted").toBe(202);
    const scanId = created.body?.scan?.id;
    expect(scanId, "scan id present in create-scan response").toBeTruthy();
    expect(typeof created.body?.queued, "queued flag present").toBe("boolean");

    const detail = await pollScanUntilTerminal(page, String(scanId));
    expect(detail.scan.status, "implicit-node-gyp scan completed").toBe("complete");

    await page.goto(`/dashboard/scans/${scanId}`);
    await expect(page.getByRole("heading", { name: "@drydock/e2e-native" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText("release high").first()).toBeVisible();
    // Deterministic findings now render both pinned inline on the diff and in
    // the risk-signals index, so the evidence/reason and rule id can each match
    // more than one node — assert the first like the release-risk badge above.
    await expect(page.getByText("implicit install: node-gyp rebuild").first()).toBeVisible();
    await expect(page.getByText("install-script.implicit-node-gyp").first()).toBeVisible();
    // The file tree carries a severity-toned finding count badge for the flagged
    // file (#188 surface 2); the fixture has a single finding on binding.gyp.
    await expect(page.getByLabel("1 finding").first()).toBeVisible();

    await page.screenshot({
      path: path.join(artifactsDir, "implicit-node-gyp-report.png"),
      fullPage: true,
    });

    // Now exercise Check npm as the live entry point. The button kicks off
    // discovery and we wait only for the "Started N new reviews" message —
    // the resulting background scans are exercised by the scenarios below.
    await page.goto("/dashboard");
    const checkNpm = page.getByRole("button", { name: "Check npm" });
    await expect(checkNpm).toBeEnabled({ timeout: 30_000 });
    await checkNpm.click();
    await expect(page.getByText(/Started \d+ new reviews? from npm/)).toBeVisible({
      timeout: 60_000,
    });
  } finally {
    await context.close();
  }
});

for (const scenario of scenarios.filter((item) => item.stageId !== uiStageId)) {
  test(`scenario: ${scenario.name}`, async ({ browser, baseURL }) => {
    const { context, page } = await openAuthenticatedPage(browser, baseURL);
    try {
      await page.goto("/dashboard");
      await expect(page.getByRole("heading", { name: "Ready for the next release" })).toBeVisible({
        timeout: 30_000,
      });

      const created = await createScan(page, scenario.stageId);
      expect(created.status, scenario.name).toBe(202);
      const scanId = created.body?.scan?.id;
      expect(scanId, `${scenario.name}: scan id present`).toBeTruthy();

      const detail = await pollScanUntilTerminal(page, String(scanId));
      if (scenario.expected.errorCode) {
        expect(detail.scan.status, scenario.name).toBe("failed");
        expect(detail.scan.errorJson?.code, scenario.name).toBe(scenario.expected.errorCode);
        expect(String(detail.scan.errorJson?.message ?? ""), scenario.name).toContain(
          scenario.expected.errorIncludes,
        );
        return;
      }

      expect(detail.scan.status, scenario.name).toBe("complete");
      assertScanMatchesScenario(detail, scenario);
    } finally {
      await context.close();
    }
  });
}

test("release reconciliation: a stage approved on npm resolves its scan", async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await openAuthenticatedPage(browser, baseURL);
  try {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Ready for the next release" })).toBeVisible({
      timeout: 30_000,
    });

    // The benign-diff scan completed undecided in the scenario test above.
    const releasedStageId = "stage-benign-diff-000001";

    // "Approve" the stage on the fake registry: it vanishes from the stage
    // listing and the staged version appears in the packument, exactly like a
    // maintainer running the npm-side approval with their OTP.
    const control = await fetch(`${registryUrl}/__control/release/${releasedStageId}`, {
      method: "POST",
    });
    expect(control.status, "fake-registry control release").toBe(200);

    // A manual discovery sweep runs the same reconciliation as the cron.
    const sweepStatus = await evaluateOnStablePage(
      page,
      async () => {
        const response = await fetch("/api/v1/staged-publishes/scan", { method: "POST" });
        return response.status;
      },
      undefined,
    );
    expect(sweepStatus, "manual discovery sweep accepted").toBe(202);

    const listScans = async (filter: string) =>
      evaluateOnStablePage(
        page,
        async (inputFilter) => {
          const response = await fetch(`/api/v1/scans?filter=${inputFilter}&limit=50`);
          const body = await response.json().catch(() => null);
          return { status: response.status, body };
        },
        filter,
      );

    const all = await listScans("all");
    expect(all.status).toBe(200);
    const released = (
      all.body.scans as Array<{
        id: string;
        stageId: string;
        releaseStatus?: string | null;
        releasedAt?: string | null;
      }>
    ).find((scan) => scan.stageId === releasedStageId);
    expect(released?.releaseStatus, "scan resolved as released").toBe("released");
    expect(released?.releasedAt, "release timestamp recorded").toBeTruthy();

    // Released scans leave the review queue without a human decision.
    const undecided = await listScans("undecided");
    expect(undecided.status).toBe(200);
    const undecidedIds = (undecided.body.scans as Array<{ id: string }>).map((scan) => scan.id);
    expect(undecidedIds, "released scan left the review queue").not.toContain(released?.id);

    // The detail header surfaces the auto-detected outcome.
    await page.goto(`/dashboard/scans/${released?.id}`);
    await expect(page.getByText("released on npm")).toBeVisible({ timeout: 30_000 });
  } finally {
    await context.close();
  }
});

test("registry journal limits credential forwarding", async () => {
  const journal = await readJournal();
  expect(journal.some((entry) => entry.path === "/-/whoami")).toBe(true);
  expect(journal.some((entry) => entry.path === "/-/stage?perPage=1")).toBe(true);
  expect(journal.some((entry) => entry.path === `/-/stage/${uiStageId}`)).toBe(true);
  expect(journal.some((entry) => entry.path === `/-/stage/${uiStageId}/tarball`)).toBe(true);
  expect(journal.some((entry) => entry.path.includes("/-/drydock-e2e-native-1.0.0.tgz"))).toBe(
    true,
  );

  for (const entry of journal.filter((item) => item.path !== "/__health")) {
    expect(entry.authorization, entry.path).toBe("present");
  }

  for (const entry of journal.filter((item) => item.authorization === "present")) {
    expect(entry.path).toMatch(
      /^\/(?:-\/(?:whoami|stage(?:\?|\/))|@drydock(?:%2F|\/)[^/]+(?:$|\/-\/))/i,
    );
  }
});

async function registerAndConnect(page: Page) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-${unique}@example.test`;

  await page.goto("/register");
  await page.getByLabel("Name").fill("E2E Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 30_000 });

  await expect(page.getByRole("heading", { name: "Ready for the next release" })).toBeVisible({
    timeout: 30_000,
  });

  await evaluateOnStablePage(
    page,
    async (input) => {
      const save = await fetch("/api/v1/npm-connection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!save.ok) {
        throw new Error(`npm connection save failed: ${save.status} ${await save.text()}`);
      }

      const validate = await fetch("/api/v1/npm-connection/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stageId: "stage-benign-diff-000001" }),
      });
      const body = await validate.json().catch(() => null);
      if (!validate.ok || !body?.validation?.ok) {
        throw new Error(
          `npm connection validation failed: ${validate.status} ${await validate.text()}`,
        );
      }
    },
    {
      label: "Fake npm staging registry",
      registryUrl,
      token: "npm_e2e_token_0123456789",
    },
  );
}

async function openAuthenticatedPage(
  browser: Browser,
  baseURL: string | undefined,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL, storageState: authStatePath });
  const page = await context.newPage();
  return { context, page };
}

async function createScan(page: Page, stageId: string): Promise<{ status: number; body: any }> {
  return evaluateOnStablePage(
    page,
    async (inputStageId) => {
      const response = await fetch("/api/v1/scans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stageId: inputStageId }),
      });
      const body = await response.json().catch(() => null);
      return { status: response.status, body };
    },
    stageId,
  );
}

// Poll the persisted detail route the way the dashboard does (?poll=1 skips
// the scan.viewed audit event) until the background job reaches a terminal
// status. The deadline stays inside the 90s Playwright test timeout so a stuck
// scan fails with the last observed status instead of an opaque test timeout.
async function pollScanUntilTerminal(
  page: Page,
  scanId: string,
  timeoutMs = 80_000,
): Promise<ScanDetailBody> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: string | undefined;
  for (;;) {
    const { status, body } = await evaluateOnStablePage(
      page,
      async (id) => {
        const response = await fetch(`/api/v1/scans/${encodeURIComponent(id)}?poll=1`);
        const body = await response.json().catch(() => null);
        return { status: response.status, body };
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
      await waitForSettledNavigation(page);
    }
  }
  throw new Error("page evaluation failed");
}

async function waitForSettledNavigation(page: Page) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
}

function isNavigationContextError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("Execution context was destroyed") ||
    message.includes("Cannot find context with specified id")
  );
}

function assertScanMatchesScenario(detail: ScanDetailBody, scenario: RegistryScenario) {
  const expected = scenario.expected;
  expect(detail.scan.stageId, scenario.name).toBe(scenario.stageId);
  expect(detail.scan.risk, scenario.name).toBe(expected.artifactRisk ?? expected.releaseRisk);
  expect(detail.riskSummary?.artifactRisk, scenario.name).toBe(
    expected.artifactRisk ?? expected.releaseRisk,
  );
  expect(detail.riskSummary?.releaseRisk, scenario.name).toBe(expected.releaseRisk);
  expect(detail.scan.packageName, scenario.name).toBe(
    "packageName" in expected ? expected.packageName : scenario.packageName,
  );
  if ("stagedVersion" in expected) {
    expect(detail.scan.stagedVersion, scenario.name).toBe(expected.stagedVersion ?? null);
  }
  if ("previousVersion" in expected) {
    expect(detail.scan.previousVersion, scenario.name).toBe(expected.previousVersion ?? null);
  }
  if (expected.baseline) {
    expect(detail.scan.summaryJson?.baseline, scenario.name).toMatchObject(expected.baseline);
  }

  const ruleIds = detail.findings.map((finding) => finding.ruleId).filter(Boolean);
  const expectedRuleIds = expected.ruleIds ?? [];
  expect(ruleIds, scenario.name).toEqual(expect.arrayContaining(expectedRuleIds));
  if (expectedRuleIds.length === 0) {
    expect(ruleIds, scenario.name).toHaveLength(0);
  }
}

function readScenarioDefinitions(): RegistryScenario[] {
  return readdirSync(scenariosRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const text = readFileSync(path.join(scenariosRoot, entry.name, "scenario.json"), "utf8");
      return { ...JSON.parse(text), name: entry.name } as RegistryScenario;
    })
    .sort((left, right) => {
      const leftFails = left.expected.errorCode ? 1 : 0;
      const rightFails = right.expected.errorCode ? 1 : 0;
      return leftFails - rightFails || left.name.localeCompare(right.name);
    });
}

async function readJournal(): Promise<
  Array<{ path: string; authorization: "present" | "absent"; status: number }>
> {
  const text = await readFile(journalPath, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
