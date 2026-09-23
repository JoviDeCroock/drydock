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

/**
 * The scan the UI smoke test reviews, handed to the public-report test below.
 * Serial mode makes the order a guarantee; the scan cap is why it is reused
 * rather than remade.
 */
let reviewedScanId: string | null = null;

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
    reviewedScanId = String(scanId);

    const detail = await pollScanUntilTerminal(page, String(scanId));
    expect(detail.scan.status, "implicit-node-gyp scan completed").toBe("complete");

    await page.goto(`/dashboard/scans/${scanId}`);
    await expect(page.getByRole("heading", { name: "@drydock/e2e-native" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText("release risk high").first()).toBeVisible();
    // Review notes disclose duplicate evidence on demand; verify the always-visible risk index.
    await expect(
      page.locator("#risk-signals").getByText("implicit install: node-gyp rebuild").first(),
    ).toBeVisible();
    await expect(
      page.locator("#risk-signals").getByText("install-script.implicit-node-gyp").first(),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Artifact verification" })).toBeVisible();
    await expect(page.getByText("verified", { exact: true })).toBeVisible();
    // The file tree carries a severity-toned finding count badge for the flagged
    // file (#188 surface 2); the fixture has a single finding on binding.gyp.
    await expect(page.getByLabel("1 finding").first()).toBeVisible();

    // The manifest diff links added/bumped dependencies to their own public
    // diff view in a new tab: the added dep resolves through the package-only
    // form, the major bump links its floor-to-floor version pair directly.
    const addedDepLink = page.getByRole("link", {
      name: "Open the peace-banner package diff in a new tab",
    });
    await expect(addedDepLink).toBeVisible();
    await expect(addedDepLink).toHaveAttribute("href", "/diff/peace-banner");
    await expect(addedDepLink).toHaveAttribute("target", "_blank");
    const bumpedDepLink = page.getByRole("link", {
      name: "Open the event-pubsub package diff in a new tab",
    });
    await expect(bumpedDepLink).toHaveAttribute("href", "/diff/event-pubsub/4.3.0/5.0.0");
    await expect(bumpedDepLink).toHaveAttribute("target", "_blank");

    await page.screenshot({
      path: path.join(artifactsDir, "implicit-node-gyp-report.png"),
      fullPage: true,
    });

    // Record a decision without the "open npm" hand-off. The reviewer still has
    // to finish the publish on npm, so the follow-up hands them the exact CLI
    // command for this stage instead of leaving them to look it up.
    await page.getByRole("button", { name: "Decide" }).click();
    const decisionDialog = page.getByRole("dialog").filter({ hasText: "Publish decision" });
    await expect(decisionDialog).toBeVisible();
    // The fake registry is custom, so npmjs.com cannot complete this release.
    // The web hand-off is omitted and the follow-up command stays pinned to the
    // registry that supplied the stage.
    await expect(decisionDialog.getByRole("checkbox")).toHaveCount(0);
    await decisionDialog.getByRole("button", { name: "Approve publish" }).click();

    const commandDialog = page.getByRole("dialog").filter({ hasText: "Finish the publish on npm" });
    await expect(commandDialog).toBeVisible({ timeout: 30_000 });
    await expect(
      commandDialog.getByText(`npm stage approve ${uiStageId} --registry '${registryUrl}'`, {
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({ path: path.join(artifactsDir, "stage-command-dialog.png") });
    await commandDialog.getByRole("button", { name: "Done" }).click();
    await expect(commandDialog).toBeHidden();

    // Now exercise Check npm as the live entry point. The button kicks off
    // discovery and we wait only for the "Started N new reviews" message —
    // the resulting background scans are exercised by the scenarios below.
    await page.goto("/dashboard");
    const checkNpm = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Recent reviews", exact: true }) })
      .getByRole("button", { name: "Check npm", exact: true });
    await expect(checkNpm).toBeEnabled({ timeout: 30_000 });
    await checkNpm.click();
    await expect(page.getByText(/Started \d+ new reviews? from npm/)).toBeVisible({
      timeout: 60_000,
    });
  } finally {
    await context.close();
  }
});

// The public report is the only review surface with no session and no npm
// credentials. Local development served the SPA shell for `/public/*` until
// #666, so this path could only be exercised with route mocks: the page
// rendered and the Worker route never ran. Drive the real one — share the
// release the smoke test just reviewed, then read it back from a context
// carrying no cookies.
//
// It shares that scan rather than making one of its own because the suite has
// no budget for another: scans are capped at ORGANIZATION_SCAN_LIMIT per
// organization per hour, and the smoke test plus one scan per scenario already
// spend exactly that. A fresh organization would cost a sign-up instead, and
// that cap (5 per IP per hour) is tighter still — two suite runs in an hour
// would stop registering. Serial mode makes the ordering a guarantee.
test("a shared review is readable as an anonymous public report", async ({ browser, baseURL }) => {
  expect(
    reviewedScanId,
    "no reviewed scan — this test shares the one the UI smoke test creates, so it cannot run " +
      "on its own (a --grep that excludes the smoke test lands here)",
  ).toBeTruthy();

  const { context, page } = await openAuthenticatedPage(browser, baseURL);
  let token = "";
  try {
    await page.goto("/dashboard");
    const shared = await evaluateOnStablePage(
      page,
      async (id) => {
        const response = await fetch(`/api/v1/scans/${encodeURIComponent(id)}/share`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        const body = (await response.json().catch(() => null)) as {
          share?: { token?: string; includesFiles?: boolean };
        } | null;
        return { status: response.status, body };
      },
      String(reviewedScanId),
    );
    expect(shared.status, "share link created").toBe(200);
    token = String(shared.body?.share?.token ?? "");
    expect(token, "share token minted").not.toHaveLength(0);
    expect(shared.body?.share?.includesFiles, "a new share discloses file samples").toBe(true);
  } finally {
    await context.close();
  }

  const anonymous = await browser.newContext({ baseURL });
  try {
    const report = await anonymous.request.get(`/public/reports/${token}`);
    expect(report.status()).toBe(200);
    // Vite's SPA fallback answers 200 too, so the content type is what tells a
    // served report apart from the app shell standing in for one.
    expect(
      report.headers()["content-type"],
      "the Worker answers, not Vite's SPA fallback",
    ).toContain("application/json");
    expect(report.headers()["x-drydock-share-includes-files"]).toBe("1");
    const body = (await report.json()) as {
      schema: string;
      diff: Array<{ path: string; status: string }>;
    };
    expect(body.schema).toBe("drydock.report.v2");

    // A named fixture file, not whichever diff entry sorts first: the diff comes
    // from the summary while the sample comes from the persisted files artifact,
    // so an entry with no retained sample would fail this as a missing route.
    const sampledPath = "binding.gyp";
    expect(
      body.diff.map((file) => file.path),
      "the fixture still ships the file this asserts on",
    ).toContain(sampledPath);
    const sampled = await anonymous.request.get(
      `/public/reports/${token}/file?path=${encodeURIComponent(sampledPath)}`,
    );
    expect(sampled.status(), "redacted file sample served").toBe(200);
    const sample = (await sampled.json()) as { file: { path: string; textSample: string } };
    expect(sample.file.path).toBe(sampledPath);
    expect(sample.file.textSample, "the sample carries the reviewed bytes").toContain(
      "target_name",
    );

    // Uniform not-found: an unknown token and a path this review does not
    // contain are one indistinguishable answer, so neither route is an oracle
    // for the token space or for a package's file list.
    for (const missingUrl of [
      `/public/reports/${"z".repeat(43)}`,
      `/public/reports/${token}/file?path=no/such/file.txt`,
    ]) {
      const missing = await anonymous.request.get(missingUrl);
      expect(missing.status(), missingUrl).toBe(404);
      expect(await missing.json(), missingUrl).toEqual({ error: "not found" });
    }

    // The URL a maintainer actually pastes around renders from those responses.
    // Locally the document itself is Vite's shell rather than the prerendered
    // one `assetFallbackRequest` serves in production; what this covers is the
    // page driving the real public endpoints with no session.
    const reader = await anonymous.newPage();
    await reader.goto(`/reports/${token}`);
    await expect(reader.getByRole("heading", { name: "@drydock/e2e-native" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(reader.getByRole("heading", { name: "File diff" })).toBeVisible();
    await expect(reader.getByText("install-script.implicit-node-gyp").first()).toBeVisible();
  } finally {
    await anonymous.close();
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

        await page.goto(`/dashboard/scans/${scanId}`);
        await expect(page.getByRole("heading", { name: scenario.packageName })).toBeVisible({
          timeout: 30_000,
        });
        // A review that failed never wrote a report, so its timeline can only
        // know the stage's creation time from the scan row.
        await expect(page.getByText("Staged on npm")).toBeVisible();
        await page.getByRole("button", { name: "Delete review" }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByRole("heading", { name: "Delete failed review?" })).toBeVisible();
        await dialog.getByRole("button", { name: "Delete review" }).click();
        await page.waitForURL(/\/dashboard(?:\?|$)/);

        const deletedStatus = await evaluateOnStablePage(
          page,
          async (id) =>
            fetch(`/api/v1/scans/${encodeURIComponent(id)}?poll=1`).then((res) => res.status),
          String(scanId),
        );
        expect(deletedStatus, `${scenario.name}: deleted scan is gone`).toBe(404);
        return;
      }

      expect(detail.scan.status, scenario.name).toBe("complete");
      assertScanMatchesScenario(detail, scenario);
    } finally {
      await context.close();
    }
  });
}

test("publication monitor observes an unreviewed public release", async ({ browser, baseURL }) => {
  const { context, page } = await openAuthenticatedPage(browser, baseURL);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("requestfailed", (request) =>
    browserErrors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`),
  );
  try {
    await page.goto("/dashboard");
    const monitor = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: /^Publication monitor/ }) });
    await expect(monitor.getByLabel("Public npm package")).toBeEnabled();
    await monitor.getByLabel("Public npm package").fill("@drydock/e2e-publication");
    await monitor.getByRole("button", { name: "Watch package", exact: true }).click();
    await expect(monitor.getByText("@drydock/e2e-publication", { exact: true })).toBeVisible();
    // Materialize the fixture release after enrollment and before the check;
    // its stable registry timestamp must not appear to be in the future.
    const published = await fetch(`${registryUrl}/@drydock%2Fe2e-publication`);
    expect(published.ok).toBe(true);
    await published.json();
    const publicationRow = monitor
      .locator("li")
      .filter({ has: page.getByText("@drydock/e2e-publication", { exact: true }) });
    await publicationRow.getByRole("button", { name: "Check releases", exact: true }).click();
    await expect(
      monitor.getByText("Published with no approval in this organization", { exact: true }),
    ).toBeVisible();
    await expect(monitor.getByText("1.0.0", { exact: true })).toBeVisible();
    await expect(monitor.getByRole("link", { name: "Open review" })).toHaveCount(0);
    await expect(publicationRow.getByText("1 unacknowledged alert", { exact: true })).toBeVisible();
    await monitor.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(artifactsDir, "publication-monitor-unacknowledged.png"),
      fullPage: true,
    });
    // The card links the package to its page, which shows the same watch and
    // alert and acknowledges it there.
    await publicationRow
      .getByRole("link", { name: "@drydock/e2e-publication", exact: true })
      .click();
    await expect(page).toHaveURL(/\/dashboard\/packages\/@drydock\/e2e-publication/);
    const packageMonitor = page.getByRole("region", { name: "Publication monitor" });
    await expect(packageMonitor.getByText("1 unacknowledged alert", { exact: true })).toBeVisible();
    await expect(packageMonitor.getByText(/added by hand · watching since/)).toBeVisible();
    await expect(
      packageMonitor.getByText("Published with no approval in this organization", { exact: true }),
    ).toBeVisible();
    await packageMonitor.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(artifactsDir, "publication-monitor-package-page.png"),
      fullPage: true,
    });
    await packageMonitor.getByRole("button", { name: "Acknowledge", exact: true }).click();
    await expect(packageMonitor.getByText(/^Acknowledged /)).toBeVisible();
    await expect(packageMonitor.getByText("watching", { exact: true })).toBeVisible();
    await expect(
      packageMonitor.getByRole("button", { name: "Acknowledge", exact: true }),
    ).toHaveCount(0);
    await page.goto("/dashboard");
    await expect(publicationRow.getByText("1 unacknowledged alert", { exact: true })).toHaveCount(
      0,
    );
    await publicationRow.getByRole("button", { name: "Check releases", exact: true }).click();
    await expect(monitor.getByText(/^Acknowledged /)).toBeVisible();
    await expect(
      monitor.getByText("Published with no approval in this organization", { exact: true }),
    ).toBeVisible();
    await monitor.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(artifactsDir, "publication-monitor.png"),
      fullPage: true,
    });
    await monitor
      .getByRole("button", { name: "More actions for @drydock/e2e-publication" })
      .click();
    await page.getByRole("menuitem", { name: "Stop watching", exact: true }).click();
    // Stopping confirms first and says the alert history survives it.
    const stopDialog = page.getByRole("dialog", {
      name: "Stop watching @drydock/e2e-publication?",
    });
    await expect(stopDialog.getByText(/stay listed on the package's page/)).toBeVisible();
    await stopDialog.getByRole("button", { name: "Stop watching", exact: true }).click();
    await expect(monitor.getByText("@drydock/e2e-publication", { exact: true })).toHaveCount(0);
    // The acknowledged alert is still on the package's page after the stop.
    await page.goto("/dashboard/packages/@drydock/e2e-publication");
    const stoppedMonitor = page.getByRole("region", { name: "Publication monitor" });
    await expect(stoppedMonitor.getByText(/^Not watched\. Monitoring was stopped/)).toBeVisible();
    await expect(
      stoppedMonitor.getByText("Alerts from earlier watches of this package"),
    ).toBeVisible();
    await expect(stoppedMonitor.getByText(/^acknowledged /)).toBeVisible();
    expect(browserErrors).toEqual([]);
    const publicRequests = (await readJournal()).filter((entry) =>
      /^\/@drydock\/e2e-publication(?:$|\/-\/)/.test(decodeURIComponent(entry.path)),
    );
    // A release with no Drydock record is decided from metadata alone: its
    // bytes are never downloaded, so no padding can hide it.
    expect(publicRequests.length).toBeGreaterThan(0);
    expect(
      publicRequests.some((entry) => entry.path.includes("/-/drydock-e2e-publication-1.0.0.tgz")),
    ).toBe(false);
    expect(publicRequests.every((entry) => entry.authorization === "absent")).toBe(true);
  } finally {
    await context.close();
  }
});

test("a package link names its organization, whatever this browser had active", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await registerAndConnect(page);
    await page.goto("/dashboard");
    const created = await createScan(page, uiStageId);
    expect(created.status).toBe(202);
    await pollScanUntilTerminal(page, String(created.body?.scan?.id));
    // Org A holds the review; org B is created afterwards and made active.
    const orgs = await evaluateOnStablePage(
      page,
      async () => {
        const list = (await fetch("/api/v1/organizations").then((response) => response.json())) as {
          organizations: { id: string; name: string }[];
        };
        const created = (await fetch("/api/v1/organizations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Second workspace" }),
        }).then((response) => response.json())) as { organization: { id: string; name: string } };
        return {
          a: list.organizations[0]!,
          b: created.organization,
        };
      },
      undefined,
    );
    await page.evaluate(
      (id) => localStorage.setItem("drydock:active-organization-id", id),
      orgs.b.id,
    );

    const linkToA = `/dashboard/packages/@drydock/e2e-native?org=${encodeURIComponent(orgs.a.id)}`;
    await page.goto(linkToA);
    await expect(page.getByRole("heading", { name: "@drydock/e2e-native" })).toBeVisible();
    await expect(page.getByText(orgs.a.name, { exact: true }).first()).toBeVisible();
    await expect(page.getByText("1 review", { exact: true })).toBeVisible();
    // The organization stays in the address, so the page can be shared as-is.
    expect(new URL(page.url()).searchParams.get("org")).toBe(orgs.a.id);

    await page.goto(`/dashboard/packages/@drydock/e2e-native?org=${encodeURIComponent(orgs.b.id)}`);
    await expect(page.getByText(/have been reviewed in\s+Second workspace\s+yet/)).toBeVisible();

    await page.goto("/dashboard/packages/@drydock/e2e-native?org=org-that-is-not-mine");
    await expect(
      page.getByText(/You are not a member of the organization this link names/),
    ).toBeVisible();
    await expect(page.getByText("1 review", { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("an observed release opens what was published: its public diff and its review", async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await openAuthenticatedPage(browser, baseURL);
  try {
    await page.goto("/dashboard");
    const organization = await evaluateOnStablePage(
      page,
      async () =>
        (
          (await fetch("/api/v1/organizations").then((response) => response.json())) as {
            organizations: { id: string }[];
          }
        ).organizations[0]!,
      undefined,
    );
    await page.route("**/api/v1/publication-watches/packages/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          packageName: "@drydock/e2e-diffed",
          watch: {
            id: "watch-diffed",
            organizationId: organization.id,
            packageName: "@drydock/e2e-diffed",
            source: "manual",
            createdAt: "2026-09-01T00:00:00.000Z",
            lastCheckedAt: "2026-09-02T00:00:00.000Z",
            lastError: null,
            unresolvedAlertCount: 0,
          },
          observations: [
            {
              id: "obs-reviewed",
              version: "1.1.0",
              previousVersion: "1.0.0",
              status: "unknown",
              reason: "review_pending",
              scanId: "scan-in-flight",
              publishedAt: "2026-09-02T00:00:00.000Z",
              firstSeenAt: "2026-09-02T00:00:00.000Z",
              checkedAt: "2026-09-02T00:00:00.000Z",
              acknowledgedAt: null,
            },
          ],
          alerts: [],
          enrollment: { state: "watched" },
          viewer: { canStop: true },
        }),
      });
    });
    await page.goto(
      `/dashboard/packages/@drydock/e2e-diffed?org=${encodeURIComponent(organization.id)}`,
    );
    const monitor = page.getByRole("region", { name: "Publication monitor" });
    await expect(
      monitor.getByText("a Drydock review of this version is still running", { exact: true }),
    ).toBeVisible();
    await expect(
      monitor.getByRole("link", {
        name: "Open the public diff of 1.1.0 against 1.0.0 in a new tab",
      }),
    ).toHaveAttribute("href", "/diff/@drydock/e2e-diffed/1.0.0/1.1.0");
    await expect(monitor.getByRole("link", { name: "Open review" })).toHaveAttribute(
      "href",
      "/dashboard/scans/scan-in-flight",
    );
  } finally {
    await context.close();
  }
});

test("publication monitor automatically watches public staged discoveries and respects stop watching", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await registerAndConnect(page);
    await page.goto("/dashboard");
    const monitor = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Publication monitor", exact: true }) });
    const reviews = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Recent reviews", exact: true }) });
    await expect(monitor.getByText(/No packages watched yet/)).toBeVisible();
    await reviews.getByRole("button", { name: "Check npm", exact: true }).click();
    const nativeRow = monitor
      .locator("li")
      .filter({ has: page.getByText("@drydock/e2e-native", { exact: true }) });
    await expect(nativeRow.getByText(/from a staged review/)).toBeVisible({ timeout: 60_000 });
    await nativeRow.getByRole("button", { name: "More actions for @drydock/e2e-native" }).click();
    await page.getByRole("menuitem", { name: "Stop watching", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Stop watching @drydock/e2e-native?" })
      .getByRole("button", { name: "Stop watching", exact: true })
      .click();
    await expect(nativeRow).toHaveCount(0);
    const nextDiscovery = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/staged-publishes/scan") &&
        response.request().method() === "POST",
    );
    await reviews.getByRole("button", { name: "Check npm", exact: true }).click();
    expect((await nextDiscovery).ok()).toBe(true);
    await page.reload();
    await expect(monitor.getByText(/from a staged review/).first()).toBeVisible();
    await expect(nativeRow).toHaveCount(0);
    await monitor.getByLabel("Public npm package").fill("@drydock/e2e-native");
    await monitor.getByRole("button", { name: "Watch package", exact: true }).click();
    await expect(nativeRow.getByText(/added by hand/)).toBeVisible();
    await monitor.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(artifactsDir, "publication-auto-enrollment.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("publication monitor explains deferred enrollment and offers gate packages for explicit opt-in", async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await openAuthenticatedPage(browser, baseURL);
  let enrolled = false;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const watch = {
    id: "gate-watch",
    packageName: "@drydock/gate-package",
    source: "manual",
    createdAt: "2026-09-13T00:00:00.000Z",
    lastCheckedAt: null,
    lastError: null,
  };
  await page.route("**/api/v1/publication-watches", async (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({ packageName: watch.packageName });
      enrolled = true;
      await route.fulfill({ json: { watch } });
      return;
    }
    await route.fulfill({
      json: {
        watches: enrolled ? [watch] : [],
        autoEnrollment: {
          deferred: enrolled ? 0 : 2,
          suggestions: enrolled ? [] : [{ packageName: watch.packageName }],
        },
      },
    });
  });
  try {
    await page.goto("/dashboard");
    const monitor = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Publication monitor", exact: true }) });
    await expect(
      monitor.getByText(/Automatic enrollment is deferred for 2 packages/),
    ).toBeVisible();
    await expect(monitor.getByText(/workflow-gate packages need an explicit choice/)).toBeVisible();
    await monitor.getByRole("button", { name: "Watch @drydock/gate-package", exact: true }).click();
    await expect(monitor.getByText(watch.packageName, { exact: true })).toBeVisible();
    await expect(monitor.getByText(/added by hand/)).toBeVisible();
    await expect(monitor.getByText(/Automatic enrollment is deferred/)).toHaveCount(0);
    await expect(
      monitor.getByRole("button", { name: "Watch @drydock/gate-package", exact: true }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

// An alert is reviewed after the fact: Scan runs the published bytes against
// the version they follow, the decision is made on the review page (diff
// first), and the alert shows the outcome beside its unchanged verdict.
//
// It runs in an organization of its own. The suite already spends the first
// organization's hourly scan budget exactly (smoke test plus one scan per
// scenario), and a new organization costs no sign-up.
test("a publication alert is scanned, decided after release, and shows the outcome", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const { context, page } = await openAuthenticatedPage(browser, baseURL);
  const packageName = "@drydock/e2e-post-release";
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("requestfailed", (request) =>
    browserErrors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`),
  );
  try {
    await page.goto("/dashboard");
    const organization = await evaluateOnStablePage(
      page,
      async () =>
        (
          (await fetch("/api/v1/organizations", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "Post-release workspace" }),
          }).then((response) => response.json())) as { organization: { id: string } }
        ).organization,
      undefined,
    );
    await page.evaluate(
      (id) => localStorage.setItem("drydock:active-organization-id", id),
      organization.id,
    );
    await page.reload();

    const monitor = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: /^Publication monitor/ }) });
    await expect(monitor.getByLabel("Public npm package")).toBeEnabled();
    await monitor.getByLabel("Public npm package").fill(packageName);
    await monitor.getByRole("button", { name: "Watch package", exact: true }).click();
    const row = monitor.locator("li").filter({ has: page.getByText(packageName, { exact: true }) });
    await expect(row.getByText(/added by hand/)).toBeVisible();
    // 1.0.0 predates the watch; 1.1.0 is published now, after enrollment.
    const published = await fetch(`${registryUrl}/@drydock%2Fe2e-post-release`);
    expect(published.ok).toBe(true);
    await published.json();
    await row.getByRole("button", { name: "Check releases", exact: true }).click();
    await expect(
      row.getByText("Published with no approval in this organization", { exact: true }),
    ).toBeVisible();
    await expect(row.getByText("1.1.0", { exact: true })).toBeVisible();
    await expect(row.getByText("1 unacknowledged alert", { exact: true })).toBeVisible();
    await expect(
      row.getByRole("link", { name: "Open the public diff of 1.1.0 against 1.0.0 in a new tab" }),
    ).toBeVisible();

    await row.getByRole("button", { name: "Scan", exact: true }).click();
    await page.waitForURL(/\/dashboard\/scans\/[^/?#]+/);
    const reviewPath = new URL(page.url()).pathname;
    await expect(
      page.getByText(/^Post-release review: @drydock\/e2e-post-release@1\.1\.0/),
    ).toBeVisible({ timeout: 30_000 });
    // The review runs in the background; the page refreshes when it is ready.
    const decide = page.getByRole("button", { name: "Decide", exact: true });
    await expect(decide).toBeVisible({ timeout: 150_000 });
    await page.screenshot({
      path: path.join(artifactsDir, "post-release-review.png"),
      fullPage: true,
    });
    await decide.click();
    const dialog = page.getByRole("dialog", { name: "Decision after release" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Approve after release", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    // Nothing to finish on npm: the release is already public.
    await expect(
      page.getByRole("dialog").filter({ hasText: "Finish the publish on npm" }),
    ).toHaveCount(0);

    await page.getByRole("link", { name: "Open the package’s alerts" }).click();
    await expect(page).toHaveURL(/\/dashboard\/packages\/@drydock\/e2e-post-release/);
    const packageMonitor = page.getByRole("region", { name: "Publication monitor" });
    await expect(packageMonitor.getByText("Approved after release", { exact: true })).toBeVisible();
    // The verdict it was observed with stays what it was.
    await expect(
      packageMonitor.getByText("Published with no approval in this organization", { exact: true }),
    ).toBeVisible();
    await expect(packageMonitor.getByText("watching", { exact: true })).toBeVisible();
    await expect(packageMonitor.getByText(/unacknowledged alert/)).toHaveCount(0);
    await expect(
      packageMonitor.getByRole("button", { name: "Acknowledge", exact: true }),
    ).toHaveCount(0);
    await expect(packageMonitor.getByRole("button", { name: "Scan", exact: true })).toHaveCount(0);
    // The fake registry is not public npm, so the badge does not count it.
    await expect(packageMonitor.getByText(/^The public badge is unchanged: /)).toBeVisible();
    const openReview = packageMonitor.getByRole("link", { name: "Open post-release review" });
    await expect(openReview).toHaveAttribute("href", reviewPath);
    await packageMonitor.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(artifactsDir, "post-release-approved.png"),
      fullPage: true,
    });

    // Declining after release keeps the alert open, with what to do next.
    await openReview.click();
    await page.getByRole("button", { name: "Update decision", exact: true }).click();
    const updateDialog = page.getByRole("dialog", { name: "Decision after release" });
    await updateDialog.getByRole("button", { name: "Decline after release", exact: true }).click();
    await expect(updateDialog).toBeHidden({ timeout: 30_000 });
    await page.getByRole("link", { name: "Open the package’s alerts" }).click();
    await expect(packageMonitor.getByText("Declined after release", { exact: true })).toBeVisible();
    await expect(
      packageMonitor.getByText(
        /^Next steps: deprecate or unpublish @drydock\/e2e-post-release@1\.1\.0 on npm, rotate the npm tokens/,
      ),
    ).toBeVisible();
    await expect(packageMonitor.getByText("1 unacknowledged alert", { exact: true })).toBeVisible();
    await expect(
      packageMonitor.getByRole("button", { name: "Acknowledge", exact: true }),
    ).toBeVisible();
    await packageMonitor.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(artifactsDir, "post-release-declined.png"),
      fullPage: true,
    });
    expect(browserErrors).toEqual([]);
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
    // Public packages are read the way public npm serves them: with no token.
    const publicPackage = /^\/@drydock\/e2e-(?:publication|post-release)(?:$|\/-\/)/.test(
      decodeURIComponent(entry.path),
    );
    expect(entry.authorization, entry.path).toBe(publicPackage ? "absent" : "present");
  }

  // Credentialed paths are allowlisted, not merely observed: this is what fails
  // when a new npm call starts forwarding the token somewhere unreviewed. The
  // version-status branch matches the escaping npm's spec requires — scoped
  // names fully encoded (`/-/package/%40scope%2Fname/version/1.2.3/status`),
  // unlike the packument branch, which takes the un-escaped `@scope/name`.
  // Whether that lookup fires within a run is background-timing dependent, so
  // it is asserted for shape here and for exact URL in test/npm-version-status.
  for (const entry of journal.filter((item) => item.authorization === "present")) {
    expect(entry.path).toMatch(
      /^\/(?:-\/(?:whoami|stage(?:\?|\/)|package\/[^/]+\/version\/[^/]+\/status)|@drydock(?:%2F|\/)[^/]+(?:$|\/-\/))/i,
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
      const body = (await validate.json().catch(() => null)) as {
        validation?: { ok?: boolean };
      } | null;
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

interface CreateScanBody {
  scan?: { id?: string };
  queued?: boolean;
}

async function createScan(
  page: Page,
  stageId: string,
): Promise<{ status: number; body: CreateScanBody | null }> {
  return evaluateOnStablePage(
    page,
    async (inputStageId) => {
      const response = await fetch("/api/v1/scans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stageId: inputStageId }),
      });
      const body = (await response.json().catch(() => null)) as CreateScanBody | null;
      return { status: response.status, body };
    },
    stageId,
  );
}

// Poll the persisted detail route the way the dashboard does (with ?poll=1)
// until the background job reaches a terminal status. The deadline stays inside
// the 90s Playwright test timeout so a stuck scan fails with the last observed
// status instead of an opaque test timeout.
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

// Playwright does not export PageFunction, so the callback type is read off
// the two-type-parameter `evaluate` overload via an instantiation expression.
async function evaluateOnStablePage<Arg, Result>(
  page: Page,
  pageFunction: Parameters<typeof page.evaluate<Result, Arg>>[0],
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
