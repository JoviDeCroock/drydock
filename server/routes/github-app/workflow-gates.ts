/**
 * Workflow gate decisions.
 *
 * The reviewer-facing half of the gate: read a gate by scan, approve or
 * reject it, or retry a gate whose review failed. A decision here is what
 * releases or blocks a waiting GitHub deployment, so it is the one route
 * group that can require a TOTP step-up before it will act.
 */
import { Hono } from "hono";
import { createDb, type AppDb } from "../../db/client";
import { recordScanEvent } from "../../db/events";
import { organizationRequiresTwoFactorForReleaseDecisions } from "../../db/organizations";
import { RateLimitError, enforceRateLimit } from "../../lib/platform/rate-limit";
import {
  countScanApprovals,
  getOrganizationApprovalPolicy,
  getScan,
  recordGatePackageDecision,
} from "../../db/scans";
import { badgeLookupKey } from "../../db/scan-share";
import { requireActiveOrganization } from "../../lib/auth/active-organization";
import { userHasTwoFactor, verifyTotpStepUp } from "../../lib/auth";
import { requireVerifiedEmail } from "../../lib/auth/email-verification";
import { canonicalOrigin, rateLimitResponse } from "../../lib/platform/http";
import {
  optionalWorkerExecutionContext,
  workerExecutionContext,
} from "../../lib/platform/execution-context";
import { purgePublicFeedCache, scanDistTag } from "../../lib/public-feed";
import { recordProductEvent } from "../../lib/platform/analytics";
import { describeOperationalError, emitOperationalEvent } from "../../lib/platform/observability";
import { scanArtifactReadBucket } from "../../lib/scan/artifacts";
import {
  buildHumanDecisionComment,
  buildReportUrl,
  executeWorkflowGateJob,
} from "../../lib/workflow-gate-job";
import {
  type GatePackageScan,
  type WorkflowGateRecord,
  getGateByScanId,
  getGateForOrganization,
  listGatePackageScans,
  markGateDecidedForPackageAggregate,
  resetGateReviewForRetry,
} from "../../lib/github-app/webhook-gates";
import type { Bindings, Variables } from "../../types";
import { type RouteContext } from "./shared";

export const workflowGateRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const GATE_DECISIONS = ["approved", "rejected"] as const;
type GateDecision = (typeof GATE_DECISIONS)[number];
const GATE_DECISION_SET = new Set<GateDecision>(GATE_DECISIONS);
const GATE_DECISION_COMMENT_MAX = 500;

workflowGateRoutes.get("/workflow-gates/by-scan/:scanId", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = await requireActiveOrganization(c, db);
  const scanId = c.req.param("scanId");
  const gate = await getGateByScanId(db, organizationId, scanId);
  if (!gate) return c.json({ error: "not found" }, 404);
  const packages = await listGatePackageScans(db, organizationId, gate.id);
  const orgRequiresTwoFactor = await organizationRequiresTwoFactorForReleaseDecisions(
    db,
    organizationId,
  );
  const view = await gateViewPolicy(db, organizationId, packages, orgRequiresTwoFactor);
  return c.json({ gate: publicWorkflowGate(gate, packages, view) });
});

