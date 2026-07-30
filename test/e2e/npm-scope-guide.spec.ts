import { expect, test, type Page, type Route } from "@playwright/test";

// The npm connection card states the exact granular-token permissions to pick.
// It has been dropped once already by an unrelated settings refactor, and its
// absence is invisible until a maintainer provisions the wrong token — so assert
// the permission rows, not just the card.
test("npm connection card names the exact token permissions", async ({ page }) => {
  await installSettingsMocks(page);
  await page.goto("/dashboard/settings?tab=integrations");

  const guide = page.getByText("token permissions to select").locator("xpath=..");
  await expect(guide).toBeVisible();

  await expect(guide.getByText("Granular access token")).toBeVisible();
  await expect(guide.locator("dt", { hasText: "packages and scopes" })).toBeVisible();
  await expect(guide.getByText("Read-only", { exact: true })).toBeVisible();
  await expect(guide.locator("dt", { hasText: "organizations" })).toBeVisible();
  await expect(guide.getByText("No access", { exact: true })).toBeVisible();
});

async function installSettingsMocks(page: Page) {
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
            isPersonal: false,
            npmConnectionConfigured: false,
            requireTwoFactorForReleaseDecisions: false,
            createdAt: "2026-07-12T00:00:00.000Z",
            updatedAt: "2026-07-12T00:00:00.000Z",
          },
        ],
      });
      return;
    }

    if (path === "/api/v1/npm-connection") {
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
