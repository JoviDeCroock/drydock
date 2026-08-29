import { expect, test, type Page, type Route } from "@playwright/test";

const workflowYaml = `name: Publish @acme/toolkit
on:
  workflow_dispatch:
jobs:
  publish:
    environment: production
`;

test("guided gate setup deep link keeps refused GitHub steps actionable", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await installGateSetupMocks(page);

  await page.goto("/dashboard/settings#gate-setup");

  const wizard = page.locator("#gate-setup");
  await expect(wizard.getByText("Guided gate setup")).toBeVisible();
  await expect(page.getByRole("button", { name: "Integrations" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await wizard.getByLabel("Installation").selectOption("installation-acme");
  await wizard.getByLabel("Repository", { exact: true }).selectOption("acme/toolkit");
  await wizard.getByLabel("Environment", { exact: true }).selectOption("__new__");
  await wizard.getByLabel("New environment name").fill("Production");
  await wizard.getByRole("button", { name: "Create it in GitHub" }).click();
  await expect(wizard.getByText("done", { exact: true })).toBeVisible();

  await wizard.getByRole("button", { name: "Enable Drydock protection rule" }).click();
  await expect(wizard.getByText("needs you", { exact: true })).toBeVisible();
  await expect(
    wizard.getByText("Enable Drydock manually in the production environment settings."),
  ).toBeVisible();

  await wizard.getByLabel("Ecosystem").selectOption("npm");
  await wizard.getByLabel("Package name").fill("@acme/toolkit");
  await wizard.getByRole("button", { name: "Generate workflow" }).click();
  await expect(wizard.getByText(".github/workflows/publish-acme-toolkit.yml")).toBeVisible();
  await expect(wizard.locator("pre")).toContainText("environment: production");

  await wizard.getByRole("button", { name: "Copy workflow" }).click();
  await expect(wizard.getByText("Copied.")).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(workflowYaml);

  await wizard.getByRole("button", { name: "Open a PR with this workflow" }).click();
  await expect(
    wizard.getByText("Commit the generated workflow manually on a new branch."),
  ).toBeVisible();
  await expect(wizard.getByText("pull request #", { exact: false })).toHaveCount(0);
  await expect(wizard.locator("pre")).toContainText("name: Publish @acme/toolkit");

  await wizard.getByRole("button", { name: "Create release target" }).click();
  await expect(wizard.getByText("gate configured", { exact: true })).toBeVisible();
  await expect(wizard.getByText("mapped", { exact: true })).toBeVisible();
  await expect(wizard.getByText("env production", { exact: true })).toBeVisible();
});

async function installGateSetupMocks(page: Page) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/api/auth/get-session") {
      await fulfillJson(route, {
        user: {
          id: "user-gate-setup",
          name: "Gate Setup Tester",
          email: "gate-setup@example.test",
          twoFactorEnabled: false,
        },
      });
      return;
    }

    if (path === "/api/v1/organizations") {
      await fulfillJson(route, {
        organizations: [
          {
            id: "org-gate-setup",
            name: "Acme",
            ownerUserId: "user-gate-setup",
            role: "owner",
            isPersonal: false,
            npmConnectionConfigured: false,
            requireTwoFactorForReleaseDecisions: false,
            createdAt: "2026-08-29T00:00:00.000Z",
            updatedAt: "2026-08-29T00:00:00.000Z",
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
      await fulfillJson(route, {
        configured: true,
        appSlug: "drydock-test",
        gateSetupEcosystems: [
          { id: "npm", label: "npm" },
          { id: "pypi", label: "PyPI" },
        ],
      });
      return;
    }

    if (path === "/api/v1/github-app/installations") {
      await fulfillJson(route, {
        installations: [
          installation("installation-other", "other"),
          installation("installation-acme", "acme"),
        ],
      });
      return;
    }

    if (path === "/api/v1/github-app/release-targets") {
      if (request.method() === "POST") {
        expect(JSON.parse(request.postData() || "{}"), "release-target handoff").toEqual({
          installationRowId: "installation-acme",
          repositoryFullName: "acme/toolkit",
          environment: "production",
          ecosystem: "npm",
        });
        await fulfillJson(route, {
          releaseTarget: releaseTarget(),
        });
      } else {
        await fulfillJson(route, { releaseTargets: [] });
      }
      return;
    }

    if (path === "/api/v1/github-app/installations/installation-other/repositories") {
      await fulfillJson(route, { repositories: [] });
      return;
    }

    if (path === "/api/v1/github-app/installations/installation-acme/repositories") {
      await fulfillJson(route, {
        repositories: [{ id: 42, fullName: "acme/toolkit", defaultBranch: "main" }],
      });
      return;
    }

    if (
      path ===
      "/api/v1/github-app/installations/installation-acme/repositories/acme/toolkit/environments"
    ) {
      await fulfillJson(route, { environments: [{ name: "staging" }] });
      return;
    }

    if (path === "/api/v1/github-app/gate-setup/environment") {
      expectGateSetupDraft(request, "npm", "@acme/toolkit", false);
      await fulfillJson(route, {
        step: { step: "environment", status: "created" },
      });
      return;
    }

    if (path === "/api/v1/github-app/gate-setup/protection-rule") {
      expectGateSetupDraft(request, "npm", "@acme/toolkit", false);
      await fulfillJson(route, {
        step: {
          step: "protection_rule",
          status: "failed",
          failure: {
            code: "permission_denied",
            message: "GitHub refused the protection-rule mutation.",
            manualFallback: "Enable Drydock manually in the production environment settings.",
          },
        },
      });
      return;
    }

    if (path === "/api/v1/github-app/gate-setup/preview") {
      expectGateSetupDraft(request);
      await fulfillJson(route, workflowPreview());
      return;
    }

    if (path === "/api/v1/github-app/gate-setup/pull-request") {
      expectGateSetupDraft(request);
      await fulfillJson(route, {
        step: {
          step: "pull_request",
          status: "failed",
          failure: {
            code: "workflow_scope_missing",
            message: "The installation cannot write workflow files.",
            manualFallback: "Commit the generated workflow manually on a new branch.",
          },
        },
        pullRequest: null,
        ...workflowPreview(),
      });
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

    await fulfillJson(route, { error: `unexpected request: ${request.method()} ${path}` }, 404);
  });
}

function expectGateSetupDraft(
  request: { postData(): string | null },
  ecosystem = "npm",
  packageName = "@acme/toolkit",
  requirePackage = true,
) {
  const expected: Record<string, string> = {
    installationRowId: "installation-acme",
    repositoryFullName: "acme/toolkit",
    environment: "production",
  };
  if (requirePackage) {
    expected.ecosystem = ecosystem;
    expected.packageName = packageName;
  }
  expect(JSON.parse(request.postData() || "{}"), "gate-setup draft").toEqual(
    requirePackage ? expected : { ...expected, ecosystem: "", packageName: "" },
  );
}

function installation(id: string, accountLogin: string) {
  return {
    id,
    organizationId: "org-gate-setup",
    installationId: id === "installation-acme" ? "2002" : "1001",
    accountLogin,
    accountType: "Organization",
    targetType: "selected",
    status: "active",
    installedAt: "2026-08-29T00:00:00.000Z",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
}

function workflowPreview() {
  return {
    workflowPath: ".github/workflows/publish-acme-toolkit.yml",
    yaml: workflowYaml,
    notes: ["Require trusted publishing after this workflow is merged."],
  };
}

function releaseTarget() {
  return {
    id: "release-target-acme",
    organizationId: "org-gate-setup",
    installationRowId: "installation-acme",
    ecosystem: "npm",
    artifactName: null,
    repositoryId: 42,
    repositoryFullName: "acme/toolkit",
    environment: "production",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
}

async function fulfillJson(route: Route, json: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(json),
  });
}
