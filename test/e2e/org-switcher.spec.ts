import { expect, test } from "@playwright/test";

test("OrgSwitcher trigger updates after organizations load", async ({ page }) => {
  let releaseOrganizations: (() => void) | null = null;

  await page.route("**/api/auth/get-session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: {
          id: "user-org-switcher",
          name: "Org Switcher Tester",
          email: "org-switcher@example.test",
          twoFactorEnabled: false,
        },
      }),
    });
  });

  await page.route("**/api/v1/organizations", async (route) => {
    await new Promise<void>((resolve) => {
      releaseOrganizations = resolve;
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        organizations: [
          {
            id: "org-acme",
            name: "Acme Widgets",
            ownerUserId: "user-org-switcher",
            role: "owner",
            isPersonal: false,
            npmConnectionConfigured: true,
            requireTwoFactorForReleaseDecisions: false,
            createdAt: "2026-06-15T12:00:00.000Z",
            updatedAt: "2026-06-15T12:00:00.000Z",
          },
        ],
      }),
    });
  });

  await page.route("**/api/v1/scans**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        scans: [
          {
            id: "scan-failed-menu",
            stageId: "stage-failed-menu",
            source: "npm",
            organizationId: "org-acme",
            ownerUserId: "user-org-switcher",
            packageName: "@acme/failed-release",
            stagedVersion: "2.0.0",
            previousVersion: "1.0.0",
            risk: "unknown",
            status: "failed",
            decision: null,
            createdAt: "2026-06-15T12:00:00.000Z",
            updatedAt: "2026-06-15T12:00:00.000Z",
          },
        ],
        nextCursor: null,
        filter: "undecided",
        limit: 50,
      }),
    });
  });

  await page.route("**/api/v1/npm-connection", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connection: {
          id: "npm-connection-org-acme",
          organizationId: "org-acme",
          registryUrl: "https://registry.npmjs.org",
          label: "npm registry",
          tokenFingerprint: "sha256:abc123",
          tokenLast4: "1234",
          validationStatus: "valid",
          capabilitiesJson: {
            registryAuth: true,
            stagedTarballAccess: true,
            whoami: "org-switcher@example.test",
            registryUrl: "https://registry.npmjs.org",
          },
          validatedAt: "2026-06-15T12:00:00.000Z",
          lastUsedAt: null,
          createdByUserId: "user-org-switcher",
          createdAt: "2026-06-15T12:00:00.000Z",
          updatedAt: "2026-06-15T12:00:00.000Z",
        },
      }),
    });
  });

  await page.goto("/dashboard");

  const switcher = page.getByRole("button", { name: "Switch organization" });
  await expect(switcher).toBeVisible();
  await expect(switcher).toContainText("no organizations");

  releaseOrganizations?.();

  await expect(switcher).toContainText("Acme Widgets");
  await switcher.click();

  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute("popover", "manual");
  expect(await menu.evaluate((node) => node.matches(":popover-open"))).toBe(true);

  const box = await menu.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(8);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width - 8);
  expect(box!.y).toBeGreaterThanOrEqual(8);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height - 8);

  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 480, height: 360 });

  const actions = page.getByRole("button", { name: "More actions for @acme/failed-release" });
  await actions.evaluate((node) => node.scrollIntoView({ block: "end" }));
  const triggerBox = await actions.boundingBox();
  await actions.click();

  const actionsMenu = page.getByRole("menu");
  await expect(actionsMenu).toBeVisible();
  await expect(actionsMenu.getByRole("menuitem", { name: "Delete review" })).toBeVisible();
  const actionsBox = await actionsMenu.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(actionsBox!.y + actionsBox!.height).toBeLessThanOrEqual(triggerBox!.y);
});
