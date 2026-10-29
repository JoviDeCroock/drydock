import { expect, test, type Page } from "@playwright/test";
import type {
  PublisherSetupDraft,
  PublisherSetupDraftJob,
  PublisherSetupStatus,
} from "../../server/lib/github-app/setup-types";
import {
  SETUP_ORIGINAL_WORKFLOW,
  SETUP_PROPOSED_WORKFLOW,
} from "../helpers/publisher-setup-fixtures";

const now = "2026-10-28T10:00:00.000Z";
const baseSha = "a".repeat(40);
const workflowPath = ".github/workflows/release.yml";
const helperPath = ".github/scripts/prepare-release.mjs";
const helperContent =
  '// <img src=x onerror="globalThis.publisherHelperExecuted = true">\nexport const candidateDirectory = "release-candidate";\n';
const releaseScriptPath = "scripts/release.mjs";
const currentReleaseScript = 'console.log("Publishing from source");\n';
const proposedReleaseScript = 'console.log("Publishing reviewed candidate");\n';
const currentWorkflow = SETUP_ORIGINAL_WORKFLOW;
const proposedWorkflow = SETUP_PROPOSED_WORKFLOW.replace(
  "environment: production",
  "environment: drydock",
)
  .replace("      - run: npm pack\n", `      - run: node ${helperPath} prepare\n`)
  .replace(
    "      - run: npm publish *.tgz --provenance\n",
    `      - run: node ${helperPath} publish\n`,
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
      supportingFiles: [
        { path: helperPath, content: helperContent, originalSha: null, originalContent: null },
        {
          path: releaseScriptPath,
          content: proposedReleaseScript,
          originalSha: "c".repeat(40),
          originalContent: currentReleaseScript,
        },
      ],
      summary: "Hold the publishing job behind the drydock environment.",
      manualSteps: [
        "Enable the Drydock deployment protection rule on the drydock environment.",
        "Review the proposed workflow before merging it.",
      ],
      expiresAt: Date.now() + 900_000,
    },
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

