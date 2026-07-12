import { expect, test, type Page, type Route } from "@playwright/test";

const selectedChannelId = "C_RELEASES";

test("Slack selector reflects the saved channel after channels load", async ({ page }) => {
  let releaseChannels!: () => void;
  const channelsReady = new Promise<void>((resolve) => {
    releaseChannels = resolve;
  });

  await installSettingsMocks(page, channelsReady);
  await page.goto("/dashboard/settings?tab=notifications");

  const selector = page.getByLabel("Channel", { exact: true });
  await expect(selector).toHaveValue(selectedChannelId);

  releaseChannels();

  await expect(selector).toBeEnabled();
  await expect(selector).toHaveValue(selectedChannelId);
  await expect(selector.locator("option:checked")).toHaveText("#package-releases");
  await expect(selector.locator(`option[value="${selectedChannelId}"]`)).toHaveCount(1);
});

async function installSettingsMocks(page: Page, channelsReady: Promise<void>) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth/get-session") {
      await fulfillJson(route, {
        user: {
          id: "user-slack-selector",
          name: "Slack Selector Tester",
          email: "slack-selector@example.test",
          twoFactorEnabled: false,
        },
      });
      return;
    }

    if (path === "/api/v1/organizations") {
      await fulfillJson(route, {
        organizations: [
          {
            id: "org-slack-selector",
            name: "Drydock",
            ownerUserId: "user-slack-selector",
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

    if (path === "/api/v1/slack/channels") {
      await channelsReady;
      await fulfillJson(route, {
        channels: [
          { id: "C_ANNOUNCEMENTS", name: "announcements" },
          { id: selectedChannelId, name: "package-releases" },
        ],
      });
      return;
    }

    if (path === "/api/v1/slack") {
      await fulfillJson(route, {
        configured: true,
        connection: {
          teamId: "T_DRYDOCK",
          teamName: "Drydock",
          channelId: selectedChannelId,
          channelName: "package-releases",
          canListChannels: true,
          enabled: true,
          createdAt: "2026-07-12T00:00:00.000Z",
        },
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
