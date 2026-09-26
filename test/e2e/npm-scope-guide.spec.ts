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

async function installSettingsMocks(page: Page, personal = false, writes: unknown[] = []) {
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
          ...(personal
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
      await fulfillJson(route, { connection: null });
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
  test(`watch dialog ${target === "team" ? "transfer" : target === "personal" ? "confirmation" : "saved choice despite refresh failure"} refreshes the package management card`, async ({
    page,
  }) => {
    await installSettingsMocks(page, true);
    let confirmed = false;
    let moved = false;
    let watched = false;
    let badgeReads = 0;
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
      badgeReads++;
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
    await page.route("**/api/v1/publication-watches/packages/example", (route) =>
      route.fulfill({
        json: {
          packageName: "example",
          ownershipConflict: moved,
          managementPending: !confirmed,
          watch: watched
            ? {
                id: "watch-example",
                organizationId: "org-guide",
                packageName: "example",
                source: "manual",
                createdAt: "2026-09-26T00:00:00Z",
                unresolvedAlertCount: 0,
                unverifiedReleaseCount: 0,
              }
            : null,
          observations: [],
          alerts: [],
          moreAlerts: false,
          enrollment: { state: watched ? "watched" : "not_enrolled" },
          viewer: { canStop: true },
        },
      }),
    );
    await page.route("**/api/v1/publication-watches", async (route) => {
      watched = true;
      await route.fulfill({ json: { watch: {} } });
    });
    await page.goto("/dashboard/packages/example?org=org-guide");
    await expect(
      page.getByRole("button", { name: "Choose organization", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Watch package", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Choose where to watch this package" });
    if (target !== "team") {
      await dialog.getByLabel("Managing organization").selectOption("org-guide");
      await dialog.getByRole("button", { name: "Keep here and watch package" }).click();
      if (target === "personal_refresh_failure") {
        await expect(dialog.getByText(/Your package choice was saved/)).toBeVisible();
        await expect(page.getByText("watching", { exact: true })).toBeVisible();
      } else {
        await expect(dialog).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Move to organization", exact: true }),
        ).toBeVisible();
      }
    } else {
      await expect(dialog.getByLabel("Managing organization")).toHaveValue("org-team");
      await page.screenshot({
        path: ".context/e2e-artifacts/personal-package-organization-choice.png",
        fullPage: true,
      });
      await dialog.getByRole("button", { name: "Move to Release team" }).click();
      await expect(dialog.getByRole("link", { name: "Manage in Release team" })).toBeVisible();
      await expect(
        page.getByText("Managed in your personal workspace", { exact: true }),
      ).toHaveCount(0);
      await page.screenshot({
        path: ".context/e2e-artifacts/personal-package-dialog-transferred.png",
        fullPage: true,
      });
    }
    await expect(
      page.getByRole("button", { name: "Choose organization", exact: true }),
    ).toHaveCount(0);
    await expect.poll(() => badgeReads).toBeGreaterThan(1);
    expect(browserErrors).toEqual([]);
  });
}