async function installSetupMocks(
  page: Page,
  permissionDenied = false,
  judgeFails = false,
  agentBlocked = false,
) {
  const observations = {
    created: 0,
    complete: false,
    jobPolls: 0,
    holdJob: false,
    cancelled: 0,
    requests: [] as string[],
    inspected: [] as string[],
  };
  const signedDraft = proposal();
  const requestScope = {
    installationRowId: signedDraft.proposal.installationRowId,
    repositoryFullName: signedDraft.proposal.repositoryFullName,
    baseSha,
    workflowPath,
    environment: "drydock",
    ecosystem: "npm" as const,
    createPullRequest: true as const,
  };
  const job = (ready = false): PublisherSetupDraftJob => ({
    id: "job-setup",
    status: ready ? "ready" : "running",
    stage: ready ? "ready" : "judge",
    request: requestScope,
    createdAt: now,
    updatedAt: now,
    expiresAt: "2099-01-01T00:00:00.000Z",
    failure: null,
    judge: ready
      ? {
          verdict: "pass",
          summary: "The reviewed artifact is preserved.",
          issues: [],
          model: "test-judge",
          digest: "d".repeat(64),
        }
      : null,
    result: ready
      ? {
          ...signedDraft,
          originalContent: currentWorkflow,
          pullRequest: {
            number: 42,
            url: "https://github.com/drydock/example/pull/42",
            branch: "drydock/setup-fixture",
          },
        }
      : null,
  });
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
      // Choosing a repository inspects it, so either fixture repository may arrive.
      const body = request.postDataJSON();
      expect(body.installationRowId).toBe("installation-setup");
      expect(["drydock/example", "drydock/other"]).toContain(body.repositoryFullName);
      observations.inspected.push(body.repositoryFullName);
      json = {
        inspection: {
          installationRowId: "installation-setup",
          repositoryFullName: body.repositoryFullName,
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
        createPullRequest: true,
      });
      await route.fulfill({
        status: 202,
        json: { job: { ...job(), status: "queued", stage: "queued" } },
      });
      return;
    } else if (path === "/api/v1/github-app/setup/draft-jobs/job-setup/cancel") {
      observations.cancelled += 1;
      json = {
        job: {
          ...job(),
          status: "failed",
          stage: "draft",
          result: null,
          judge: null,
          failure: { code: "setup_cancelled", message: "Pull request preparation was cancelled." },
        },
      };
    } else if (path === "/api/v1/github-app/setup/draft-jobs/job-setup") {
      observations.jobPolls += 1;
      let current = job(!observations.holdJob && observations.jobPolls > 2);
      if (judgeFails)
        current = {
          ...job(),
          status: "failed",
          stage: "judge",
          result: null,
          failure: {
            code: "judge_changes_requested",
            message: "The independent review requested changes. Prepare another attempt.",
          },
          judge: {
            verdict: "changes_requested",
            summary: "The publish job rebuilds the artifact.",
            issues: ["Publish the exact reviewed tarball."],
            model: "test-judge",
            digest: "d".repeat(64),
          },
        };
      else if (!observations.holdJob && observations.jobPolls === 2)
        current = {
          ...job(),
          stage: "create_pr",
          judge: {
            verdict: "pass",
            summary: "The reviewed artifact is preserved.",
            issues: [],
            model: "test-judge",
            digest: "d".repeat(64),
          },
        };
      if (permissionDenied && observations.jobPolls >= 2)
        current = {
          ...job(),
          status: "failed",
          stage: "create_pr",
          result: null,
          failure: {
            code: "setup_permissions_required",
            message:
              "Opening a draft PR requires Contents, Pull requests, and Workflows write permissions. Update the GitHub App permissions and prepare another attempt.",
          },
          judge: {
            verdict: "pass",
            summary: "The reviewed artifact is preserved.",
            issues: [],
            model: "test-judge",
            digest: "d".repeat(64),
          },
        };
      if (agentBlocked)
        current = {
          ...job(),
          status: "failed",
          stage: "draft",
          result: null,
          judge: null,
          failure: { code: "setup_agent_blocked", message: "More release evidence is needed." },
          feedback: [
            'Missing publishing configuration: <img src=x onerror="globalThis.publisherFeedbackExecuted=true">',
          ],
        };
      if (current.status === "ready") observations.created = 1;
      json = { job: current };
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

async function beginPreparation(page: Page) {
  await page.goto("/dashboard/settings?tab=integrations#github-app");
  await expect(page.getByRole("heading", { name: "Prepare a release workflow" })).toBeVisible();
  await page.locator("#publisherSetupRepository").selectOption("drydock/example");
  await expect(page.getByLabel("Publishing workflow", { exact: true })).toHaveValue(workflowPath);
  await page.getByRole("button", { name: "Prepare draft pull request", exact: true }).click();
}

async function draftSetup(page: Page, progressPath?: string) {
  await beginPreparation(page);
  await expect(
    page.getByText("Running an independent review of the change…", { exact: true }),
  ).toBeVisible();
  if (progressPath) await page.screenshot({ path: progressPath, fullPage: true });
  await expect(
    page.getByText("Opening the draft pull request in GitHub…", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Draft pull request ready" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Independent review", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "No changes requested by the independent reviewer; your review is still required.",
      { exact: true },
    ),
  ).toBeVisible();
}

test("publisher setup automatically prepares a draft PR after its checks and observes the first real gate", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const observations = await installSetupMocks(page);
  await draftSetup(page, testInfo.outputPath("publisher-draft-progress.png"));
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create draft pull request", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Review pull request #42 on GitHub" }),
  ).toHaveAttribute("href", "https://github.com/drydock/example/pull/42");
  expect(observations.created).toBe(1);
  expect(observations.requests).not.toContain("POST /api/v1/github-app/setup/pull-request");
  await page.locator("summary", { hasText: "View workflow changes" }).click();
  const helper = page.getByRole("region", { name: `Proposed file ${helperPath}`, exact: true });
  await expect(helper).toBeVisible();
  await expect(
    helper.getByRole("region", {
      name: `Contents of ${helperPath} (Proposed file)`,
      exact: true,
    }),
  ).toContainText("export const candidateDirectory");
  await expect(
    helper.getByRole("button", { name: `Copy ${helperPath}`, exact: true }),
  ).toBeVisible();
  const releaseScript = page.getByRole("region", {
    name: `Diff of ${releaseScriptPath}`,
    exact: true,
  });
  await expect(releaseScript).toContainText('console.log("Publishing from source")');
  await expect(releaseScript).toContainText('console.log("Publishing reviewed candidate")');
  await expect(
    page.getByRole("button", { name: `Copy ${releaseScriptPath}`, exact: true }),
  ).toBeVisible();
  await expect(helper.locator("img")).toHaveCount(0);
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "publisherHelperExecuted")),
  ).toBeUndefined();
  await expect(
    page.getByRole("region", { name: `Diff of ${workflowPath}`, exact: true }),
  ).toContainText(`node ${helperPath} prepare`);
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

