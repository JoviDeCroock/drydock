import { expect, test, type Page, type Route } from "@playwright/test";

// The npm connection card states the exact granular-token permissions to pick.
// It has been dropped once already by an unrelated settings refactor, and its
// absence is invisible until a maintainer provisions the wrong token — so assert
// the permission guidance, not just the card.
test("npm connection card names the exact token permissions", async ({ page }) => {
  await installSettingsMocks(page);
  await page.goto("/dashboard/settings?tab=integrations");

  const guide = page.getByText(/^Use a granular access token/);
  await expect(guide).toBeVisible();
  await expect(guide).toContainText(
    "Use a granular access token with Read-only access to the packages or scopes you want to review.",
  );
  await expect(guide).toContainText("Set Organizations to No access.");
  await expect(guide.getByRole("link", { name: "Create a token" })).toHaveAttribute(
    "href",
    "https://docs.npmjs.com/creating-and-viewing-access-tokens/",
  );
});

test("personal npm setup requires an explicit workspace and switches before accepting a token", async ({
  page,
}) => {
  const writes: unknown[] = [];
  await installSettingsMocks(page, true, writes);
  await page.goto("/dashboard/settings?tab=integrations");
  await expect(page.getByLabel("npm connection organization")).toHaveValue("org-team");
  await expect(page.getByLabel("npm token", { exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
  await page.screenshot({
    path: ".context/e2e-artifacts/personal-npm-workspace-choice.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Open Release team settings" }).click();
  await expect(page.getByRole("button", { name: "Switch organization" })).toContainText(
    "Release team",
  );
  await expect(page.getByLabel("npm token", { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
});

test("keeping npm access personal sends explicit automatic scanning consent", async ({ page }) => {
  const writes: unknown[] = [];
  await installSettingsMocks(page, true, writes);
  await page.goto("/dashboard/settings?tab=integrations");
  await page
    .getByLabel("npm connection organization")
    .selectOption({ label: "Keep in personal workspace" });
  await expect(page.getByLabel("npm token", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Continue in personal workspace" }).click();
  await page.getByLabel("npm token", { exact: true }).fill("npm_fake_read_only");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    confirmPersonalOrganization: true,
    token: "npm_fake_read_only",
  });
});

test("an existing personal connection stays rotatable while its workspace choice is pending", async ({
  page,
}) => {
  const writes: unknown[] = [];
  await installSettingsMocks(page, true, writes, {
    id: "connection-guide",
    organizationId: "org-guide",
    registryUrl: "https://registry.npmjs.org",
    label: "npm registry",
    tokenFingerprint: "fingerprint",
    tokenLast4: "abcd",
    validationStatus: "invalid",
    capabilitiesJson: null,
    personalOrganizationConfirmedAt: null,
    validatedAt: null,
    lastUsedAt: null,
    createdByUserId: "user-guide",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  });
  await page.goto("/dashboard/settings?tab=integrations");
  await expect(page.getByText(/Rotate the token below to resume/)).toBeVisible();
  await expect(page.getByLabel("New npm token", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect npm" })).toBeVisible();
  await expect(page.getByLabel("npm connection organization")).toHaveValue("org-team");
  await page
    .getByLabel("npm connection organization")
    .selectOption({ label: "Keep in personal workspace" });
  await page.getByRole("button", { name: "Enable automatic scans in personal workspace" }).click();
  await expect(page.getByLabel("npm connection organization")).toHaveCount(0);
  await expect(page.getByLabel("New npm token", { exact: true })).toBeVisible();
  expect(writes).toEqual(["personal-confirmation"]);
});

test("a personal-only workspace confirms automatic scans with one button and no picker", async ({
  page,
}) => {
  const writes: unknown[] = [];
  await installSettingsMocks(page, true, writes, null, false);
  await page.goto("/dashboard/settings?tab=integrations");
  await expect(page.getByLabel("npm connection organization")).toHaveCount(0);
  await expect(page.getByLabel("npm token", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Continue in personal workspace" }).click();
  await page.getByLabel("npm token", { exact: true }).fill("npm_fake_read_only");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ confirmPersonalOrganization: true });
});

test("a valid personal connection awaiting its workspace choice does not read as healthy", async ({
  page,
}) => {
  await installSettingsMocks(page, true, [], {
    id: "connection-guide",
    organizationId: "org-guide",
    registryUrl: "https://registry.npmjs.org",
    label: "npm registry",
    tokenFingerprint: "fingerprint",
    tokenLast4: "abcd",
    validationStatus: "valid",
    capabilitiesJson: null,
    personalOrganizationConfirmedAt: null,
    validatedAt: "2026-07-12T00:00:00.000Z",
    lastUsedAt: null,
    createdByUserId: "user-guide",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  });
  await page.goto("/dashboard/settings?tab=integrations");
  await expect(page.getByText("automatic scans off", { exact: true })).toBeVisible();
  await page
    .getByLabel("npm connection organization")
    .selectOption({ label: "Keep in personal workspace" });
  await page.getByRole("button", { name: "Enable automatic scans in personal workspace" }).click();
  await expect(page.getByText("automatic scans off", { exact: true })).toHaveCount(0);
  await expect(page.getByText("valid", { exact: true })).toBeVisible();
});

// The GitHub App install callback and the dashboard's setup steps link to a
// section of the integrations tab; the tab renders only after the workspace
// loads, so the browser's own anchor jump would miss it.
test("a settings deep link lands on its section and tabs are real links", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await installSettingsMocks(page);
  await page.goto("/dashboard/settings?tab=integrations#github-app");

  await expect(page.locator("#github-app")).toBeInViewport();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(
    page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Settings" }),
  ).toHaveAttribute("aria-current", "page");

  const sections = page.getByRole("navigation", { name: "Settings sections" });
  await expect(sections.getByRole("link", { name: "General" })).toHaveAttribute(
    "href",
    "/dashboard/settings",
  );
  await sections.getByRole("link", { name: "Members" }).click();
  await expect(page).toHaveURL(/\/dashboard\/settings\?tab=members$/);
  await expect(sections.getByRole("link", { name: "Members" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

async function installSettingsMocks(
  page: Page,
  personal = false,
  writes: unknown[] = [],
  connection: Record<string, unknown> | null = null,
  withTeam = personal,
) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth/get-session") {
      await fulfillJson(route, {
        user: {
          id: "user-guide",
          name: "Guide Tester",
          email: "guide@example.test",
          twoFactorEnabled: false,
        },
      });
      return;
    }

    if (path === "/api/v1/organizations") {
      await fulfillJson(route, {
        organizations: [
          {
            id: "org-guide",
            name: "Drydock",
            ownerUserId: "user-guide",
            role: "owner",
            isPersonal: personal,
            npmConnectionConfigured: false,
            requireTwoFactorForReleaseDecisions: false,
            createdAt: "2026-07-12T00:00:00.000Z",
            updatedAt: "2026-07-12T00:00:00.000Z",
          },
          ...(withTeam
            ? [
                {
                  id: "org-team",
                  name: "Release team",
                  ownerUserId: "user-guide",
                  role: "admin",
                  isPersonal: false,
                  npmConnectionConfigured: false,
                },
              ]
            : []),
        ],
      });
      return;
    }

    if (path === "/api/v1/npm-connection") {
      if (route.request().method() === "POST") writes.push(route.request().postDataJSON());
      await fulfillJson(route, { connection });
      return;
    }

    if (path === "/api/v1/npm-connection/personal-confirmation") {
      writes.push("personal-confirmation");
      await fulfillJson(route, {
        connection: { ...connection, personalOrganizationConfirmedAt: "2026-07-13T00:00:00.000Z" },
      });
      return;
    }

    if (path === "/api/v1/github-app/config") {
      await fulfillJson(route, { configured: false });
      return;
    }

    if (path === "/api/v1/github-app/installations") {
      await fulfillJson(route, { installations: [] });
      return;
    }

    if (path === "/api/v1/github-app/release-targets") {
      await fulfillJson(route, { releaseTargets: [] });
      return;
    }

    if (path === "/api/v1/slack") {
      await fulfillJson(route, { configured: false, connection: null });
      return;
    }

    if (path.endsWith("/notification-recipients")) {
      await fulfillJson(route, { recipients: [] });
      return;
    }

    if (path === "/api/v1/organizations/members") {
      await fulfillJson(route, { members: [] });
      return;
    }

    if (path === "/api/v1/organizations/invitations") {
      await fulfillJson(route, { invitations: [] });
      return;
    }

    if (path === "/api/v1/audit-events") {
      await fulfillJson(route, { events: [], nextCursor: null });
      return;
    }

    await fulfillJson(route, { error: `unexpected request: ${path}` }, 404);
  });
}

async function fulfillJson(route: Route, json: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(json),
  });
}

for (const target of ["personal", "team", "personal_refresh_failure"] as const) {
  test(`package management ${target === "team" ? "transfer" : target === "personal" ? "confirmation" : "saved choice despite refresh failure"} refreshes the badge and monitor`, async ({
    page,
  }) => {
    await installSettingsMocks(page, true);
    let confirmed = false;
    let moved = false;
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.route("**/api/v1/npm-package-claims/**", async (route) => {
      if (route.request().method() === "POST") {
        confirmed = true;
        moved = route.request().postDataJSON().targetOrganizationId === "org-team";
        await route.fulfill({ json: { managed: true } });
      } else if (confirmed && target === "personal_refresh_failure") {
        await route.fulfill({ status: 503, json: { error: "Refresh temporarily unavailable" } });
      } else
        await route.fulfill({
          json: {
            claim: moved
              ? null
              : { kind: "personal", managementConfirmed: confirmed, canManage: true },
            destinations: [{ id: "org-team", name: "Release team" }],
          },
        });
    });
    const reads = await mockPackageReads(page);
    await page.route("**/api/v1/publication-watches/packages/example", (route) =>
      route.fulfill({
        json: {
          packageName: "example",
          ownershipConflict: moved,
          managementPending: !confirmed,
          watch: null,
          observations: [],
          alerts: [],
          moreAlerts: false,
          enrollment: { state: "not_enrolled" },
          viewer: { canStop: true },
        },
      }),
    );
    await page.goto("/dashboard/packages/example?org=org-guide");
    // The pending choice is stated once, beside its control; the badge says
    // nothing about it and the monitor only that nothing is watched.
    await expect(
      page.getByText("Choose where this package is managed", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/until you choose where/)).toHaveCount(0);
    await expect(page.getByText(/Only the organization that manages this package/)).toHaveCount(0);
    await expect(page.getByText("Not watched.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Watch package", exact: true })).toHaveCount(0);
    await expect(page.getByText(/monitoring inactive/i)).toHaveCount(0);
    await expect(page.getByText(/contact support/i)).toHaveCount(0);
    const choice = page.getByLabel("Managing organization");
    await expect(choice).toHaveValue("org-team");
    if (target !== "team") {
      await choice.selectOption("org-guide");
      await page.getByRole("button", { name: "Keep in personal workspace", exact: true }).click();
      await expect(
        page.getByText("Managed in your personal workspace", { exact: true }),
      ).toBeFocused();
      if (target === "personal_refresh_failure")
        await expect(page.getByText(/Your package choice was saved/)).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Move to organization", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Watch package", exact: true })).toBeVisible();
    } else {
      await expect(page.getByText(/^Moving is permanent: Release team manages/)).toBeVisible();
      await page.screenshot({
        path: ".context/e2e-artifacts/personal-package-organization-choice.png",
        fullPage: true,
      });
      await page.getByRole("button", { name: "Move to Release team" }).click();
      const notice = page
        .getByText(/Release team now manages this package/)
        .locator("xpath=ancestor::div[@tabindex='-1']");
      await expect(notice).toBeFocused();
      await expect(notice.getByRole("link", { name: "Manage in Release team" })).toHaveAttribute(
        "href",
        "/dashboard/packages/example?org=org-team",
      );
      await expect(
        page.getByText("Managed in your personal workspace", { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByText(
          "Monitoring inactive because this package is assigned to another organization.",
        ),
      ).toBeVisible();
      // Another organization's claim cannot be watched past from here.
      await expect(page.getByRole("button", { name: "Watch package", exact: true })).toHaveCount(0);
      await page.screenshot({
        path: ".context/e2e-artifacts/personal-package-transferred.png",
        fullPage: true,
      });
    }
    await expect(
      page.getByText("Choose where this package is managed", { exact: true }),
    ).toHaveCount(0);
    await expect.poll(() => reads.badge).toBeGreaterThan(1);
    expect(browserErrors).toEqual([]);
  });
}

async function mockPackageReads(page: Page) {
  const reads = { badge: 0 };
  await page.route("**/api/v1/packages/example/releases", (route) =>
    route.fulfill({
      json: {
        package: { name: "example", ecosystem: "npm" },
        summary: {
          totalReviews: 0,
          channels: [],
          lastRelease: null,
          publishedWithoutDecision: 0,
          publishedDespiteBlock: 0,
        },
        releases: [],
        nextCursor: null,
        limit: 50,
      },
    }),
  );
  await page.route("**/api/v1/packages/example/badge", (route) => {
    reads.badge++;
    return route.fulfill({
      json: {
        package: { name: "example", ecosystem: "npm" },
        badge: {
          eligible: false,
          switchedOffByYou: false,
          switchedOffElsewhere: false,
          answersByDefault: false,
          listed: false,
          canManage: false,
        },
      },
    });
  });
  await page.route("**/public/badge/npm/example", (route) =>
    route.fulfill({ json: { label: "Drydock", message: "unknown", color: "grey" } }),
  );
  return reads;
}

test("the package page watches directly with the personal flag and turns a pending claim into the choice card", async ({
  page,
}) => {
  await installSettingsMocks(page, true);
  let releaseClaim!: () => void;
  const claimHeld = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });
  let pending = false;
  const posts: unknown[] = [];
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.route("**/api/v1/npm-package-claims/**", async (route) => {
    await claimHeld;
    await route.fulfill({
      json: {
        claim: pending ? { kind: "personal", managementConfirmed: false, canManage: true } : null,
        destinations: [],
      },
    });
  });
  await mockPackageReads(page);
  await page.route("**/api/v1/publication-watches/packages/example", (route) =>
    route.fulfill({
      json: {
        packageName: "example",
        ownershipConflict: false,
        managementPending: pending,
        watch: null,
        observations: [],
        alerts: [],
        moreAlerts: false,
        enrollment: { state: "not_enrolled" },
        viewer: { canStop: true },
      },
    }),
  );
  await page.route("**/api/v1/publication-watches", async (route) => {
    posts.push(route.request().postDataJSON());
    // A stage reviewed since the page loaded left a pending personal claim.
    pending = true;
    await route.fulfill({
      status: 409,
      json: {
        error: "Choose an organization for this package before enabling monitoring.",
        code: "package_management_required",
      },
    });
  });
  await page.goto("/dashboard/packages/example?org=org-guide");
  await expect(page.getByText("public endpoint says")).toBeVisible();
  // Until the claim is read, the badge cannot tell its manager from a bystander.
  await expect(page.getByText(/Only the organization that manages this package/)).toHaveCount(0);
  releaseClaim();
  await expect(page.getByText(/Only the organization that manages this package/)).toBeVisible();
  await page.getByRole("button", { name: "Watch package", exact: true }).click();
  await expect(
    page.getByText("Choose where this package is managed", { exact: true }),
  ).toBeVisible();
  expect(posts).toEqual([{ packageName: "example", confirmPersonalOrganization: true }]);
  await expect(page.getByRole("button", { name: "Watch package", exact: true })).toHaveCount(0);
  await expect(page.getByText(/Only the organization that manages this package/)).toHaveCount(0);
  await expect(page.getByText("Choose where this package is managed")).toHaveCount(1);
  expect(browserErrors).toEqual([]);
});
