import { Hono } from "hono";
import { recordScanEvent } from "../../db/events";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { requireOrganizationRole } from "../../lib/auth/active-organization";
import { requireVerifiedEmail } from "../../lib/auth/email-verification";
import { roleCanManageIntegrations } from "../../lib/auth/roles";
import { type GithubAppConfig, readGithubAppConfig } from "../../lib/github-app/config";
import {
  createSetupClient,
  createSetupPullRequest,
  inspectPublisherSetup,
  PublisherSetupError,
  validSetupEnvironment,
} from "../../lib/github-app/setup-api";
import {
  enqueuePublisherSetupDraft,
  readPublisherSetupDraftJob,
} from "../../lib/github-app/setup-jobs";
import { publisherSetupStatus } from "../../lib/github-app/setup-status";
import {
  normalizeGithubEnvironmentName,
  parseRepositoryFullName,
} from "../../lib/github-app/validation";
import { readJsonObject } from "../../lib/platform/http";
import { guardRateLimit } from "../../lib/rate-limit";
import type { Bindings, Variables } from "../../types";
import {
  configErrorResponse,
  ensureInstallationOwnedBy,
  type RouteContext,
  validationErrorResponse,
} from "./shared";

export const publisherSetupRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
publisherSetupRoutes.use("/setup/*", async (c, next) => {
  const maximum = c.req.path.endsWith("/setup/pull-request") ? 4_194_304 : 200_000;
  return bodyLimit({
    maxSize: maximum,
    onError: (context) =>
      context.json(
        {
          error: "The setup request exceeds its supported size limit.",
          code: "setup_request_too_large",
        },
        413,
      ),
  })(c, next);
});

const scopeSchema = z.object({
  installationRowId: z.string().min(1).max(100),
  repositoryFullName: z
    .string()
    .max(140)
    .refine((value) => Boolean(parseRepositoryFullName(value))),
});
const statusSchema = scopeSchema
  .extend({
    ecosystem: z.enum(["npm", "pypi", "vscode"]),
    environment: z
      .string()
      .min(1)
      .max(255)
      .transform(normalizeGithubEnvironmentName)
      .refine(validSetupEnvironment),
  })
  .strict();

// Separate budgets so status refreshes cannot exhaust drafting or PR creation.
// Drafting is the costly bucket: each call sends a workflow to Workers AI.
const RATE_LIMITS = {
  read: 60,
  draft: 20,
  "pull-request": 20,
  poll: 120,
} as const;

async function route(
  c: RouteContext,
  bucket: keyof typeof RATE_LIMITS,
  operation: (config: GithubAppConfig, organizationId: string) => Promise<Response>,
) {
  if (!c.get("authSession")) return c.json({ error: "unauthorized" }, 401);
  const unverified = requireVerifiedEmail(c);
  if (unverified) return unverified;
  const { organizationId } = await requireOrganizationRole(c, c.var.db, roleCanManageIntegrations);
  const limited = await guardRateLimit(
    c,
    {
      key: `github-app:setup:${bucket}:${organizationId}${bucket === "poll" ? `:${c.get("authSession").userId}` : ""}`,
      limit: RATE_LIMITS[bucket],
      windowMs: bucket === "poll" ? 60_000 : 60 * 60_000,
    },
    "Publisher setup rate limit exceeded",
  );
  if (limited) return limited;
  let config: GithubAppConfig;
  try {
    config = readGithubAppConfig(c.env);
  } catch (error) {
    return configErrorResponse(c, error);
  }
  try {
    return await operation(config, organizationId);
  } catch (error) {
    if (error instanceof PublisherSetupError)
      return c.json({ error: error.message, code: error.code }, error.status);
    if (error instanceof z.ZodError)
      return c.json(
        {
          error:
            "Check the selected repository, workflow, environment, and proposal, then try again.",
          code: "invalid_input",
        },
        400,
      );
    return validationErrorResponse(c, error);
  }
}