// Record a maintainer's decision on one package of a gate and, once the whole
// release resolves, release or block the held GitHub Actions job.
//
// A monorepo gate fans out into one scan per package. Each call decides a single
// package (`scanId`): the per-package decision is persisted, then the gate is
// finalized only when the release as a whole resolves — `approved` once every
// package is approved, `rejected` the moment any one is rejected. Until then the
// gate stays pending and the held deployment waits.
//
// The aggregate CAS is the single transition out of `pending`, so a
// double-submit (or a race with the fail-closed artifact reject) returns 409.
// Posting the decision to GitHub is delegated to the gate job, which sees the
// now-decided gate and delivers its stored decision — either over the queue or
// inline when no queue is bound.
workflowGateRoutes.post("/workflow-gates/:gateId/decision", async (c) => {
  const unverified = requireVerifiedEmail(c);
  if (unverified) return unverified;
  const body = (await c.req.json().catch(() => ({}))) as Partial<{
    decision: string;
    comment: string;
    totpCode: string;
    scanId: string;
  }>;
  if (!GATE_DECISION_SET.has(body.decision as GateDecision)) {
    return c.json({ error: "decision must be 'approved' or 'rejected'" }, 400);
  }
  const decision = body.decision as GateDecision;
  const packageScanId = typeof body.scanId === "string" ? body.scanId.trim() : "";
  if (!packageScanId) {
    return c.json({ error: "scanId of the package being decided is required" }, 400);
  }
  const comment = typeof body.comment === "string" ? body.comment.trim() : "";
  if (comment.length > GATE_DECISION_COMMENT_MAX) {
    return c.json({ error: `comment must be <= ${GATE_DECISION_COMMENT_MAX} characters` }, 400);
  }

  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);
  try {
    await enforceRateLimit(c.env, {
      key: `github-app:gate-decision:${organizationId}`,
      limit: 60,
      windowMs: 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "gate decision rate limit exceeded", err);
    }
    throw err;
  }

  // Org-wide policy: when on, the step-up below is mandatory for every member
  // and an unenrolled member cannot decide at all. Looked up once so every gate
  // returned from this handler carries a consistent flag for the dialog.
  const orgRequiresTwoFactor = await organizationRequiresTwoFactorForReleaseDecisions(
    db,
    organizationId,
  );

  const gateId = c.req.param("gateId");
  const existing = await getGateForOrganization(db, organizationId, gateId);
  if (!existing) return c.json({ error: "not found" }, 404);
  if (existing.status !== "pending") {
    return c.json({ error: "gate has already been decided" }, 409);
  }

  // The decision targets one package scan that has reached a human decision
  // point. A completed review gives the maintainer the full diff; a failed
  // package can still be rejected by the human, or retried through the retry
  // endpoint before deciding. Approval additionally requires the batch to have
  // reached review-ready (`gate.scanId` attached), so a partial failed batch
  // cannot be approved as if every package had been reviewed.
  const scan = await getScan(db, packageScanId, organizationId);
  const scanReachedDecisionPoint =
    scan?.scan.status === "complete" || scan?.scan.status === "failed";
  if (
    !scan ||
    scan.scan.source !== "workflow_gate" ||
    scan.scan.gateId !== gateId ||
    !scanReachedDecisionPoint
  ) {
    return c.json({ error: "scanId is not a reviewable package of this gate" }, 409);
  }
  if (decision === "approved" && !existing.scanId) {
    const packages = await listGatePackageScans(db, organizationId, gateId);
    return c.json(
      {
        gate: publicWorkflowGate(
          existing,
          packages,
          await gateViewPolicy(db, organizationId, packages, orgRequiresTwoFactor),
        ),
        error: "approval requires a completed workflow-gate review batch",
      },
      409,
    );
  }

  // 2FA step-up. Releasing or blocking a held deployment is a high-trust action
  // — approval immediately releases the GitHub job and publishing proceeds via
  // Trusted Publishing/OIDC, which can't be reversed. So a maintainer who has
  // enrolled in two-factor auth must prove a *fresh* second factor here; an
  // existing session is not enough. On top of that, an org can require 2FA for
  // every release decision: then an unenrolled member is blocked outright (must
  // enroll first) and enrolled members still step up. With the policy off, only
  // enrolled members step up and others decide as before. This runs only after
  // the decision is confirmed actionable above, so a maintainer is never
  // prompted for a code (or blocked for enrollment) on a decision that would 409
  // anyway. (The staged-publish decision in scans/decisions.ts is an audit record only —
  // it never publishes or cancels anything — and deliberately never requires
  // this.)
  let twoFactorVerified = false;
  const userEnrolledInTwoFactor = await userHasTwoFactor(db, session.userId);
  if (orgRequiresTwoFactor && !userEnrolledInTwoFactor) {
    return c.json(
      {
        error:
          "your organization requires two-factor authentication to decide release gates — enable it in Settings, then try again",
        code: "two_factor_enrollment_required",
      },
      403,
    );
  }
  if (orgRequiresTwoFactor || userEnrolledInTwoFactor) {
    try {
      await enforceRateLimit(c.env, {
        key: `github-app:gate-decision-2fa:${session.userId}`,
        limit: 10,
        windowMs: 15 * 60 * 1000,
      });
    } catch (err) {
      if (err instanceof RateLimitError) {
        return rateLimitResponse(c, "too many two-factor attempts", err);
      }
      throw err;
    }
    const totpCode = typeof body.totpCode === "string" ? body.totpCode.trim() : "";
    if (!totpCode) {
      return c.json(
        { error: "two-factor verification required", code: "two_factor_required" },
        401,
      );
    }
    if (!(await verifyTotpStepUp(c.get("auth"), c.req.raw, totpCode))) {
      return c.json({ error: "invalid two-factor code", code: "two_factor_invalid" }, 401);
    }
    twoFactorVerified = true;
  }

  // Persist this member's vote on the package while the gate is still pending.
  // Under a one-approval policy that vote *is* the package decision; under a
  // higher bar the package stays undecided until enough distinct members have
  // approved it. `recordGatePackageDecision` also writes the audit events and
  // keeps the workbench decision filters consistent (approved → publish,
  // rejected → no_publish).
  const recorded = await recordGatePackageDecision(
    db,
    {
      scanId: packageScanId,
      organizationId,
      gateId,
      actorUserId: session.userId,
      decision: decision === "approved" ? "publish" : "no_publish",
      reason: comment || null,
    },
    scanArtifactReadBucket(c.env),
    c.env,
  );
  const currentGate =
    recorded.outcome === "recorded"
      ? existing
      : await getGateForOrganization(db, organizationId, gateId);
  const packages = await listGatePackageScans(db, organizationId, gateId);
  const anyRejected = packages.some((pkg) => pkg.decision === "no_publish");
  const allApproved = packages.length > 0 && packages.every((pkg) => pkg.decision === "publish");
  const aggregateResolved = anyRejected || allApproved;
  // Never let a retry that asks to reject an already-approved package release
  // the job as a side effect. A stored rejection remains fail-closed and may be
  // delivered by any retry; recovering an approval requires an approve retry.
  const recoveryMatchesRequest = anyRejected || (allApproved && decision === "approved");

  if (
    recorded.outcome !== "recorded" &&
    (!currentGate ||
      currentGate.status !== "pending" ||
      !aggregateResolved ||
      !recoveryMatchesRequest)
  ) {
    return c.json(
      {
        gate: currentGate
          ? publicWorkflowGate(
              currentGate,
              packages,
              await gateViewPolicy(db, organizationId, packages, orgRequiresTwoFactor),
            )
          : null,
        error:
          recorded.outcome === "already_voted"
            ? "you have already approved this package — it needs a different member's approval"
            : currentGate?.status === "pending"
              ? "package has already been decided"
              : "gate has already been decided",
      },
      409,
    );
  }
  if (!currentGate) return c.json({ error: "not found" }, 404);

  // A retry can arrive after the package verdict committed but before the gate
  // aggregate CAS. Treat that durable package state as recovery work instead
  // of rejecting it as a double-submit, and refresh any badge/feed entry the
  // interrupted request may not have reached.
  const decidedPackage = recorded.outcome === "recorded" ? recorded.detail : scan;
  const packageVerdictMayHaveChanged =
    recorded.outcome === "recorded"
      ? recorded.verdictChanged
      : decidedPackage.scan.decision === "publish" || decidedPackage.scan.decision === "no_publish";

  // A decision changes what a listed scan's cached badge and feed entry
  // assert ("reviewed · risk" → "approved"/"blocked"); drop both so the
  // change is not delayed by the colo TTL in at least this region. Same
  // canonical-origin purge as the staged decision route and (un)listing. An
  // approval still short of the org's bar changed no verdict, so nothing
  // cached is stale yet.
  if (packageVerdictMayHaveChanged && decidedPackage.scan.publicFeedListedAt) {
    purgePublicFeedCache(
      optionalWorkerExecutionContext(c),
      canonicalOrigin(c),
      badgeLookupKey({
        source: decidedPackage.scan.source,
        packageName: decidedPackage.scan.packageName,
        summaryJson: decidedPackage.scan.summaryJson,
      }),
      // Gate scans carry no dist-tag today, so this resolves to the default
      // entry — passed explicitly so it stays correct if they ever do.
      scanDistTag(decidedPackage.scan.summaryJson),
    );
  }

  // Aggregate over every package: release only when all are approved; block the
  // moment any one is rejected. `pkg.decision` is the quorum-resolved verdict,
  // so a package one approval short reads here exactly like an undecided one —
  // the deployment stays held, which is the behavior we want.
  if (!anyRejected && !allApproved) {
    // Other packages (or other approvers) still owe a decision; keep the
    // deployment held.
    return c.json({
      gate: publicWorkflowGate(
        currentGate,
        packages,
        await gateViewPolicy(db, organizationId, packages, orgRequiresTwoFactor),
      ),
      approvals: recorded.outcome === "recorded" ? recorded.approvals : undefined,
    });
  }
  if (allApproved && !currentGate.scanId) {
    return c.json(
      {
        gate: publicWorkflowGate(
          currentGate,
          packages,
          await gateViewPolicy(db, organizationId, packages, orgRequiresTwoFactor),
        ),
        error: "approval requires a completed workflow-gate review batch",
      },
      409,
    );
  }

  const gateDecision: GateDecision = anyRejected ? "rejected" : "approved";
  const reportUrl = buildReportUrl(c.env, currentGate.scanId);
  const decided = await markGateDecidedForPackageAggregate(db, {
    gateId,
    organizationId,
    decision: gateDecision,
    comment: comment || buildHumanDecisionComment(gateDecision, reportUrl),
    reportUrl,
  });
  if (!decided) {
    // Lost a race to a concurrent finalize or a fail-closed artifact reject.
    const current = await getGateForOrganization(db, organizationId, gateId);
    return c.json(
      {
        gate: current
          ? publicWorkflowGate(
              current,
              packages,
              await gateViewPolicy(db, organizationId, packages, orgRequiresTwoFactor),
            )
          : null,
        error: "gate has already been decided",
      },
      409,
    );
  }

  // Schedule delivery immediately after the CAS. Everything below is
  // bookkeeping; if it throws, the durable gate decision still has a path to
  // GitHub instead of getting stuck behind a future 409.
  const message = { kind: "workflow_gate" as const, organizationId, gateId };
  c.executionCtx.waitUntil(deliverGateDecisionJob(c, db, message));

  // Counted separately from the automatic block below, so approval rate stays
  // measurable against reviews instead of being diluted by auto-rejections.
  recordProductEvent(c.env, {
    name: "workflow_gate.decided",
    organizationId,
    surface: "human",
    decision: gateDecision,
    packageCount: packages.length,
  });

  try {
    await recordScanEvent(db, {
      organizationId,
      actorUserId: session.userId,
      scanId: decided.scanId,
      type:
        gateDecision === "approved"
          ? "github_workflow_gate.approved"
          : "github_workflow_gate.rejected",
      metadata: {
        gateId,
        decidedBy: "human",
        reportUrl,
        packageCount: packages.length,
        twoFactor: twoFactorVerified,
        twoFactorMethod: twoFactorVerified ? "totp" : null,
        twoFactorRequiredByOrg: orgRequiresTwoFactor,
      },
    });
  } catch (err) {
    emitOperationalEvent("warn", "github_workflow_gate.decision_bookkeeping_failed", {
      organizationId,
      gateId,
      decision: gateDecision,
      error: describeOperationalError(err),
    });
  }

  return c.json({
    gate: publicWorkflowGate(
      decided,
      packages,
      await gateViewPolicy(db, organizationId, packages, orgRequiresTwoFactor),
    ),
    approvals: recorded.outcome === "recorded" ? recorded.approvals : undefined,
  });
});

