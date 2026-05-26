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
    packageName?: string;
    stagedVersion?: string;
    previousVersion?: string | null;
    ruleIds?: string[];
    baseline?: Record<string, unknown>;
    errorStatus?: number;
    errorIncludes?: string;
  };
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

    await page.locator("#stageId").fill(uiStageId);
    const reviewButton = page.getByRole("button", { name: "Review staged publish" });
    await expect(reviewButton).toBeEnabled();
    await reviewButton.click();
    await expect(page).toHaveURL(/\/dashboard\/scans\//, { timeout: 30_000 });

    await expect(page.getByRole("heading", { name: "@drydock/e2e-native" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText("release high").first()).toBeVisible();
    await expect(page.getByText("implicit install: node-gyp rebuild")).toBeVisible();
    await expect(page.getByText("install-script.implicit-node-gyp")).toBeVisible();

    await page.screenshot({
      path: path.join(artifactsDir, "implicit-node-gyp-report.png"),
      fullPage: true,
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

      const response = await scanStage(page, scenario.stageId);
      if (scenario.expected.errorStatus) {
        expect(response.status, scenario.name).toBe(scenario.expected.errorStatus);
        expect(String(response.body?.error ?? ""), scenario.name).toContain(
          scenario.expected.errorIncludes,
        );
        return;
      }

      expect(response.status, scenario.name).toBe(200);
      assertScanMatchesScenario(response.body, scenario);
    } finally {
      await context.close();
    }
  });
}

test("registry journal limits credential forwarding", async () => {
  const journal = await readJournal();
  expect(journal.some((entry) => entry.path === "/-/whoami")).toBe(true);
  expect(journal.some((entry) => entry.path === "/-/stage?perPage=1")).toBe(true);
  expect(journal.some((entry) => entry.path === `/-/stage/${uiStageId}`)).toBe(true);
  expect(journal.some((entry) => entry.path === `/-/stage/${uiStageId}/tarball`)).toBe(true);
  expect(journal.some((entry) => entry.path.includes("/-/drydock-e2e-native-1.0.0.tgz"))).toBe(
    true,
  );

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

async function scanStage(page: Page, stageId: string): Promise<{ status: number; body: any }> {
  return evaluateOnStablePage(
    page,
    async (inputStageId) => {
      const response = await fetch("/api/v1/scan", {
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

function assertScanMatchesScenario(result: any, scenario: RegistryScenario) {
  const expected = scenario.expected;
  expect(result.stageId, scenario.name).toBe(scenario.stageId);
  expect(result.risk, scenario.name).toBe(expected.releaseRisk);
  expect(result.riskSummary?.releaseRisk, scenario.name).toBe(expected.releaseRisk);
  expect(result.package?.name, scenario.name).toBe(expected.packageName ?? scenario.packageName);
  if ("stagedVersion" in expected) {
    expect(result.package?.stagedVersion, scenario.name).toBe(expected.stagedVersion);
  }
  if ("previousVersion" in expected) {
    expect(result.package?.previousVersion, scenario.name).toBe(expected.previousVersion);
  }
  if (expected.baseline) {
    expect(result.baseline, scenario.name).toMatchObject(expected.baseline);
  }

  const ruleIds = result.ruleFindings
    .map((finding: { ruleId?: string }) => finding.ruleId)
    .filter(Boolean);
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
      const leftFails = left.expected.errorStatus ? 1 : 0;
      const rightFails = right.expected.errorStatus ? 1 : 0;
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
