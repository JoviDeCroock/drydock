import { expect, test } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const appPort = Number(process.env.E2E_APP_PORT || process.env.CONDUCTOR_PORT || 5173);
const registryUrl = process.env.E2E_NPM_REGISTRY || `http://127.0.0.1:${appPort + 1}`;
const artifactsDir = path.resolve(".context/e2e-artifacts");
const journalPath = path.resolve(".context/e2e-registry/requests.jsonl");
const stageId = "stage-implicit-node-gyp-000001";

test("reviews a staged fixture from the local fake npm registry", async ({ page }) => {
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

  await page.locator("#stageId").fill(stageId);
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

  const journal = await readJournal();
  expect(journal.some((entry) => entry.path === "/-/whoami")).toBe(true);
  expect(journal.some((entry) => entry.path === "/-/stage?perPage=1")).toBe(true);
  expect(journal.some((entry) => entry.path === `/-/stage/${stageId}`)).toBe(true);
  expect(journal.some((entry) => entry.path === `/-/stage/${stageId}/tarball`)).toBe(true);
  expect(journal.some((entry) => entry.path.includes("/-/drydock-e2e-native-1.0.0.tgz"))).toBe(
    true,
  );

  for (const entry of journal.filter((item) => item.authorization === "present")) {
    expect(entry.path).toMatch(
      /^\/(?:-\/(?:whoami|stage(?:\?|\/))|@drydock(?:%2F|\/)e2e-native(?:$|\/-\/))/i,
    );
  }
});

async function readJournal(): Promise<
  Array<{ path: string; authorization: "present" | "absent"; status: number }>
> {
  const text = await readFile(journalPath, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
