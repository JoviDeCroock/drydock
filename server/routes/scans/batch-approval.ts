/**
 * Approving several low-risk staged reviews in one action.
 *
 * A release that stages many packages at once otherwise asks for one decision
 * per package, and reviews left undecided cost the organization its monitor
 * and badge evidence. Only rows `listBatchApprovableScans` would return are
 * approved; the list is re-checked in the statement that writes the decisions.
 */
import { Hono } from "hono";
import { requireVerifiedEmail } from "../../lib/auth/email-verification";
import {
  BATCH_APPROVAL_LIMIT,
  listBatchApprovableScans,
  recordBatchApproval,
} from "../../db/scans";
import { requireActiveOrganization } from "../../lib/auth/active-organization";
import { canonicalOrigin, readJsonObject } from "../../lib/platform/http";
import { optionalWorkerExecutionContext } from "../../lib/platform/execution-context";
import { badgeLookupKey, purgePublicFeedCache, scanDistTag } from "../../lib/public-feed";
import type { Bindings, Variables } from "../../types";
import { DECISION_REASON_MAX } from "./decisions";

export const scanBatchApprovalRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const SCAN_ID_MAX = 128;

scanBatchApprovalRoutes.get("/batch-approval", async (c) => {
  const db = c.var.db;
  const organizationId = await requireActiveOrganization(c, db);
  return c.json(await listBatchApprovableScans(db, organizationId));
});

scanBatchApprovalRoutes.post("/batch-approval", async (c) => {
  const unverified = requireVerifiedEmail(c);
  if (unverified) return unverified;
  const body = await readJsonObject<{ scanIds: unknown; reason: unknown }>(c);
  const scanIds = body.scanIds;
  if (
    !Array.isArray(scanIds) ||
    scanIds.length === 0 ||
    scanIds.length > BATCH_APPROVAL_LIMIT ||
    !scanIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= SCAN_ID_MAX)
  ) {
    return c.json(
      { error: `scanIds must list between 1 and ${BATCH_APPROVAL_LIMIT} scan ids` },
      400,
    );
  }
  const reason = typeof body.reason === "string" ? body.reason : null;
  if (reason && reason.length > DECISION_REASON_MAX) {
    return c.json({ error: `reason must be <= ${DECISION_REASON_MAX} characters` }, 400);
  }

  const db = c.var.db;
  const organizationId = await requireActiveOrganization(c, db);
  const approved = await recordBatchApproval(
    db,
    {
      organizationId,
      actorUserId: c.get("authSession").userId,
      scanIds: scanIds as string[],
      reason,
    },
    c.env,
  );

  // Same purge as a single decision: an approval turns a cached badge green.
  const executionCtx = optionalWorkerExecutionContext(c);
  for (const row of approved) {
    if (!row.badgePublic && !row.publicFeedListedAt) continue;
    purgePublicFeedCache(
      executionCtx,
      canonicalOrigin(c),
      badgeLookupKey(row),
      scanDistTag(row.summaryJson),
    );
  }

  const approvedIds = new Set(approved.map((row) => row.id));
  return c.json({
    approved: approved.map((row) => ({
      id: row.id,
      packageName: row.packageName,
      stagedVersion: row.stagedVersion,
    })),
    skipped: [...new Set(scanIds as string[])].filter((id) => !approvedIds.has(id)),
  });
});
