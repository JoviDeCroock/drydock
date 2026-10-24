import { expect, test, type Page, type Route } from "@playwright/test";

const ORG = "org-deps";
const SCREENSHOTS = ".context/e2e-artifacts/dependency-review";

const POLICY = {
  holdOnInstallScripts: true,
  holdOnNativeBinaries: true,
  holdOnNewDependencies: true,
  holdOnNewBinCommands: true,
  holdAtReleaseRisk: "high",
  holdOnUninspectedFiles: true,
  holdOnUnreviewed: true,
  holdOnNewPackages: false,
};

const REVIEW = {
  id: "dr_1",
  organizationId: ORG,
  installationRowId: "inst-1",
  repositoryId: 42,
  repositoryFullName: "acme/web",
  pullNumber: 128,
  headSha: "4f1c2d3e4f5a6b7c8d9e",
  authorLogin: "dependabot[bot]",
  checkRunId: 7,
  status: "completed",
  conclusion: "held",
  bumpCount: 3,
  heldCount: 1,
  approvedByLogin: null,
  approvedAt: null,
  createdAt: "2026-10-24T09:00:00.000Z",
  completedAt: "2026-10-24T09:01:00.000Z",
};

const EVIDENCE = {
  releaseRisk: "high",
  filesAdded: 2,
  filesRemoved: 0,
  filesChanged: 5,
  installScriptsAdded: 1,
  installScriptsChanged: 0,
  nativeBinariesAdded: 0,
  dependenciesAdded: 2,
  binCommandsAdded: 0,
  uninspectedFiles: 0,
  findings: [
    {
      severity: "high",
      ruleId: "install-script-network",
      file: "package/scripts/postinstall.js",
      reason: "Install script downloads <b>code</b> over the network",
    },
  ],
  findingCount: 3,
};

const BUMPS = [
  {
    bump: {
      ecosystem: "npm",
      name: "@acme/<img src=x onerror=alert(1)>",
      fromVersion: "1.2.0",
      toVersion: "1.3.0",
      direct: true,
      lockfilePath: "package-lock.json",
    },
    verdict: {
      status: "hold",
      reasons: ["install-script-added", "dependency-added", "release-risk"],
      evidence: EVIDENCE,
    },
    approved: false,
  },
  {
    bump: {
      ecosystem: "npm",
      name: "left-pad",
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
      direct: false,
      lockfilePath: "package-lock.json",
    },
    verdict: {
      status: "clear",
      evidence: { ...EVIDENCE, releaseRisk: "low", findings: [], findingCount: 0 },
    },
    approved: false,
  },
  {
    bump: {
      ecosystem: "pypi",
      name: "requests",
      fromVersion: "2.31.0",
      toVersion: "2.32.0",
      direct: true,
      lockfilePath: "uv.lock",
    },
    verdict: { status: "unreviewed", unreviewed: "over-cap" },
    approved: false,
  },
];

test("dependency review settings save the hold policy", async ({ page }) => {
  const errors = watchErrors(page);
  const writes: unknown[] = [];
  await installMocks(page, writes);
  await page.goto("/dashboard/settings?tab=integrations#dependency-review");

  const section = page.locator("#dependency-review");
  await expect(section.getByText("Checks (write), Pull requests (read)")).toBeVisible();
  await expect(section.getByRole("checkbox", { name: "adds a native binary" })).toBeChecked();
  await expect(section.getByLabel("Or reaches release risk")).toHaveValue("high");

  await section.getByRole("checkbox", { name: "Review dependency update pull requests" }).check();
  await section.getByRole("checkbox", { name: "adds a native binary" }).uncheck();
  await section.getByLabel("Or reaches release risk").selectOption("critical");
  await section.getByLabel("Extra bot logins").fill("my-renovate[bot], deps-bot");
  await section.screenshot({ path: `${SCREENSHOTS}/settings.png` });
  await section.getByRole("button", { name: "Save dependency review" }).click();
  await expect(section.getByText("Saved.")).toBeVisible();

  expect(writes).toEqual([
    {
      enabled: true,
      policy: { ...POLICY, holdOnNativeBinaries: false, holdAtReleaseRisk: "critical" },
      extraBotLogins: ["my-renovate[bot]", "deps-bot"],
    },
  ]);
  expect(errors).toEqual([]);
});

