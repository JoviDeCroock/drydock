import { expect, test, type Page } from "@playwright/test";
import type {
  PublisherSetupDraft,
  PublisherSetupStatus,
} from "../../server/lib/github-app/setup-types";
import {
  SETUP_ORIGINAL_WORKFLOW,
  SETUP_PROPOSED_WORKFLOW,
} from "../helpers/publisher-setup-fixtures";

const now = "2026-10-28T10:00:00.000Z";
const baseSha = "a".repeat(40);
const workflowPath = ".github/workflows/release.yml";
const currentWorkflow = SETUP_ORIGINAL_WORKFLOW;
const proposedWorkflow = SETUP_PROPOSED_WORKFLOW.replace(
  "environment: production",
  "environment: drydock",
);

function proposal(): PublisherSetupDraft {
  return {
    proposal: {
      installationRowId: "installation-setup",
      repositoryFullName: "drydock/example",
      repositoryId: 101,
      defaultBranch: "main",
      baseSha,
      workflowPath,
      originalSha: "b".repeat(40),
      environment: "drydock",
      ecosystem: "npm",
      content: proposedWorkflow,
      summary: "Hold the publishing job behind the drydock environment.",
      manualSteps: [
        "Enable the Drydock deployment protection rule on the drydock environment.",
        "Review the proposed workflow before merging it.",
      ],
      expiresAt: Date.now() + 900_000,
    },
    proposalToken: "local-signed-proposal-fixture",
  };
}

function setupStatus(complete: boolean): PublisherSetupStatus {
  return {
    repositoryFullName: "drydock/example",
    environment: "drydock",
    targetMapped: true,
    environmentExists: true,
    protectionEnabled: true,
    administratorsCanBypass: false,
    firstReview: complete
      ? {
          gateId: "gate-setup",
          scanId: "scan-setup",
          status: "pending",
          scanStatus: "complete",
          requestedAt: now,
          completedAt: now,
        }
      : null,
    checks: [
      {
        label: "Drydock environment protection",
        status: "passed",
        detail: "The selected environment has Drydock enabled.",
      },
      {
        label: "First pre-publish review",
        status: complete ? "passed" : "pending",
        detail: complete
          ? "A candidate has been reviewed."
          : "Run a release workflow to verify it.",
      },
    ],
  };
}

