import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const appPort = Number(process.env.E2E_APP_PORT || process.env.CONDUCTOR_PORT || 5173);
const registryUrl = process.env.E2E_NPM_REGISTRY || `http://127.0.0.1:${appPort + 1}`;
const artifactsDir = path.resolve(".context/e2e-artifacts");
const journalPath = path.resolve(".context/e2e-registry/requests.jsonl");
const registryStatePath = path.resolve(".context/e2e-registry/registry.json");
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

test("reviews staged fixtures from the local fake npm registry", async ({ page }) => {
  await registerAndConnect(page);
  await test.step("UI smoke: implicit node-gyp report", async () => {
    await page.locator("#stageId").fill(uiStageId);
    await page.getByRole("button", { name: "Review staged publish" }).click();
    await expect(page).toHaveURL(/\/dashboard\/scans\//, { timeout: 30_000 });

    await expect(page.getByRole("heading", { name: "@drydock/e2e-native" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText("release high").first()).toBeVisible();
    await expect(page.getByText("implicit install: node-gyp rebuild")).toBeVisible();
    await expect(page.getByText("install-script.implicit-node-gyp")).toBeVisible();

    await mkdir(artifactsDir, { recursive: true });
    await page.screenshot({
      path: path.join(artifactsDir, "implicit-node-gyp-report.png"),
      fullPage: true,
    });
  });

  const apiPage = await page.context().newPage();
  await apiPage.goto("/dashboard");
  await expect(apiPage.getByRole("heading", { name: "Ready for the next release" })).toBeVisible({
    timeout: 30_000,
  });
  try {
    const scenarios = (await readScenarios()).filter((scenario) => scenario.stageId !== uiStageId);
    for (const scenario of scenarios) {
      await test.step(`scenario: ${scenario.name}`, async () => {
        const response = await scanStage(apiPage, scenario.stageId);
        if (scenario.expected.errorStatus) {
          expect(response.status, scenario.name).toBe(scenario.expected.errorStatus);
          expect(String(response.body?.error ?? ""), scenario.name).toContain(
            scenario.expected.errorIncludes,
          );
          return;
        }

        expect(response.status, scenario.name).toBe(200);
        assertScanMatchesScenario(response.body, scenario);
      });
    }
  } finally {
    await apiPage.close();
  }

  await test.step("registry journal", async () => {
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
});

async function registerAndConnect(page: Page) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `e2e-${unique}@example.test`;

  await page.goto("/register");
  await page.getByLabel("Name").fill("E2E Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("heading", { name: "Ready for the next release" })).toBeVisible({
    timeout: 30_000,
  });

  await page.getByLabel("Connection name").fill("Fake npm staging registry");
  await page.getByLabel("Registry").fill(registryUrl);
  await page.getByLabel(/npm token/i).fill("npm_e2e_token_0123456789");

  const validation = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/npm-connection/validate") && response.status() === 200,
  );
  await page.getByRole("button", { name: "Save" }).click();
  await validation;
  await expect(page.getByText("valid").first()).toBeVisible();
}

async function scanStage(page: Page, stageId: string): Promise<{ status: number; body: any }> {
  return page.evaluate(async (inputStageId) => {
    const response = await fetch("/api/v1/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stageId: inputStageId }),
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  }, stageId);
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

async function readScenarios(): Promise<RegistryScenario[]> {
  const text = await readFile(registryStatePath, "utf8");
  const registry = JSON.parse(text) as { scenarios: RegistryScenario[] };
  return registry.scenarios.sort((left, right) => {
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