publisherSetupRoutes.post("/setup/inspect", (c) =>
  route(c, "read", async (config, organizationId) => {
    const input = scopeSchema.strict().parse(await readJsonObject(c));
    const installation = await ensureInstallationOwnedBy(
      c.var.db,
      organizationId,
      input.installationRowId,
    );
    const client = await createSetupClient(
      config,
      installation.installationId,
      input.repositoryFullName,
    );
    return c.json({ inspection: await inspectPublisherSetup(client, input.installationRowId) });
  }),
);

publisherSetupRoutes.post("/setup/draft", (c) =>
  route(c, "draft", async (_config, organizationId) => {
    const { setupDraftRequestSchema } = await import("../../lib/github-app/setup-draft");
    const input = setupDraftRequestSchema
      .extend({ createPullRequest: z.literal(true) })
      .parse(await readJsonObject(c));
    await ensureInstallationOwnedBy(c.var.db, organizationId, input.installationRowId);
    const aiEnabled = c.env.FLAGS
      ? await c.env.FLAGS.getBooleanValue("ai-review", true, {
          targetingKey: organizationId,
          organizationId,
        })
      : false;
    if (!aiEnabled || !c.env.AI)
      return c.json(
        {
          error:
            "AI workflow drafting is unavailable for this organization. Use the release workflow guide or ask the operator to enable AI review.",
          code: "setup_ai_unavailable",
        },
        503,
      );
    const job = await enqueuePublisherSetupDraft(
      c.env,
      organizationId,
      c.get("authSession").userId,
      input,
    );
    c.header("Cache-Control", "no-store");
    return c.json({ job }, 202);
  }),
);

publisherSetupRoutes.get("/setup/draft-jobs/:id", (c) =>
  route(c, "poll", async (_config, organizationId) => {
    const job = await readPublisherSetupDraftJob(
      c.env,
      c.req.param("id"),
      organizationId,
      c.get("authSession").userId,
    );
    if (!job)
      return c.json({ error: "Draft job not found or expired.", code: "setup_job_not_found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json({ job });
  }),
);

publisherSetupRoutes.post("/setup/pull-request", (c) =>
  route(c, "pull-request", async (config, organizationId) => {
    const { setupProposalSchema, verifySetupProposal } =
      await import("../../lib/github-app/setup-draft");
    const input = z
      .object({ proposal: setupProposalSchema, proposalToken: z.string().max(100) })
      .strict()
      .parse(await readJsonObject(c));
    if (
      !(await verifySetupProposal(
        config.stateSecret,
        input.proposal,
        input.proposalToken,
        organizationId,
        c.get("authSession").userId,
      ))
    )
      throw new PublisherSetupError(
        "proposal_invalid",
        "This proposal is expired or no longer valid. Inspect the repository and create a fresh draft.",
        409,
      );
    const installation = await ensureInstallationOwnedBy(
      c.var.db,
      organizationId,
      input.proposal.installationRowId,
    );
    const client = await createSetupClient(
      config,
      installation.installationId,
      input.proposal.repositoryFullName,
      true,
    );
    const { created, ...pullRequest } = await createSetupPullRequest(client, input.proposal);
    await recordScanEvent(c.var.db, {
      idempotencyKey: `publisher-setup:${organizationId}:${input.proposal.repositoryId}:${pullRequest.number}`,
      organizationId,
      actorUserId: c.get("authSession").userId,
      type: "github_app_setup.pr_created",
      metadata: {
        repositoryFullName: input.proposal.repositoryFullName,
        environment: input.proposal.environment,
        pullRequestNumber: pullRequest.number,
      },
    });
    return c.json({ pullRequest }, created ? 201 : 200);
  }),
);

publisherSetupRoutes.post("/setup/status", (c) =>
  route(c, "read", async (config, organizationId) => {
    const input = statusSchema.parse(await readJsonObject(c));
    const installation = await ensureInstallationOwnedBy(
      c.var.db,
      organizationId,
      input.installationRowId,
    );
    const client = await createSetupClient(
      config,
      installation.installationId,
      input.repositoryFullName,
    );
    return c.json({
      status: await publisherSetupStatus(
        c.var.db,
        config,
        client,
        organizationId,
        input.installationRowId,
        input.environment,
        input.ecosystem,
      ),
    });
  }),
);