test("dependency review detail lists each bump's verdict as text", async ({ page }) => {
  const errors = watchErrors(page);
  await installMocks(page, []);
  await page.goto(`/dashboard/dependency-reviews/dr_1?org=${ORG}`);

  await expect(page.getByRole("heading", { name: "acme/web #128" })).toBeVisible();
  await expect(page.getByText("1 of 3 updates are held.")).toBeVisible();
  await expect(
    page.getByText(
      "Adds an install script; adds a dependency (2); release risk at or above the hold threshold.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Over the per-PR review limit.")).toBeVisible();
  // Package text renders as text, never markup.
  await expect(page.getByText("@acme/<img src=x onerror=alert(1)>")).toBeVisible();
  await expect(
    page.getByText("Install script downloads <b>code</b> over the network"),
  ).toBeVisible();
  await expect(page.locator("main img")).toHaveCount(0);
  await expect(page.getByText("2 more release findings in the diff")).toBeVisible();
  const diffLinks = page.getByRole("link", { name: "View diff →" });
  await expect(diffLinks.nth(0)).toHaveAttribute(
    "href",
    "/diff/@acme/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E/1.2.0/1.3.0",
  );
  await expect(diffLinks.nth(1)).toHaveAttribute("href", "/diff/pypi/requests/2.31.0/2.32.0");
  await expect(page.getByRole("link", { name: "Open pull request ↗" })).toHaveAttribute(
    "href",
    "https://github.com/acme/web/pull/128",
  );
  await page.screenshot({ path: `${SCREENSHOTS}/detail.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test("dependency review list links each review with its organization", async ({ page }) => {
  const errors = watchErrors(page);
  await installMocks(page, []);
  await page.goto("/dashboard/dependency-reviews");

  const row = page.getByRole("link", { name: "acme/web #128" });
  await expect(row).toHaveAttribute("href", `/dashboard/dependency-reviews/dr_1?org=${ORG}`);
  await expect(page.getByText("1 held", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOTS}/list.png`, fullPage: true });
  expect(errors).toEqual([]);
});

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

async function installMocks(page: Page, writes: unknown[]) {
  let settings = { enabled: false, policy: POLICY, extraBotLogins: [] as string[] };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const empty: Record<string, unknown> = {
      "/api/v1/npm-connection": { connection: null },
      "/api/v1/github-app/config": { configured: true, appSlug: "drydock" },
      "/api/v1/github-app/installations": { installations: [] },
      "/api/v1/github-app/release-targets": { releaseTargets: [] },
      "/api/v1/slack": { configured: false, connection: null },
      [`/api/v1/organizations/${ORG}/notification-recipients`]: { recipients: [] },
      "/api/v1/organizations/members": { members: [] },
      "/api/v1/organizations/invitations": { invitations: [] },
      "/api/v1/audit-events": { events: [], nextCursor: null },
      "/api/auth/config": { githubSignIn: false, emailVerification: false, passwordReset: false },
    };
    if (path === "/api/auth/get-session") {
      await fulfillJson(route, {
        user: { id: "user-deps", name: "Deps", email: "deps@example.test" },
      });
      return;
    }
    if (path === "/api/v1/organizations") {
      await fulfillJson(route, {
        organizations: [
          {
            id: ORG,
            name: "Acme",
            ownerUserId: "user-deps",
            role: "owner",
            isPersonal: false,
            npmConnectionConfigured: false,
            requireTwoFactorForReleaseDecisions: false,
          },
        ],
      });
      return;
    }
    if (path in empty) {
      await fulfillJson(route, empty[path]);
      return;
    }
    if (path === "/api/v1/dependency-reviews") {
      await fulfillJson(route, {
        settings,
        githubAppInstalled: true,
        reviews: [REVIEW],
        viewer: { canManage: true },
      });
      return;
    }
    if (path === "/api/v1/dependency-reviews/settings") {
      const body = route.request().postDataJSON();
      writes.push(body);
      settings = body;
      await fulfillJson(route, { settings });
      return;
    }
    if (path === "/api/v1/dependency-reviews/dr_1") {
      await fulfillJson(route, { review: REVIEW, bumps: BUMPS });
      return;
    }
    await fulfillJson(route, { error: `unexpected request: ${path}` }, 404);
  });
}

async function fulfillJson(route: Route, json: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
}