test("changing repository hides the previous job link from the new selection", async ({ page }) => {
  const observations = await installSetupMocks(page);
  await draftSetup(page);
  await page.locator("#publisherSetupRepository").selectOption("drydock/other");
  await expect(page.getByRole("heading", { name: "Draft pull request ready" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Review pull request #42 on GitHub" })).toHaveCount(
    0,
  );
  await expect(page.getByText("1 workflow on main · aaaaaaa")).toBeVisible();
  expect(observations.inspected).toEqual(["drydock/example", "drydock/other"]);
  expect(observations.created).toBe(1);
});

test("missing GitHub write permission reports the automatic job failure and recovery", async ({
  page,
}) => {
  const observations = await installSetupMocks(page, true);
  await beginPreparation(page);
  await expect(page.getByText(/Opening a draft PR requires Contents/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Draft pull request ready" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Review pull request #42 on GitHub" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Prepare draft pull request", exact: true }),
  ).toBeEnabled();
  expect(observations.created).toBe(0);
});

test("a negative independent review surfaces actionable issues without a PR action", async ({
  page,
}, testInfo) => {
  const observations = await installSetupMocks(page, false, true);
  await page.goto("/dashboard/settings?tab=integrations#github-app");
  await page.locator("#publisherSetupRepository").selectOption("drydock/example");
  await page.getByRole("button", { name: "Prepare draft pull request", exact: true }).click();
  await expect(
    page.getByText("The publish job rebuilds the artifact.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Publish the exact reviewed tarball.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create draft pull request", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Prepare draft pull request", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("publisher-draft-judge-failure.png"),
    fullPage: true,
  });
  expect(observations.created).toBe(0);
});

test("a blocked preparation displays escaped feedback without opening a PR", async ({ page }) => {
  const observations = await installSetupMocks(page, false, false, true);
  await beginPreparation(page);
  await expect(page.getByRole("heading", { name: "Agent feedback", exact: true })).toBeVisible();
  await expect(page.getByText(/Missing publishing configuration:/)).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Agent feedback", exact: true }).locator("img"),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "publisherFeedbackExecuted")),
  ).toBeUndefined();
  await expect(page.getByRole("link", { name: "Review pull request #42 on GitHub" })).toHaveCount(
    0,
  );
  expect(observations.created).toBe(0);
});

test("a pending background draft resumes after refresh without persisting workflow content", async ({
  page,
}) => {
  const observations = await installSetupMocks(page);
  observations.holdJob = true;
  await page.goto("/dashboard/settings?tab=integrations#github-app");
  await page.locator("#publisherSetupRepository").selectOption("drydock/example");
  await page.getByRole("button", { name: "Prepare draft pull request", exact: true }).click();
  await expect(
    page.getByText("Running an independent review of the change…", { exact: true }),
  ).toBeVisible();
  const stored = await page.evaluate(() =>
    sessionStorage.getItem("drydock:publisher-draft:org-setup"),
  );
  expect(stored).toContain("job-setup");
  expect(stored).not.toContain("local-signed-proposal-fixture");
  expect(stored).not.toContain("jobs:");
  observations.holdJob = false;
  await page.reload();
  await expect(page.getByRole("heading", { name: "Draft pull request ready" })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Review pull request #42 on GitHub" })).toBeVisible();
  expect(observations.created).toBe(1);
});

test("a pending preparation locks the release choice until it is cancelled", async ({ page }) => {
  const observations = await installSetupMocks(page);
  observations.holdJob = true;
  await page.goto("/dashboard/settings?tab=integrations#github-app");
  await page.locator("#publisherSetupRepository").selectOption("drydock/example");
  await page.getByRole("button", { name: "Prepare draft pull request", exact: true }).click();
  await expect(
    page.getByText("Running an independent review of the change…", { exact: true }),
  ).toBeVisible();
  for (const id of [
    "#publisherSetupRepository",
    "#publisherSetupEnvironment",
    "#publisherSetupWorkflow",
  ])
    await expect(page.locator(id)).toBeDisabled();
  await page.getByRole("button", { name: "Cancel preparation", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel preparation" })).toHaveCount(0);
  await expect(page.locator("#publisherSetupRepository")).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Prepare draft pull request", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => sessionStorage.getItem("drydock:publisher-draft:org-setup")),
  ).toBeNull();
  expect(observations.cancelled).toBe(1);
  expect(observations.created).toBe(0);
});

test("switching organizations preserves a resumed draft while the new installation list is delayed", async ({
  page,
}) => {
  await installSetupMocks(page);
  const requestScope = {
    installationRowId: "installation-b",
    repositoryFullName: "team-b/package",
    baseSha,
    workflowPath,
    environment: "production",
    ecosystem: "npm" as const,
    createPullRequest: true as const,
  };
  let finishInstallations: (() => void) | undefined;
  let complete = false;
  let polls = 0;
  await page.route("**/api/v1/organizations", async (route) => {
    await route.fulfill({
      json: {
        organizations: [
          {
            id: "org-setup",
            name: "Release team",
            ownerUserId: "user-setup",
            role: "owner",
            isPersonal: false,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "org-b",
            name: "Other release team",
            ownerUserId: "user-setup",
            role: "owner",
            isPersonal: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    });
  });
  await page.route("**/api/v1/github-app/installations", async (route) => {
    if (route.request().headers()["x-organization-id"] !== "org-b") return route.fallback();
    await new Promise<void>((resolve) => {
      finishInstallations = resolve;
    });
    await route.fulfill({
      json: {
        installations: [
          {
            id: "installation-b",
            organizationId: "org-b",
            installationId: "456",
            accountLogin: "team-b",
            accountType: "Organization",
            targetType: "Organization",
            status: "active",
            installedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    });
  });
  await page.route(
    "**/api/v1/github-app/installations/installation-b/repositories",
    async (route) => {
      await route.fulfill({
        json: { repositories: [{ id: 202, fullName: "team-b/package", defaultBranch: "main" }] },
      });
    },
  );
  await page.route("**/api/v1/github-app/setup/draft-jobs/job-b", async (route) => {
    expect(route.request().headers()["x-organization-id"]).toBe("org-b");
    polls += 1;
    const ready = proposal();
    await route.fulfill({
      json: {
        job: {
          id: "job-b",
          request: requestScope,
          status: complete ? "ready" : "running",
          stage: complete ? "ready" : "judge",
          createdAt: now,
          updatedAt: now,
          expiresAt: "2099-01-01T00:00:00.000Z",
          failure: null,
          judge: complete
            ? {
                verdict: "pass",
                summary: "The reviewed artifact is preserved.",
                issues: [],
                model: "test-judge",
                digest: "d".repeat(64),
              }
            : null,
          result: complete
            ? {
                ...ready,
                proposal: { ...ready.proposal, ...requestScope, repositoryId: 202 },
                originalContent: currentWorkflow,
                pullRequest: {
                  number: 84,
                  url: "https://github.com/team-b/package/pull/84",
                  branch: "drydock/setup-b",
                },
              }
            : null,
        },
      },
    });
  });

  await page.goto("/dashboard/settings?tab=integrations#github-app");
  // One installation per organization, so the installation select stays hidden;
  // an enabled repository select means it was chosen and its repositories loaded.
  await expect(page.locator("#publisherSetupRepository")).toBeEnabled();
  await page.evaluate((request) => {
    sessionStorage.setItem(
      "drydock:publisher-draft:org-b",
      JSON.stringify({ id: "job-b", request }),
    );
  }, requestScope);
  await page.getByRole("button", { name: "Switch organization" }).click();
  await page.getByRole("menuitem", { name: "Other release team", exact: true }).click();
  await expect(page.getByRole("button", { name: "Switch organization" })).toContainText(
    "Other release team",
  );
  await expect.poll(() => polls).toBeGreaterThan(0);
  await expect(
    page.getByText("Running an independent review of the change…", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem("drydock:publisher-draft:org-b")),
  ).toContain("job-b");
  await expect.poll(() => Boolean(finishInstallations)).toBe(true);

  complete = true;
  finishInstallations!();
  await expect(page.getByLabel("Repository", { exact: true }).first()).toHaveValue(
    "team-b/package",
  );
  await expect(page.getByRole("heading", { name: "Draft pull request ready" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Review pull request #84 on GitHub" }),
  ).toHaveAttribute("href", "https://github.com/team-b/package/pull/84");
});