// Re-run a failed workflow-gate review batch. The retry is intentionally scoped
// to pending gates whose package scans have no recorded decisions: once a human
// has accepted or rejected a package, retrying must not replace that decision.
workflowGateRoutes.post("/workflow-gates/:gateId/retry", async (c) => {
  const db = createDb(c.env.DB);
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);
  try {
    await enforceRateLimit(c.env, {
      key: `github-app:gate-retry:${organizationId}`,
      limit: 20,
      windowMs: 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return rateLimitResponse(c, "gate retry rate limit exceeded", err);
    }
    throw err;
  }

  const gateId = c.req.param("gateId");
  const existing = await getGateForOrganization(db, organizationId, gateId);
  if (!existing) return c.json({ error: "not found" }, 404);
  if (existing.status !== "pending") {
    return c.json({ error: "gate has already been decided" }, 409);
  }

  const reset = await resetGateReviewForRetry(db, { gateId, organizationId });
  const packages = await listGatePackageScans(db, organizationId, gateId);
  const orgRequiresTwoFactor = await organizationRequiresTwoFactorForReleaseDecisions(
    db,
    organizationId,
  );
  if (!reset) {
    return c.json(
      {
        gate: publicWorkflowGate(
          existing,
          packages,
          await gateViewPolicy(db, organizationId, packages, orgRequiresTwoFactor),
        ),
        error: "gate review is not retryable",
      },
      409,
    );
  }

  await recordScanEvent(db, {
    organizationId,
    actorUserId: session.userId,
    scanId: existing.scanId,
    type: "github_workflow_gate.retry_requested",
    metadata: { gateId, packageCount: packages.length },
  });

  const message = { kind: "workflow_gate" as const, organizationId, gateId };
  c.executionCtx.waitUntil(runWorkflowGateJob(c, db, message));

  const gate = await getGateForOrganization(db, organizationId, gateId);
  return c.json(
    {
      gate: publicWorkflowGate(
        gate ?? existing,
        packages,
        await gateViewPolicy(db, organizationId, packages, orgRequiresTwoFactor),
      ),
      queued: Boolean(c.env.SCAN_QUEUE),
    },
    202,
  );
});

