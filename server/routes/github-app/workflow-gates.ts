/**
 * Workflow gate decisions.
 *
 * The reviewer-facing half of the gate: read a gate by scan, approve or
 * reject it, or retry a gate whose review failed. A decision here is what
 * releases or blocks a waiting GitHub deployment, so it is the one route
 * group that can require a TOTP step-up before it will act.
 */
import { Hono } from "hono";
import { createDb } from "../../db/client";
import { recordScanEvent } from "../../db/events";
import {
  organizationRequiresAuthorityChangeApproval,
  organizationRequiresTwoFactorForReleaseDecisions,
} from "../../db/organizations";
import {
  prepareReleaseAuthorityApproval,
  type ReleaseAuthorityRecord,
  refreshReleaseAuthorityDeltaForGate,
  releaseAuthorityAcknowledgementToken,
} from "../../db/release-authority";
import { RateLimitError, enforceRateLimit } from "../../lib/platform/rate-limit";
import {
  claimGatePackageDecision,
  getScan,
  recordClaimedGatePackageDecision,
} from "../../db/scans";
import { badgeLookupKey } from "../../db/scan-share";
import { requireActiveOrganization } from "../../lib/auth/active-organization";
import { userHasTwoFactor, verifyTotpStepUp } from "../../lib/auth";
import { canonicalOrigin, rateLimitResponse } from "../../lib/platform/http";
import {
  optionalWorkerExecutionContext,
  workerExecutionContext,
} from "../../lib/platform/execution-context";
import { purgePublicFeedCache, scanDistTag } from "../../lib/public-feed";
import { recordProductEvent } from "../../lib/platform/analytics";
import { describeOperationalError, emitOperationalEvent } from "../../lib/platform/observability";
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
  const [packages, orgRequiresTwoFactor, orgRequiresAuthorityApproval, authority] =
    await Promise.all([
      listGatePackageScans(db, organizationId, gate.id),
      organizationRequiresTwoFactorForReleaseDecisions(db, organizationId),
      organizationRequiresAuthorityChangeApproval(db, organizationId),
      refreshReleaseAuthorityDeltaForGate(db, organizationId, gate.id),
    ]);
  return c.json({
    gate: publicWorkflowGate(gate, packages, orgRequiresTwoFactor),
    releaseAuthority: authority ? await publicReleaseAuthority(authority) : null,
    organizationRequiresAuthorityApproval: orgRequiresAuthorityApproval,
  });
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
  const body = (await c.req.json().catch(() => ({}))) as Partial<{
    decision: string;
    comment: string;
    totpCode: string;
    scanId: string;
    acknowledgeAuthorityChange: boolean;
    authorityAcknowledgementToken: string;
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
        gate: publicWorkflowGate(existing, packages, orgRequiresTwoFactor),
        error: "approval requires a completed workflow-gate review batch",
      },
      409,
    );
  }

  let authorityForDecision: ReleaseAuthorityRecord | null = null;
  let expectedLatestApprovedSnapshotId: string | null | undefined;
  let orgRequiresAuthorityApproval = false;
  let authorityChangeAcknowledged = false;
  if (decision === "approved") {
    orgRequiresAuthorityApproval = await organizationRequiresAuthorityChangeApproval(
      db,
      organizationId,
    );
    const preparedAuthority = await prepareReleaseAuthorityApproval(db, {
      organizationId,
      releaseTargetId: existing.releaseTargetId,
      gateId,
    });
    authorityForDecision = preparedAuthority.record;
    expectedLatestApprovedSnapshotId = preparedAuthority.expectedLatestApprovedSnapshotId;
    const authority = authorityForDecision;
    const requiresAuthorityApproval = authority?.delta?.requiresApproval === true;
    const acknowledgementToken = await releaseAuthorityAcknowledgementToken(authority);
    authorityChangeAcknowledged =
      requiresAuthorityApproval &&
      body.acknowledgeAuthorityChange === true &&
      typeof body.authorityAcknowledgementToken === "string" &&
      body.authorityAcknowledgementToken === acknowledgementToken;
    if (requiresAuthorityApproval && !authorityChangeAcknowledged && orgRequiresAuthorityApproval) {
      const packages = await listGatePackageScans(db, organizationId, gateId);
      return c.json(
        {
          gate: publicWorkflowGate(existing, packages, orgRequiresTwoFactor),
          error:
            "this release's publishing authority changed since the last approved release — review the release-authority delta and confirm the change to continue",
          code: "authority_change_acknowledgement_required",
          authorityChangeCount: authority?.delta?.changeCount ?? 0,
        },
        409,
      );
    }
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

  const packageDecisionInput = {
    scanId: packageScanId,
    organizationId,
    gateId,
    actorUserId: session.userId,
    decision: decision === "approved" ? ("publish" as const) : ("no_publish" as const),
    reason: comment || null,
  };
  const claimedPackage = await claimGatePackageDecision(db, packageDecisionInput);
  if (!claimedPackage) {
    const current = await getGateForOrganization(db, organizationId, gateId);
    const currentPackages = await listGatePackageScans(db, organizationId, gateId);
    return c.json(
      {
        gate: current ? publicWorkflowGate(current, currentPackages, orgRequiresTwoFactor) : null,
        error:
          current?.status === "pending"
            ? "package has already been decided"
            : "gate has already been decided",
      },
      409,
    );
  }

  // A decision changes what a listed scan's cached badge and feed entry
  // assert ("reviewed · risk" → "approved"/"blocked"); drop both so the
  // change is not delayed by the colo TTL in at least this region. Same
  // canonical-origin purge as the staged decision route and (un)listing.
  if (scan.scan.publicFeedListedAt) {
    purgePublicFeedCache(
      optionalWorkerExecutionContext(c),
      canonicalOrigin(c),
      badgeLookupKey({
        source: scan.scan.source,
        packageName: scan.scan.packageName,
        summaryJson: scan.scan.summaryJson,
      }),
      // Gate scans carry no dist-tag today, so this resolves to the default
      // entry — passed explicitly so it stays correct if they ever do.
      scanDistTag(scan.scan.summaryJson),
    );
  }

  // Aggregate over every package: release only when all are approved; block the
  // moment any one is rejected.
  const packages = await listGatePackageScans(db, organizationId, gateId);
  const anyRejected = packages.some((pkg) => pkg.decision === "no_publish");
  const allApproved = packages.length > 0 && packages.every((pkg) => pkg.decision === "publish");
  if (!anyRejected && !allApproved) {
    // Other packages still need a decision; keep the deployment held.
    await recordClaimedGatePackageDecision(db, packageDecisionInput, claimedPackage, c.env);
    return c.json({ gate: publicWorkflowGate(existing, packages, orgRequiresTwoFactor) });
  }
  if (allApproved && !existing.scanId) {
    return c.json(
      {
        gate: publicWorkflowGate(existing, packages, orgRequiresTwoFactor),
        error: "approval requires a completed workflow-gate review batch",
      },
      409,
    );
  }

  const gateDecision: GateDecision = anyRejected ? "rejected" : "approved";
  const reportUrl = buildReportUrl(c.env, existing.scanId);
  const decided = await markGateDecidedForPackageAggregate(db, {
    gateId,
    organizationId,
    decision: gateDecision,
    comment: comment || buildHumanDecisionComment(gateDecision, reportUrl),
    reportUrl,
    packageClaim: {
      scanId: packageScanId,
      actorUserId: session.userId,
      decidedAt: claimedPackage.decidedAt,
      decision: packageDecisionInput.decision,
    },
    authorityApproval:
      gateDecision === "approved"
        ? {
            approvedByUserId: session.userId,
            releaseTargetId: existing.releaseTargetId,
            expectedLatestApprovedSnapshotId,
          }
        : undefined,
  });
  if (!decided) {
    const current = await getGateForOrganization(db, organizationId, gateId);
    if (current?.status !== "pending") {
      await recordClaimedGatePackageDecision(db, packageDecisionInput, claimedPackage, c.env);
    }
    if (
      current?.status === "pending" &&
      gateDecision === "approved" &&
      authorityForDecision?.delta
    ) {
      const refreshedAuthority = await refreshReleaseAuthorityDeltaForGate(
        db,
        organizationId,
        gateId,
      );
      const currentPackages = await listGatePackageScans(db, organizationId, gateId);
      return c.json(
        {
          gate: publicWorkflowGate(current, currentPackages, orgRequiresTwoFactor),
          error: orgRequiresAuthorityApproval
            ? "the approved release-authority baseline changed while this decision was being submitted — review the refreshed delta and confirm it again"
            : "the approved release-authority baseline changed while this decision was being submitted — review the refreshed evidence and submit the decision again",
          code: orgRequiresAuthorityApproval
            ? "authority_change_acknowledgement_required"
            : "authority_baseline_changed",
          authorityChangeCount: refreshedAuthority?.delta?.changeCount ?? 0,
        },
        409,
      );
    }
    return c.json(
      {
        gate: current ? publicWorkflowGate(current, packages, orgRequiresTwoFactor) : null,
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

  try {
    await recordClaimedGatePackageDecision(db, packageDecisionInput, claimedPackage, c.env);
  } catch (err) {
    emitOperationalEvent("warn", "github_workflow_gate.package_decision_bookkeeping_failed", {
      organizationId,
      gateId,
      scanId: packageScanId,
      error: describeOperationalError(err),
    });
  }

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
        authorityChangeAcknowledged,
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

  return c.json({ gate: publicWorkflowGate(decided, packages, orgRequiresTwoFactor) });
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
        gate: publicWorkflowGate(existing, packages, orgRequiresTwoFactor),
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
      gate: publicWorkflowGate(gate ?? existing, packages, orgRequiresTwoFactor),
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
function publicWorkflowGate(
  record: WorkflowGateRecord,
  packages: GatePackageScan[] = [],
  organizationRequiresTwoFactor = false,
) {
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
    packages: packages.map((pkg) => ({
      scanId: pkg.scanId,
      packageName: pkg.packageName,
      version: pkg.stagedVersion,
      status: pkg.status,
      releaseRisk: pkg.releaseRisk,
      decision: pkg.decision,
    })),
    requestedAt: record.requestedAt.toISOString(),
    decidedAt: record.decidedAt ? record.decidedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function publicReleaseAuthority(record: ReleaseAuthorityRecord) {
  return {
    capturedAt: record.createdAt.toISOString(),
    runId: record.runId,
    workflowPath: record.workflowPath || null,
    headSha: record.headSha,
    artifactBindingDigest: record.artifactBindingDigest,
    approvedAt: record.approvedAt ? record.approvedAt.toISOString() : null,
    acknowledgementToken: await releaseAuthorityAcknowledgementToken(record),
    delta: record.delta,
    workflows: record.snapshot?.workflows ?? [],
    run: record.snapshot?.run ?? null,
  };
}
