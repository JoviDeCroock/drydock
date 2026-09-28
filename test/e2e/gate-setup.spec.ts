import { expect, test, type Page, type Route } from "@playwright/test";

const workflowYaml = `name: Publish @acme/toolkit
on:
  workflow_dispatch:
jobs:
  publish:
    environment: production
`;

test("guided gate setup verifies GitHub rather than reporting its own bookkeeping", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const mocks = await installGateSetupMocks(page, {
    environments: ["production"],
    verifyStates: [
      // The environment exists but Drydock is not yet its protection rule, so
      // nothing holds a deployment — the state that must never read as armed.
      { environment: "present", protectionRule: "absent", defaultBranch: "main" },
      { environment: "present", protectionRule: "present", defaultBranch: "main" },
    ],
  });

  await page.goto("/dashboard/settings#gate-setup");

  const wizard = page.locator("#gate-setup");
  await expect(wizard.getByText("Guided gate setup")).toBeVisible();
  await expect(page.getByRole("button", { name: "Integrations" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await wizard.getByLabel("Installation").selectOption("installation-acme");
  await wizard.getByLabel("Repository", { exact: true }).selectOption("acme/toolkit");
  await wizard.getByLabel("Environment", { exact: true }).selectOption("production");

  // Selecting an environment verifies it without a click; the rule is missing.
  await expect(wizard.getByText("is not yet a protection rule", { exact: false })).toBeVisible();
  await expect(wizard.getByText("gate armed", { exact: true })).toHaveCount(0);

  await expect(wizard.getByRole("link", { name: "Open environment settings ↗" })).toHaveAttribute(
    "href",
    "https://github.com/acme/toolkit/settings/environments",
  );

  await wizard.getByRole("button", { name: "Check the rule" }).click();
  await expect(
    wizard.getByText("GitHub confirms Drydock is a deployment-protection rule", { exact: false }),
  ).toBeVisible();

  await wizard.getByLabel("Ecosystem").selectOption("npm");
  await wizard.getByLabel("Package name").fill("@acme/toolkit");
  await wizard.getByRole("button", { name: "Generate workflow" }).click();
  await expect(wizard.getByText(".github/workflows/publish-acme-toolkit.yml")).toBeVisible();
  await expect(wizard.locator("pre")).toContainText("environment: production");
  // The path is a real path, not a label. `getByText` folds case, so assert the
  // rendered casing through the computed style instead.
  await expect(wizard.getByText(".github/workflows/publish-acme-toolkit.yml")).toHaveCSS(
    "text-transform",
    "none",
  );

  // The lockdown list carries the GitHub-side hardening the removed pull-request
  // body used to be the only place to read.
  await expect(wizard.getByText("Allow administrators to bypass", { exact: false })).toBeVisible();

  await wizard.getByRole("button", { name: "Copy workflow" }).click();
  await expect(wizard.getByText("Copied.")).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(workflowYaml);

  const commitLink = wizard.getByRole("link", { name: "Commit it on GitHub ↗" });
  await expect(commitLink).toHaveAttribute(
    "href",
    /github\.com\/acme\/toolkit\/new\/main\?filename=/,
  );

  await wizard.getByRole("button", { name: "Create release target" }).click();
  await expect(wizard.getByText("gate armed", { exact: true })).toBeVisible();
  await expect(wizard.getByText("Gate armed", { exact: true })).toBeVisible();
  expect(mocks.releaseTargetRequests).toContainEqual({
    installationRowId: "installation-acme",
    repositoryFullName: "acme/toolkit",
    environment: "production",
    ecosystem: "npm",
  });
  // Every gate-setup call was a read; the wizard never asked Drydock to change
  // anything on the repository.
  expect(mocks.verifyRequests.length).toBeGreaterThan(0);
});

test("a verification Drydock could not complete never reads as a configured gate", async ({
  page,
}) => {
  await installGateSetupMocks(page, {
    environments: ["production"],
    verifyStates: [
      {
        environment: "unknown",
        protectionRule: "unknown",
        defaultBranch: null,
        unavailableReason: "Drydock could not reach GitHub. Retry in a moment.",
      },
    ],
  });

  await page.goto("/dashboard/settings#gate-setup");

  const wizard = page.locator("#gate-setup");
  await wizard.getByLabel("Installation").selectOption("installation-acme");
  await wizard.getByLabel("Repository", { exact: true }).selectOption("acme/toolkit");
  await wizard.getByLabel("Environment", { exact: true }).selectOption("production");

  await expect(wizard.getByText("could not reach GitHub", { exact: false })).toBeVisible();
  await wizard.getByRole("button", { name: "Create release target" }).click();

  // Mapped, but unverified: the summary must not claim a gate.
  await expect(wizard.getByText("done", { exact: true }).first()).toBeVisible();
  await expect(wizard.getByText("gate armed", { exact: true })).toHaveCount(0);
});

test("an existing release target must be removed before changing its ecosystem", async ({
  page,
}) => {
  const mocks = await installGateSetupMocks(page, { existingReleaseTarget: true });

  await page.goto("/dashboard/settings#gate-setup");

  const wizard = page.locator("#gate-setup");
  await wizard.getByLabel("Installation").selectOption("installation-acme");
  await wizard.getByLabel("Repository", { exact: true }).selectOption("acme/toolkit");
  await wizard.getByLabel("Environment", { exact: true }).selectOption("staging");

  await expect(wizard.getByLabel("Ecosystem")).toHaveValue("npm");
  await expect(wizard.getByLabel("Ecosystem")).toBeDisabled();
  await wizard.getByRole("button", { name: "Remove mapping" }).click();

  await expect(wizard.getByRole("button", { name: "Create release target" })).toBeVisible();
  await expect(wizard.getByLabel("Ecosystem")).toBeEnabled();
  await wizard.getByLabel("Ecosystem").selectOption("pypi");
  await wizard.getByRole("button", { name: "Create release target" }).click();

  await expect(wizard.getByText("env staging", { exact: true })).toBeVisible();
  expect(mocks.releaseTargetRequests.at(-1)).toEqual({
    installationRowId: "installation-acme",
    repositoryFullName: "acme/toolkit",
    environment: "staging",
    ecosystem: "pypi",
  });
});

test("a broader existing GitHub environment blocks only the generated workflow", async ({
  page,
}) => {
  const mocks = await installGateSetupMocks(page, { environments: ["production/eu"] });

  await page.goto("/dashboard/settings#gate-setup");

  const wizard = page.locator("#gate-setup");
  await wizard.getByLabel("Installation").selectOption("installation-acme");
  await wizard.getByLabel("Repository", { exact: true }).selectOption("acme/toolkit");
  await wizard.getByLabel("Environment", { exact: true }).selectOption("production/eu");

  await wizard.getByLabel("Ecosystem").selectOption("npm");
  await wizard.getByLabel("Package name").fill("@acme/toolkit");
  await expect(wizard.getByText("cannot generate a workflow", { exact: false })).toBeVisible();
  await expect(wizard.getByRole("button", { name: "Generate workflow" })).toBeDisabled();

  // Verifying and mapping the hand-made environment still has to work, and it
  // is the next step: the flow does not park on the workflow it cannot write.
  await expect(wizard.getByRole("button", { name: "Create release target" })).toBeEnabled();
  const releaseTargetStep = wizard
    .locator("div", { has: page.getByText("6 · Release target") })
    .last();
  await expect(releaseTargetStep.getByText("now", { exact: true })).toBeVisible();
  await wizard.getByRole("button", { name: "Create release target" }).click();
  await expect(wizard.getByText("env production/eu", { exact: true })).toBeVisible();
  await expect(wizard.getByText("Gate armed", { exact: true })).toBeVisible();
  expect(mocks.releaseTargetRequests.at(-1)).toEqual({
    installationRowId: "installation-acme",
    repositoryFullName: "acme/toolkit",
    environment: "production/eu",
    ecosystem: "npm",
  });
});

test("removing the mapping from the GitHub App card withdraws the armed claim", async ({
  page,
}) => {
  await installGateSetupMocks(page, { environments: ["production"] });

  await page.goto("/dashboard/settings#gate-setup");

  const wizard = page.locator("#gate-setup");
  await wizard.getByLabel("Installation").selectOption("installation-acme");
  await wizard.getByLabel("Repository", { exact: true }).selectOption("acme/toolkit");
  await wizard.getByLabel("Environment", { exact: true }).selectOption("production");
  await wizard.getByRole("button", { name: "Create release target" }).click();
  await expect(wizard.getByText("gate armed", { exact: true })).toBeVisible();

  // The mapping goes away somewhere the wizard's own remove never ran.
  await page.getByRole("button", { name: "Remove", exact: true }).click();

  await expect(wizard.getByText("gate armed", { exact: true })).toHaveCount(0);
  await expect(wizard.getByRole("button", { name: "Create release target" })).toBeVisible();
  await expect(wizard.getByText("env production", { exact: true })).toHaveCount(0);
});

test("a failed list refresh after creating the mapping keeps the gate armed", async ({ page }) => {
  // Another environment is already mapped, so a failed refresh would change
  // the parent's list (to empty) rather than leave it as it was.
  await installGateSetupMocks(page, {
    existingReleaseTarget: true,
    environments: ["production"],
    failReleaseTargetReloads: true,
  });

  await page.goto("/dashboard/settings#gate-setup");

  const wizard = page.locator("#gate-setup");
  await wizard.getByLabel("Installation").selectOption("installation-acme");
  await wizard.getByLabel("Repository", { exact: true }).selectOption("acme/toolkit");
  await wizard.getByLabel("Environment", { exact: true }).selectOption("production");
  await wizard.getByRole("button", { name: "Create release target" }).click();

  // The refetch the create triggers fails. That says nothing about the
  // mapping, so it must not read as "no mapping" and offer a duplicate create.
  await expect(wizard.getByText("gate armed", { exact: true })).toBeVisible();
  await expect(wizard.getByRole("button", { name: "Remove mapping" })).toBeVisible();
  await expect(wizard.getByRole("button", { name: "Create release target" })).toHaveCount(0);
});

test("a returning maintainer's automatic verification survives the ecosystem pin", async ({
  page,
}) => {
  const mocks = await installGateSetupMocks(page, {
    existingReleaseTarget: true,
    // Slow enough that the stored mapping pins the ecosystem while this check
    // is still in flight — the race that used to discard it.
    verifyDelayMs: 400,
  });

  await page.goto("/dashboard/settings#gate-setup");

  const wizard = page.locator("#gate-setup");
  await wizard.getByLabel("Installation").selectOption("installation-acme");
  await wizard.getByLabel("Repository", { exact: true }).selectOption("acme/toolkit");
  await wizard.getByLabel("Environment", { exact: true }).selectOption("staging");

  await expect(wizard.getByLabel("Ecosystem")).toHaveValue("npm");
  await expect(
    wizard.getByText("GitHub confirms Drydock is a deployment-protection rule", { exact: false }),
  ).toBeVisible();
  await expect(wizard.getByText("gate armed", { exact: true })).toBeVisible();
  // One automatic check, and its answer landed: nothing had to be re-clicked.
  expect(mocks.verifyRequests).toHaveLength(1);
});

test("an environment GitHub confirms with an unreadable rule is not a gate", async ({ page }) => {
  await installGateSetupMocks(page, {
    existingReleaseTarget: true,
    verifyStates: [
      {
        environment: "present",
        protectionRule: "unknown",
        defaultBranch: "main",
        unavailableReason: "The Drydock App installation cannot read this repository's settings.",
      },
    ],
  });

  await page.goto("/dashboard/settings#gate-setup");

  const wizard = page.locator("#gate-setup");
  await wizard.getByLabel("Installation").selectOption("installation-acme");
  await wizard.getByLabel("Repository", { exact: true }).selectOption("acme/toolkit");
  await wizard.getByLabel("Environment", { exact: true }).selectOption("staging");

  // Mapped and the environment exists, but the rule could not be read: "could
  // not check" in the rule step, never either answer, and no armed badge.
  await expect(
    wizard.getByText("cannot read this repository's settings", { exact: false }),
  ).toBeVisible();
  await expect(wizard.getByText("env staging", { exact: true })).toBeVisible();
  await expect(wizard.getByText("gate armed", { exact: true })).toHaveCount(0);
  await expect(wizard.getByRole("button", { name: "Check the rule" })).toBeVisible();
});

test("a failed re-check withdraws the armed claim in the step that asked", async ({ page }) => {
  await installGateSetupMocks(page, {
    existingReleaseTarget: true,
    verifyStates: [
      { environment: "present", protectionRule: "present", defaultBranch: "main" },
      { fail: true },
    ],
  });

  await page.goto("/dashboard/settings#gate-setup");

  const wizard = page.locator("#gate-setup");
  await wizard.getByLabel("Installation").selectOption("installation-acme");
  await wizard.getByLabel("Repository", { exact: true }).selectOption("acme/toolkit");
  await wizard.getByLabel("Environment", { exact: true }).selectOption("staging");
  await expect(wizard.getByText("gate armed", { exact: true })).toBeVisible();

  await wizard.getByRole("button", { name: "Re-check" }).click();

  await expect(wizard.getByText("gate armed", { exact: true })).toHaveCount(0);
  // Rendered once, next to "Re-check" in step 3, rather than up in step 2.
  const failure = wizard.getByRole("alert").filter({ hasText: "Drydock could not check GitHub" });
  await expect(failure).toHaveCount(1);
  const order = await wizard.evaluate((root) => {
    const all = [...root.querySelectorAll("*")];
    const heading = (label: string) =>
      all.findIndex((el) => el.tagName === "H3" && el.textContent?.startsWith(label));
    const alert = all.findIndex(
      (el) =>
        el.getAttribute("role") === "alert" &&
        el.textContent?.includes("Drydock could not check GitHub"),
    );
    return { rule: heading("3 ·"), workflow: heading("4 ·"), alert };
  });
  expect(order.alert).toBeGreaterThan(order.rule);
  expect(order.alert).toBeLessThan(order.workflow);
  // Nothing is left in flight: both checks can be asked for again.
  await expect(wizard.getByRole("button", { name: "Check it" })).toBeEnabled();
  await expect(wizard.getByRole("button", { name: "Check the rule" })).toBeEnabled();
});

test("an armed rule that admins can bypass says so beside the rule", async ({ page }) => {
  await installGateSetupMocks(page, {
    existingReleaseTarget: true,
    verifyStates: [
      {
        environment: "present",
        protectionRule: "present",
        adminBypass: "allowed",
        defaultBranch: "main",
      },
    ],
  });

  await page.goto("/dashboard/settings#gate-setup");

  const wizard = page.locator("#gate-setup");
  await wizard.getByLabel("Installation").selectOption("installation-acme");
  await wizard.getByLabel("Repository", { exact: true }).selectOption("acme/toolkit");
  await wizard.getByLabel("Environment", { exact: true }).selectOption("staging");

  // A warning, not a failed check: the rule still holds every run nobody
  // overrides, so the gate is armed.
  await expect(wizard.getByText("gate armed", { exact: true })).toBeVisible();
  await expect(
    wizard.getByText("Repository admins can still push a held release past Drydock", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    wizard.getByRole("link", { name: "Uncheck it in the environment settings ↗" }),
  ).toHaveAttribute("href", "https://github.com/acme/toolkit/settings/environments");
});

test("the deep link selects Integrations once, not on every tab change", async ({ page }) => {
  await installGateSetupMocks(page);

  await page.goto("/dashboard/settings#gate-setup");
  await expect(page.locator("#gate-setup details").first()).toHaveAttribute("open", "");

  await page.getByRole("button", { name: "General" }).click();
  await expect(page.getByRole("button", { name: "General" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // The old snap-back ran in the effect after the tab's URL write, so let a
  // couple of frames pass before checking the choice held.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await expect(page.getByRole("button", { name: "General" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page).not.toHaveURL(/tab=integrations/);

  await page.getByRole("button", { name: "Integrations" }).click();
  // Back on the tab by choice: the wizard is there, but not reopened for them.
  await expect(page.locator("#gate-setup")).toBeVisible();
  await expect(page.locator("#gate-setup details").first()).not.toHaveAttribute("open", "");
});

async function installGateSetupMocks(
  page: Page,
  {
    existingReleaseTarget = false,
    environments = ["staging"],
    verifyStates = [{ environment: "present", protectionRule: "present", defaultBranch: "main" }],
    verifyDelayMs = 0,
    failReleaseTargetReloads = false,
  }: {
    existingReleaseTarget?: boolean;
    environments?: string[];
    /**
     * Consumed one per `verify` call; the last entry repeats. `fail` answers
     * the call with a 500 instead of a state.
     */
    verifyStates?: (
      | {
          environment: string;
          protectionRule: string;
          adminBypass?: string;
          defaultBranch?: string | null;
          unavailableReason?: string;
        }
      | { fail: true }
    )[];
    /** Holds every `verify` answer back, to race it against the wizard's effects. */
    verifyDelayMs?: number;
    /** Every release-target list load after a create answers 500. */
    failReleaseTargetReloads?: boolean;
  } = {},
) {
  let storedReleaseTargets = existingReleaseTarget
    ? [releaseTarget({ environment: "staging" })]
    : [];
  const releaseTargetRequests: Record<string, unknown>[] = [];
  const verifyRequests: Record<string, unknown>[] = [];
  let verifyCalls = 0;

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
        const body = JSON.parse(request.postData() || "{}") as Record<string, unknown>;
        releaseTargetRequests.push(body);
        const created = releaseTarget({
          ecosystem: body.ecosystem === "npm" || body.ecosystem === "pypi" ? body.ecosystem : null,
          environment: typeof body.environment === "string" ? body.environment : "production",
        });
        storedReleaseTargets = [created];
        await fulfillJson(route, {
          releaseTarget: created,
        });
      } else if (failReleaseTargetReloads && releaseTargetRequests.length > 0) {
        await fulfillJson(route, { error: "internal error" }, 500);
      } else {
        await fulfillJson(route, { releaseTargets: storedReleaseTargets });
      }
      return;
    }

    if (
      path === "/api/v1/github-app/release-targets/release-target-acme" &&
      request.method() === "DELETE"
    ) {
      storedReleaseTargets = [];
      await fulfillJson(route, { ok: true });
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
      await fulfillJson(route, { environments: environments.map((name) => ({ name })) });
      return;
    }

    if (path === "/api/v1/github-app/gate-setup/preview") {
      expectGateSetupDraft(request);
      await fulfillJson(route, workflowPreview());
      return;
    }

    if (path === "/api/v1/github-app/gate-setup/verify") {
      const body = JSON.parse(request.postData() || "{}") as Record<string, unknown>;
      verifyRequests.push(body);
      const state = verifyStates[Math.min(verifyCalls++, verifyStates.length - 1)];
      if (verifyDelayMs) await new Promise((resolve) => setTimeout(resolve, verifyDelayMs));
      if ("fail" in state) {
        await fulfillJson(route, { error: "internal error" }, 500);
      } else {
        await fulfillJson(route, { state });
      }
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

  return { releaseTargetRequests, verifyRequests };
}

function expectGateSetupDraft(
  request: { postData(): string | null },
  ecosystem = "npm",
  packageName = "@acme/toolkit",
) {
  expect(JSON.parse(request.postData() || "{}"), "gate-setup draft").toEqual({
    installationRowId: "installation-acme",
    repositoryFullName: "acme/toolkit",
    environment: "production",
    ecosystem,
    packageName,
  });
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

function releaseTarget({
  ecosystem = "npm",
  environment = "production",
}: {
  ecosystem?: "npm" | "pypi" | null;
  environment?: string;
} = {}) {
  return {
    id: "release-target-acme",
    organizationId: "org-gate-setup",
    installationRowId: "installation-acme",
    ecosystem,
    artifactName: null,
    repositoryId: 42,
    repositoryFullName: "acme/toolkit",
    environment,
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