async function deliverGateDecisionJob(
  c: RouteContext,
  db: ReturnType<typeof createDb>,
  message: { kind: "workflow_gate"; organizationId: string; gateId: string },
) {
  await runWorkflowGateJob(c, db, message);
}

async function runWorkflowGateJob(
  c: RouteContext,
  db: ReturnType<typeof createDb>,
  message: { kind: "workflow_gate"; organizationId: string; gateId: string },
) {
  if (c.env.SCAN_QUEUE) {
    try {
      await c.env.SCAN_QUEUE.send(message);
      return;
    } catch {
      // Fall back to an inline redelivery attempt so a transient queue-send
      // failure after markGateDecided does not leave the GitHub job held.
    }
  }
  await executeWorkflowGateJob(c.env, workerExecutionContext(c.executionCtx), message, db);
}

// Excludes the deployment callback URL (and other GitHub-internal identifiers)
// so the credentialed egress target is never exposed to the browser. `packages`
// is one entry per distinct package the release publishes (a monorepo fans out
// into several); the gate releases only once every package is approved.
// `organizationRequiresTwoFactor` surfaces the org policy so the decision dialog
// can prompt for a code (or block an unenrolled member) before submitting,
// matching what the route enforces server-side.
/**
 * The policy half of a gate response: the org's two-factor requirement, its
 * approval bar, and how many approvals each package has actually collected.
 * Loaded per response so a reviewer refreshing mid-quorum sees the current
 * count rather than the one their own submit returned.
 */
