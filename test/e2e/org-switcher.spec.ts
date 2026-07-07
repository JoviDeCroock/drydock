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
        scans: [],
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
});
