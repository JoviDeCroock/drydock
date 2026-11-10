import { expect, test, type Page, type Route } from "@playwright/test";
import type { DependencyReviewCoverage } from "../../server/db/dependency-reviews";
import type { BumpEvidence, ReviewedBump } from "../../server/lib/dependency-review/types";

const ORG = "org-deps";
const SCREENSHOTS = ".context/e2e-artifacts/dependency-review";

const POLICY = {
  holdOnInstallScripts: true,
  holdOnNativeBinaries: true,
  holdOnNewDependencies: true,
  holdOnNewBinCommands: false,
  holdAtReleaseRisk: "high",
  holdOnUninspectedFiles: false,
  holdOnUnreviewed: false,
  holdOnNewPackages: false,
  unreadMinimumAgeDays: 3,
  publicMirrors: [],
  privateRegistries: [],
  privateScopes: [],
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

type ReviewWire = Omit<typeof REVIEW, "conclusion" | "completedAt"> & {
  conclusion: string | null;
  completedAt: string | null;
};

const EVIDENCE: BumpEvidence = {
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
  coverageNotices: 0,
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

const BUMPS: ReviewedBump[] = [
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

const COVERAGE: DependencyReviewCoverage = { unreadLockfiles: [], listingComplete: true };

test("dependency review settings save the hold policy", async ({ page }) => {
  const errors = watchErrors(page);
  const writes: unknown[] = [];
  await installMocks(page, writes);
  await page.goto("/dashboard/settings?tab=integrations#dependency-review");

  const section = page.locator("#dependency-review");
  await expect(section.getByText(/make the check a required status check/)).toBeVisible();
  // App permissions are named only where they are the next step (no App).
  await expect(section.getByText(/Checks \(write\)/)).toHaveCount(0);
  await expect(section.getByRole("checkbox", { name: "adds a native binary" })).toBeChecked();
  await expect(section.getByLabel("Or reaches release risk")).toHaveValue("high");

  await section.getByRole("checkbox", { name: "Review dependency update pull requests" }).check();
  await section.getByRole("checkbox", { name: "adds a native binary" }).uncheck();
  await section.getByLabel("Or reaches release risk").selectOption("critical");
  await section.getByText("Self-hosted Renovate or other dependency bots").click();
  await section.getByLabel("Extra bot logins").fill("my-renovate[bot], deps-bot");
  await expect(section.getByLabel("Minimum age for unread updates")).toHaveValue("3");
  await section.getByLabel("Minimum age for unread updates").fill("7");
  await section.getByText("Registries other than public npm and PyPI").click();
  await expect(
    section.getByText(/sends the names and versions resolved from a mirror/),
  ).toBeVisible();
  await expect(section.getByText(/every name the repository routes to the mirror/)).toBeVisible();
  await expect(section.getByText(/exempt from the minimum age/)).toBeVisible();
  await section.getByLabel("Mirrors of npm or PyPI").fill("https://artifacts.example.com/npm/");
  await section.getByLabel("Private registries").fill("https://npm.corp.example/");
  await section.getByLabel("Private npm scopes").fill("@corp, @corp-tools");
  await section.screenshot({ path: `${SCREENSHOTS}/settings.png` });
  await section.getByRole("button", { name: "Save dependency review" }).click();
  await expect(section.getByText("Saved.")).toBeVisible();

  expect(writes).toEqual([
    {
      enabled: true,
      policy: {
        ...POLICY,
        holdOnNativeBinaries: false,
        holdAtReleaseRisk: "critical",
        unreadMinimumAgeDays: 7,
        publicMirrors: ["https://artifacts.example.com/npm/"],
        privateRegistries: ["https://npm.corp.example/"],
        privateScopes: ["@corp", "@corp-tools"],
      },
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
  await expect(page.getByText("1 of 3 updates is held.")).toBeVisible();
  await expect(
    page.getByText(
      "Adds an install script; adds a dependency (2); release risk high, at or above the hold threshold.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Approve on GitHub ↗" })).toHaveAttribute(
    "href",
    "https://github.com/acme/web/runs/7",
  );
  await expect(page.getByText("Over the per-PR review limit.")).toBeVisible();
  // Package text renders as text, never markup.
  await expect(page.getByText("@acme/<img src=x onerror=alert(1)>")).toBeVisible();
  await expect(
    page.getByText("Install script downloads <b>code</b> over the network"),
  ).toBeVisible();
  await expect(page.locator("main img")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "2 more release findings in the diff →" }),
  ).toHaveAttribute("href", "/diff/@acme/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E/1.2.0/1.3.0");
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
  await expect(page.getByRole("link", { name: /^Dependencies(?: Beta)?$/ })).toBeVisible();
  await expect(row).toHaveAttribute("href", `/dashboard/dependency-reviews/dr_1?org=${ORG}`);
  await expect(page.getByRole("table").getByText("1 held", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOTS}/list.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test("private-source updates never offer a public diff link", async ({ page }) => {
  const errors = watchErrors(page);
  const privateBump: ReviewedBump = {
    bump: { ...BUMPS[0].bump, name: "@corp/private-only", privateSource: true },
    verdict: {
      status: "hold",
      reasons: ["unreviewed"],
      unreviewed: "private-source",
      evidence: null,
    },
    approved: false,
  };
  await installMocks(page, [], { bumps: () => [privateBump, ...BUMPS.slice(1)] });
  await page.goto(`/dashboard/dependency-reviews/dr_1?org=${ORG}`);

  const row = page.getByRole("listitem").filter({ hasText: "@corp/private-only" });
  await expect(row).toBeVisible();
  await expect(row.getByRole("link")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "View diff →" })).toHaveCount(2);
  await page.screenshot({ path: `${SCREENSHOTS}/private-source.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test("updates allowed by policy are not described as clear", async ({ page }) => {
  const errors = watchErrors(page);
  await installMocks(page, [], {
    review: () => ({ ...REVIEW, conclusion: "clear", heldCount: 0 }),
    bumps: () => [
      BUMPS[1],
      BUMPS[2],
      {
        bump: { ...BUMPS[1].bump, name: "new-package", fromVersion: null },
        verdict: { status: "new-package" },
        approved: false,
      },
    ],
  });
  await page.goto(`/dashboard/dependency-reviews/dr_1?org=${ORG}`);

  await expect(
    page.getByText(
      "No updates are held. 2 updates passed under this organization's policy without a full read.",
    ),
  ).toBeVisible();
  await expect(page.getByText("All 3 updates are clear.")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Not reviewed 1" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "New packages 1" })).toBeVisible();
  await page.goto("/dashboard/dependency-reviews");
  await expect(page.getByRole("cell", { name: "no holds", exact: true })).toBeVisible();
  await expect(page.getByText("clear", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("an aged release that adds an unheld native binary is listed as unread, never clear", async ({
  page,
}) => {
  await installMocks(page, [], {
    review: () => ({ ...REVIEW, conclusion: "clear", heldCount: 0, bumpCount: 1 }),
    bumps: () => [
      {
        bump: { ...BUMPS[1].bump, name: "gains-a-binary" },
        verdict: {
          status: "clear",
          evidence: {
            ...EVIDENCE,
            releaseRisk: "low",
            installScriptsAdded: 0,
            dependenciesAdded: 0,
            nativeBinariesAdded: 1,
            findings: [],
            findingCount: 0,
          },
        },
        approved: false,
      },
    ],
  });
  await page.goto(`/dashboard/dependency-reviews/dr_1?org=${ORG}`);

  await expect(
    page.getByText(
      "No updates are held. 1 update passed under this organization's policy without a full read.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Passed with unread changes 1" })).toBeVisible();
  await expect(page.getByText("Adds 1 native binary no rule reads.")).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Clear/ })).toHaveCount(0);
  await expect(page.getByText("The update is clear.")).toHaveCount(0);
});

test("a fully reviewed update can be described as clear", async ({ page }) => {
  await installMocks(page, [], {
    review: () => ({ ...REVIEW, conclusion: "clear", heldCount: 0, bumpCount: 1 }),
    bumps: () => [BUMPS[1]],
  });
  await page.goto(`/dashboard/dependency-reviews/dr_1?org=${ORG}`);
  await expect(page.getByText("The update is clear.", { exact: true })).toBeVisible();
});

test("complete coverage with no bumps reports no dependency additions or updates", async ({
  page,
}) => {
  await installMocks(page, [], {
    review: () => ({ ...REVIEW, conclusion: "clear", heldCount: 0, bumpCount: 0 }),
    bumps: () => [],
  });
  await page.goto(`/dashboard/dependency-reviews/dr_1?org=${ORG}`);
  await expect(
    page.getByText("No npm or PyPI dependency additions or updates.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("All 0 updates are clear.")).toHaveCount(0);
});

test("unread-only holds name the files without claiming zero updates are held", async ({
  page,
}) => {
  const errors = watchErrors(page);
  const unread = "nested/<img src=x onerror=alert(1)>/package.json";
  await installMocks(page, [], {
    review: () => ({ ...REVIEW, bumpCount: 0, heldCount: 0 }),
    bumps: () => [],
    coverage: () => ({ unreadLockfiles: [unread], listingComplete: true }),
  });
  await page.goto(`/dashboard/dependency-reviews/dr_1?org=${ORG}`);

  await expect(
    page.getByText(
      "Held: Drydock could not read some dependency changes. Approving on the GitHub check accepts the unread changes listed below; changing the files so Drydock can read them gets them reviewed instead.",
    ),
  ).toBeVisible();
  // Approve over unread files stays available but doesn't lead.
  await expect(page.getByRole("link", { name: "Approve on GitHub ↗" })).not.toHaveClass(
    /bg-accent/,
  );
  // No count: "0 updates" would claim a certainty the coverage note denies.
  await expect(page.getByText("0 updates")).toHaveCount(0);
  await expect(page.getByText(unread, { exact: true })).toBeVisible();
  await expect(page.getByText("0 of 0 updates are held.")).toHaveCount(0);
  await expect(page.locator("main img")).toHaveCount(0);
  await page.screenshot({ path: `${SCREENSHOTS}/unread-only.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test("an incomplete file listing stays visible even when the policy allows it", async ({
  page,
}) => {
  await installMocks(page, [], {
    review: () => ({ ...REVIEW, conclusion: "clear", heldCount: 0, bumpCount: 1 }),
    bumps: () => [BUMPS[1]],
    coverage: () => ({ unreadLockfiles: [], listingComplete: false }),
  });
  await page.goto(`/dashboard/dependency-reviews/dr_1?org=${ORG}`);

  await expect(page.getByText(/GitHub did not return every changed file/)).toBeVisible();
  await expect(page.getByText("The update is clear.", { exact: true })).toHaveCount(0);
});

test("a running dependency review refreshes itself into its result", async ({ page }) => {
  const errors = watchErrors(page);
  let review: ReviewWire = {
    ...REVIEW,
    status: "running",
    conclusion: null,
    heldCount: 0,
    completedAt: null,
  };
  await page.clock.install();
  await installMocks(page, [], { review: () => review });

  await page.goto("/dashboard/dependency-reviews");
  await expect(page.getByRole("table").getByText("reviewing…")).toBeVisible();
  await page.goto(`/dashboard/dependency-reviews/dr_1?org=${ORG}`);
  await expect(
    page.getByText("Reviewing this commit. The page refreshes when the review is ready."),
  ).toBeVisible();
  await expect(page.getByText(/Showing \d+ of/)).toHaveCount(0);
  await page.screenshot({ path: `${SCREENSHOTS}/detail-running.png`, fullPage: true });

  review = REVIEW;
  await page.clock.runFor(10_000);
  await expect(page.getByText("1 of 3 updates is held.")).toBeVisible();
  await expect(page.getByText(/Reviewing this commit/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("dependency review that is on without the GitHub App says nothing can run", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await installMocks(page, [], { githubAppInstalled: false, enabled: true });
  await page.goto("/dashboard/dependency-reviews");

  await expect(page.getByText(/the Drydock GitHub App is not installed/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Install the GitHub App" })).toHaveAttribute(
    "href",
    "/dashboard/settings?tab=integrations#github-app",
  );
  await expect(page.getByText(/No pull requests reviewed yet/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a failed review offers its re-run on GitHub, not an approval", async ({ page }) => {
  await installMocks(page, [], {
    review: () => ({
      ...REVIEW,
      status: "failed",
      conclusion: null,
      heldCount: 0,
      completedAt: null,
    }),
  });
  await page.goto(`/dashboard/dependency-reviews/dr_1?org=${ORG}`);

  await expect(page.getByText(/could not finish reviewing this commit/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Re-run on GitHub ↗" })).toHaveAttribute(
    "href",
    "https://github.com/acme/web/runs/7",
  );
  await expect(page.getByRole("link", { name: "Approve on GitHub ↗" })).toHaveCount(0);
  await expect(page.getByText(/updates$/)).toHaveCount(0);
});

test("a hold the check cannot list in full says to split the pull request", async ({ page }) => {
  await installMocks(page, [], {
    coverage: () => ({ unreadLockfiles: [], listingComplete: false }),
  });
  await page.goto(`/dashboard/dependency-reviews/dr_1?org=${ORG}`);

  await expect(page.getByText(/Split the pull request into smaller ones/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Approve on GitHub ↗" })).toHaveCount(0);
});

test("an older commit's held review points at the latest review instead of Approve", async ({
  page,
}) => {
  await installMocks(page, [], { newerReviewId: "dr_2" });
  await page.goto(`/dashboard/dependency-reviews/dr_1?org=${ORG}`);

  await expect(page.getByRole("link", { name: "Open the latest review" })).toHaveAttribute(
    "href",
    `/dashboard/dependency-reviews/dr_2?org=${ORG}`,
  );
  await expect(page.getByText(/no longer the pull request's head/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Approve on GitHub ↗" })).toHaveCount(0);
});

test("an organization outside the rollout flag sees no dependency review", async ({ page }) => {
  const errors = watchErrors(page);
  const requested: string[] = [];
  await installMocks(page, [], { dependencyReview: false, requested });
  await page.goto("/dashboard/settings?tab=integrations");

  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Dependencies(?: Beta)?$/ })).toHaveCount(0);
  await expect(page.locator("#dependency-review")).toHaveCount(0);
  expect(requested.filter((path) => path.startsWith("/api/v1/dependency-reviews"))).toEqual([]);
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

async function installMocks(
  page: Page,
  writes: unknown[],
  {
    dependencyReview = true,
    githubAppInstalled = true,
    enabled = false,
    requested = [] as string[],
    review = (): ReviewWire => REVIEW,
    bumps = (): ReviewedBump[] => BUMPS,
    coverage = (): DependencyReviewCoverage => COVERAGE,
    newerReviewId = null as string | null,
  } = {},
) {
  let settings = { enabled, policy: POLICY, extraBotLogins: [] as string[] };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    requested.push(path);
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
      "/api/v1/api-keys": { keys: [], limit: 10, expiryDays: [30, 90, 365] },
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
            dependencyReview,
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
        githubAppInstalled,
        reviews: githubAppInstalled ? [review()] : [],
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
      const current = review();
      await fulfillJson(route, {
        review: current,
        bumps: current.status === "completed" ? bumps() : [],
        coverage: coverage(),
        approvable: coverage().listingComplete && !newerReviewId,
        newerReviewId,
      });
      return;
    }
    await fulfillJson(route, { error: `unexpected request: ${path}` }, 404);
  });
}

async function fulfillJson(route: Route, json: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
}