async function gateViewPolicy(
  db: AppDb,
  organizationId: string,
  packages: GatePackageScan[],
  organizationRequiresTwoFactor: boolean,
): Promise<GateViewPolicy> {
  const [policy, approvalCounts] = await Promise.all([
    getOrganizationApprovalPolicy(db, organizationId),
    countScanApprovals(
      db,
      organizationId,
      packages.map((pkg) => pkg.scanId),
    ),
  ]);
  return {
    organizationRequiresTwoFactor,
    requiredApprovals: policy.required,
    approvalCounts,
  };
}

interface GateViewPolicy {
  organizationRequiresTwoFactor: boolean;
  /** Distinct approvals each package of this gate needs before it counts as approved. */
  requiredApprovals: number;
  approvalCounts: Awaited<ReturnType<typeof countScanApprovals>>;
}

const SINGLE_APPROVER_VIEW: GateViewPolicy = {
  organizationRequiresTwoFactor: false,
  requiredApprovals: 1,
  approvalCounts: new Map(),
};

function publicWorkflowGate(
  record: WorkflowGateRecord,
  packages: GatePackageScan[] = [],
  policy: GateViewPolicy = SINGLE_APPROVER_VIEW,
) {
  const { organizationRequiresTwoFactor, requiredApprovals, approvalCounts } = policy;
  return {
    id: record.id,
    organizationId: record.organizationId,
    releaseTargetId: record.releaseTargetId,
    repositoryFullName: record.repositoryFullName,
    environment: record.environment,
    runId: record.runId,
    status: record.status,
    decision: record.decision,
    decisionComment: record.decisionComment,
    reportUrl: record.reportUrl,
    scanId: record.scanId,
    failureReason: record.failureReason,
    organizationRequiresTwoFactor,
    requiredApprovals,
    packages: packages.map((pkg) => ({
      scanId: pkg.scanId,
      packageName: pkg.packageName,
      version: pkg.stagedVersion,
      status: pkg.status,
      releaseRisk: pkg.releaseRisk,
      decision: pkg.decision,
      // A package under a multi-approval policy sits approved-by-one and still
      // undecided; the roster is what tells a reviewer whether their own click
      // will release the deployment or just move it one step closer.
      approvalCount:
        (pkg.decision === null
          ? approvalCounts.get(pkg.scanId)?.eligibleApproved
          : approvalCounts.get(pkg.scanId)?.approved) ?? (pkg.decision === "publish" ? 1 : 0),
    })),
    requestedAt: record.requestedAt.toISOString(),
    decidedAt: record.decidedAt ? record.decidedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