async function installSetupMocks(page: Page, permissionDenied = false) {
  const observations = { created: 0, complete: false, requests: [] as string[] };
  const signedDraft = proposal();
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    observations.requests.push(`${method} ${path}`);
    let json: unknown;
    if (path === "/api/auth/config") {
      json = { githubSignIn: false, emailVerification: true, passwordReset: false };
    } else if (path === "/api/auth/get-session") {
      json = {
        user: {
          id: "user-setup",
          name: "Setup Tester",
          email: "setup@example.test",
          emailVerified: true,
          twoFactorEnabled: false,
        },
      };
    } else if (path === "/api/v1/organizations") {
      json = {
        organizations: [
          {
            id: "org-setup",
            name: "Release team",
            ownerUserId: "user-setup",
            role: "owner",
            isPersonal: false,
            npmConnectionConfigured: false,
            requireTwoFactorForReleaseDecisions: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
    } else if (path === "/api/v1/npm-connection") json = { connection: null };
    else if (path === "/api/v1/github-app/config") json = { configured: true, appSlug: "drydock" };
    else if (path === "/api/v1/github-app/installations") {
      json = {
        installations: [
          {
            id: "installation-setup",
            organizationId: "org-setup",
            installationId: "123",
            accountLogin: "drydock",
            accountType: "Organization",
            targetType: "Organization",
            status: "active",
            installedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
    } else if (path.endsWith("/repositories")) {
      json = {
        repositories: [
          { id: 101, fullName: "drydock/example", defaultBranch: "main" },
          { id: 102, fullName: "drydock/other", defaultBranch: "main" },
        ],
      };
    } else if (path.endsWith("/environments")) json = { environments: [{ name: "drydock" }] };
    else if (path === "/api/v1/github-app/release-targets") json = { releaseTargets: [] };
    else if (path === "/api/v1/slack") json = { configured: false, connection: null };
    else if (path.endsWith("/notification-recipients")) json = { recipients: [] };
    else if (path === "/api/v1/organizations/members") json = { members: [] };
    else if (path === "/api/v1/organizations/invitations") json = { invitations: [] };
    else if (path === "/api/v1/audit-events") json = { events: [], nextCursor: null };
    else if (path === "/api/v1/github-app/setup/inspect") {
      expect(request.postDataJSON()).toEqual({
        installationRowId: "installation-setup",
        repositoryFullName: "drydock/example",
      });
      json = {
        inspection: {
          installationRowId: "installation-setup",
          repositoryFullName: "drydock/example",
          repositoryId: 101,
          defaultBranch: "main",
          baseSha,
          workflows: [{ path: workflowPath, sha: "b".repeat(40), content: currentWorkflow }],
          warnings: [],
        },
      };
    } else if (path === "/api/v1/github-app/setup/draft") {
      expect(request.postDataJSON()).toEqual({
        installationRowId: "installation-setup",
        repositoryFullName: "drydock/example",
        baseSha,
        workflowPath,
        environment: "drydock",
        ecosystem: "npm",
      });
      json = signedDraft;
    } else if (path === "/api/v1/github-app/setup/pull-request") {
      expect(request.postDataJSON()).toEqual(signedDraft);
      observations.created += 1;
      if (permissionDenied) {
        await route.fulfill({
          status: 403,
          json: {
            error:
              "Creating a workflow PR requires Contents, Pull requests, and Workflows write permissions. You can still copy the draft manually.",
            code: "setup_permissions_required",
          },
        });
        return;
      }
      json = {
        pullRequest: {
          number: 42,
          url: "https://github.com/drydock/example/pull/42",
          branch: "drydock/setup-fixture",
        },
      };
    } else if (path === "/api/v1/github-app/setup/status") {
      expect(request.postDataJSON()).toEqual({
        installationRowId: "installation-setup",
        repositoryFullName: "drydock/example",
        environment: "drydock",
        ecosystem: "npm",
      });
      json = { status: setupStatus(observations.complete) };
    } else {
      await route.fulfill({
        status: 404,
        json: { error: `Unexpected setup test request: ${path}` },
      });
      return;
    }
    await route.fulfill({ json });
  });
  return observations;
}

async function draftSetup(page: Page) {
  await page.goto("/dashboard/settings?tab=integrations#github-app");
  await expect(page.getByRole("heading", { name: "Prepare a release workflow" })).toBeVisible();
  await page.locator("#publisherSetupRepository").selectOption("drydock/example");
  await page.getByRole("button", { name: "Inspect workflow", exact: true }).click();
  await expect(page.getByLabel("Publishing workflow", { exact: true })).toHaveValue(workflowPath);
  await page.getByRole("button", { name: "Draft workflow change", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review the proposed change" })).toBeVisible();
}

test("publisher setup requires review before creating a draft PR and observes the first real gate", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const observations = await installSetupMocks(page);
  await draftSetup(page);
  const create = page.getByRole("button", { name: "Create draft pull request", exact: true });
  await expect(create).toBeDisabled();
  expect(observations.created).toBe(0);
  await page
    .getByRole("checkbox", {
      name: "I reviewed the workflow changes and the remaining configuration steps.",
    })
    .check();
  await create.click();
  await expect(page.getByRole("link", { name: "Open pull request #42" })).toHaveAttribute(
    "href",
    "https://github.com/drydock/example/pull/42",
  );
  expect(observations.created).toBe(1);
  await page.getByRole("button", { name: "Check setup status", exact: true }).click();
  await expect(
    page.getByText(
      "A completed pre-publish review has not been observed for this repository and environment.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open pre-publish review" })).toHaveCount(0);
  observations.complete = true;
  await page.getByRole("button", { name: "Check setup status", exact: true }).click();
  await expect(
    page.getByText(
      "The first pre-publish review completed; open the report to make the release decision.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open pre-publish review" })).toHaveAttribute(
    "href",
    "/dashboard/scans/scan-setup?org=org-setup",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("publisher-setup.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("changing repository invalidates a reviewed proposal before another PR can be created", async ({
  page,
}) => {
  const observations = await installSetupMocks(page);
  await draftSetup(page);
  await page
    .getByRole("checkbox", {
      name: "I reviewed the workflow changes and the remaining configuration steps.",
    })
    .check();
  await page.locator("#publisherSetupRepository").selectOption("drydock/other");
  await expect(page.getByRole("heading", { name: "Review the proposed change" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create draft pull request", exact: true }),
  ).toHaveCount(0);
  expect(observations.created).toBe(0);
});

test("missing GitHub write permission preserves the reviewed proposal and explains recovery", async ({
  page,
}) => {
  const observations = await installSetupMocks(page, true);
  await draftSetup(page);
  await page
    .getByRole("checkbox", {
      name: "I reviewed the workflow changes and the remaining configuration steps.",
    })
    .check();
  await page.getByRole("button", { name: "Create draft pull request", exact: true }).click();
  await expect(page.getByText(/Creating a workflow PR requires Contents/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review the proposed change" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open pull request #42" })).toHaveCount(0);
  expect(observations.created).toBe(1);
});
