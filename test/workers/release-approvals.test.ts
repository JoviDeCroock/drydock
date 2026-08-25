import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { addOrganizationMember, removeOrganizationMember } from "../../server/db/invitations";
import {
  createOrganization,
  deleteUserAccount,
  ensurePersonalOrganization,
} from "../../server/db/organizations";
import { createScanJob, persistScan, setRequiredReleaseApprovals } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { scansRoutes } from "../../server/routes/scans";
import type { Bindings, Variables } from "../../server/types";

// Multi-party approval: `scans.decision` is derived from per-member votes, so a
// release only reads as approved once the org's bar is met. These specs drive
// the real decision route, because the interesting cases are all about *who*
// the second request comes from — the same member, a different one, one who has
// since left — which a unit test on the tally function cannot express.

interface SeededUser {
  userId: string;
}

async function seedUser(): Promise<SeededUser> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: `Reviewer ${userId.slice(-6)}`,
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  await ensurePersonalOrganization(db, { userId });
  return { userId };
}

/** A shared org with `members` reviewers in it, all able to decide releases. */
async function seedSharedOrganization(memberCount: number, requiredApprovals: number) {
  const db = createDb(env.DB);
  const users: SeededUser[] = [];
  for (let i = 0; i < memberCount; i += 1) users.push(await seedUser());
  const organizationId = await createOrganization(db, {
    ownerUserId: users[0].userId,
    name: `Org ${crypto.randomUUID().slice(0, 8)}`,
  });
  for (const member of users.slice(1)) {
    await addOrganizationMember(db, {
      organizationId,
      userId: member.userId,
      role: "member",
    });
  }
  await setRequiredReleaseApprovals(db, organizationId, requiredApprovals);
  return { organizationId, users };
}

async function seedCompletedScan(
  organizationId: string,
  ownerUserId: string,
  source: "manual" | "workflow_gate" = "manual",
) {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${scanId.slice(-12)}`;
  await createScanJob(db, { id: scanId, stageId, organizationId, ownerUserId, source });
  await persistScan(db, {
    id: scanId,
    stageId,
    organizationId,
    ownerUserId,
    packageJson: { name: "@org/pkg", version: "1.2.3" },
    risk: "low",
    status: "complete",
    summary: { ok: true },
    ai: null,
    files: [],
    diff: [],
    findings: [],
    report: { version: 1, digest: "digest" },
  });
  return scanId;
}

function buildTestApp(session: { userId: string; organizationId: string }) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId: session.userId });
    // The route resolves the active org from the session cookie in production;
    // pinning it here keeps these specs about approvals rather than org switching.
    c.req.raw.headers.set("x-organization-id", session.organizationId);
    await next();
  });
  app.route("/api/v1/scans", scansRoutes);
  return app;
}

async function decide(
  session: { userId: string; organizationId: string },
  scanId: string,
  decision: "publish" | "no_publish",
  reason?: string,
) {
  const app = buildTestApp(session);
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://test.local/api/v1/scans/${scanId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, reason }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const body = (await res.json()) as {
    scan?: { decision: string | null; decidedByUserId: string | null };
    approvals?: {
      required: number;
      approvedCount: number;
      verdict: string | null;
      legacyDecision?: boolean;
      approvals: Array<{ userId: string | null; decision: string }>;
      eligibleApproverCount: number;
    };
    error?: string;
  };
  return { status: res.status, body };
}

async function readDecision(scanId: string) {
  const db = createDb(env.DB);
  const [row] = await db
    .select({ decision: schema.scans.decision, decidedByUserId: schema.scans.decidedByUserId })
    .from(schema.scans)
    .where(eq(schema.scans.id, scanId))
    .limit(1);
  return row;
}

describe("multi-party release approval", () => {
  test("a single approval leaves the release undecided when the org requires two", async () => {
    const { organizationId, users } = await seedSharedOrganization(2, 2);
    const scanId = await seedCompletedScan(organizationId, users[0].userId);

    const first = await decide({ ...users[0], organizationId }, scanId, "publish", "diff is clean");

    expect(first.status).toBe(200);
    expect(first.body.approvals).toMatchObject({
      required: 2,
      approvedCount: 1,
      verdict: null,
    });
    // The whole point: approved by someone, not yet approved.
    expect(first.body.scan?.decision).toBeNull();
    expect((await readDecision(scanId))?.decision).toBeNull();
  });

  test("a second distinct member's approval swaps the release to approved", async () => {
    const { organizationId, users } = await seedSharedOrganization(2, 2);
    const scanId = await seedCompletedScan(organizationId, users[0].userId);

    await decide({ ...users[0], organizationId }, scanId, "publish");
    const second = await decide({ ...users[1], organizationId }, scanId, "publish", "agreed");

    expect(second.status).toBe(200);
    expect(second.body.approvals).toMatchObject({ approvedCount: 2, verdict: "publish" });
    const stored = await readDecision(scanId);
    expect(stored?.decision).toBe("publish");
    // The member whose vote met the bar owns the decision row.
    expect(stored?.decidedByUserId).toBe(users[1].userId);
  });

  test("the same member approving twice never meets a two-approval bar", async () => {
    const { organizationId, users } = await seedSharedOrganization(2, 2);
    const scanId = await seedCompletedScan(organizationId, users[0].userId);

    await decide({ ...users[0], organizationId }, scanId, "publish", "first look");
    const again = await decide({ ...users[0], organizationId }, scanId, "publish", "still fine");

    expect(again.status).toBe(200);
    expect(again.body.approvals).toMatchObject({ approvedCount: 1, verdict: null });
    expect((await readDecision(scanId))?.decision).toBeNull();
    // One row per member, replaced rather than appended.
    const db = createDb(env.DB);
    const votes = await db
      .select()
      .from(schema.scanApprovals)
      .where(eq(schema.scanApprovals.scanId, scanId));
    expect(votes).toHaveLength(1);
    expect(votes[0].reason).toBe("still fine");
  });

  test("one block decides the release immediately, whatever the bar is", async () => {
    const { organizationId, users } = await seedSharedOrganization(3, 3);
    const scanId = await seedCompletedScan(organizationId, users[0].userId);

    await decide({ ...users[0], organizationId }, scanId, "publish");
    const blocked = await decide({ ...users[1], organizationId }, scanId, "no_publish", "malware");

    expect(blocked.body.approvals).toMatchObject({ verdict: "no_publish" });
    expect((await readDecision(scanId))?.decision).toBe("no_publish");
  });

  test("a block wins even after the release has already reached its approval bar", async () => {
    const { organizationId, users } = await seedSharedOrganization(3, 2);
    const scanId = await seedCompletedScan(organizationId, users[0].userId);

    await decide({ ...users[0], organizationId }, scanId, "publish");
    await decide({ ...users[1], organizationId }, scanId, "publish");
    expect((await readDecision(scanId))?.decision).toBe("publish");

    await decide({ ...users[2], organizationId }, scanId, "no_publish", "found an exfil sink");
    expect((await readDecision(scanId))?.decision).toBe("no_publish");
  });

  test("a concurrent block cannot be overwritten by an approval tallied earlier", async () => {
    const { organizationId, users } = await seedSharedOrganization(2, 2);
    const scanId = await seedCompletedScan(organizationId, users[0].userId);
    await decide({ ...users[0], organizationId }, scanId, "publish");

    await Promise.all([
      decide({ ...users[1], organizationId }, scanId, "publish"),
      decide({ ...users[0], organizationId }, scanId, "no_publish", "found a blocker"),
    ]);

    expect((await readDecision(scanId))?.decision).toBe("no_publish");
  });

  test("concurrent co-approvers emit one logical decision event", async () => {
    const { organizationId, users } = await seedSharedOrganization(2, 2);
    const scanId = await seedCompletedScan(organizationId, users[0].userId);

    await Promise.all([
      decide({ ...users[0], organizationId }, scanId, "publish"),
      decide({ ...users[1], organizationId }, scanId, "publish"),
    ]);

    expect((await readDecision(scanId))?.decision).toBe("publish");
    const decisionEvents = await createDb(env.DB)
      .select()
      .from(schema.scanEvents)
      .where(and(eq(schema.scanEvents.scanId, scanId), eq(schema.scanEvents.type, "scan.decided")));
    expect(decisionEvents).toHaveLength(1);
  });

  test("the default one-approval policy decides on the first vote, as before", async () => {
    const { organizationId, users } = await seedSharedOrganization(2, 1);
    const scanId = await seedCompletedScan(organizationId, users[0].userId);

    const only = await decide({ ...users[0], organizationId }, scanId, "publish");

    expect(only.body.approvals).toMatchObject({ required: 1, verdict: "publish" });
    expect((await readDecision(scanId))?.decision).toBe("publish");
  });

  test("the staged decision route cannot add a workflow-gate approval", async () => {
    const { organizationId, users } = await seedSharedOrganization(2, 2);
    const scanId = await seedCompletedScan(organizationId, users[0].userId, "workflow_gate");

    const result = await decide({ ...users[0], organizationId }, scanId, "publish");

    expect(result.status).toBe(409);
    expect(result.body.error).toBe("workflow-gate decisions must be submitted through the gate");
    const votes = await createDb(env.DB)
      .select()
      .from(schema.scanApprovals)
      .where(eq(schema.scanApprovals.scanId, scanId));
    expect(votes).toHaveLength(0);
  });

  test("changing the policy immediately reconciles existing votes", async () => {
    const { organizationId, users } = await seedSharedOrganization(3, 3);
    const scanId = await seedCompletedScan(organizationId, users[0].userId);
    await decide({ ...users[0], organizationId }, scanId, "publish");
    await decide({ ...users[1], organizationId }, scanId, "publish");
    expect((await readDecision(scanId))?.decision).toBeNull();

    const db = createDb(env.DB);
    await setRequiredReleaseApprovals(db, organizationId, 2);
    expect((await readDecision(scanId))?.decision).toBe("publish");

    await setRequiredReleaseApprovals(db, organizationId, 3);
    expect((await readDecision(scanId))?.decision).toBeNull();
  });

  test("a stale conditional policy write cannot lower the live bar", async () => {
    const { organizationId } = await seedSharedOrganization(2, 2);
    const db = createDb(env.DB);

    const stale = await setRequiredReleaseApprovals(db, organizationId, 1, 1);

    expect(stale.applied).toBe(false);
    const [organization] = await db
      .select({ required: schema.organizations.requiredReleaseApprovals })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, organizationId));
    expect(organization?.required).toBe(2);
  });

  test("removing a member drops their approval from a release still awaiting one", async () => {
    const { organizationId, users } = await seedSharedOrganization(3, 2);
    const scanId = await seedCompletedScan(organizationId, users[0].userId);
    await decide({ ...users[1], organizationId }, scanId, "publish");

    const db = createDb(env.DB);
    await removeOrganizationMember(db, organizationId, users[1].userId);

    const remaining = await db
      .select()
      .from(schema.scanApprovals)
      .where(
        and(
          eq(schema.scanApprovals.scanId, scanId),
          eq(schema.scanApprovals.userId, users[1].userId),
        ),
      );
    expect(remaining).toHaveLength(0);

    // And the release is genuinely back to needing two people, not one.
    const next = await decide({ ...users[0], organizationId }, scanId, "publish");
    expect(next.body.approvals).toMatchObject({ approvedCount: 1, verdict: null });
  });

  test("a former member does not count again when a policy increase reopens a release", async () => {
    const { organizationId, users } = await seedSharedOrganization(4, 2);
    const scanId = await seedCompletedScan(organizationId, users[0].userId);
    await decide({ ...users[0], organizationId }, scanId, "publish");
    await decide({ ...users[1], organizationId }, scanId, "publish");
    expect((await readDecision(scanId))?.decision).toBe("publish");

    const db = createDb(env.DB);
    // The decided roster remains historical when the member leaves.
    await removeOrganizationMember(db, organizationId, users[1].userId);
    await setRequiredReleaseApprovals(db, organizationId, 3);
    expect((await readDecision(scanId))?.decision).toBeNull();

    const third = await decide({ ...users[2], organizationId }, scanId, "publish");
    expect(third.body.approvals).toMatchObject({ approvedCount: 2, verdict: null });
    expect(third.body.approvals?.approvals).toContainEqual(
      expect.objectContaining({ userId: users[1].userId, eligible: false }),
    );

    const fourth = await decide({ ...users[3], organizationId }, scanId, "publish");
    expect(fourth.body.approvals).toMatchObject({ approvedCount: 4, verdict: "publish" });
    expect((await readDecision(scanId))?.decision).toBe("publish");

    const decisionEvents = await db
      .select({ metadata: schema.scanEvents.metadataJson })
      .from(schema.scanEvents)
      .where(and(eq(schema.scanEvents.scanId, scanId), eq(schema.scanEvents.type, "scan.decided")));
    expect(decisionEvents).toContainEqual({
      metadata: expect.objectContaining({ approvedCount: 3, requiredApprovals: 3 }),
    });
  });

  test("deleting an account drops its approval from a release still awaiting one", async () => {
    const { organizationId, users } = await seedSharedOrganization(3, 2);
    const scanId = await seedCompletedScan(organizationId, users[0].userId);
    await decide({ ...users[1], organizationId }, scanId, "publish");

    const db = createDb(env.DB);
    await deleteUserAccount(db, users[1].userId);

    const remaining = await db
      .select()
      .from(schema.scanApprovals)
      .where(eq(schema.scanApprovals.scanId, scanId));
    expect(remaining).toHaveLength(0);

    const next = await decide({ ...users[0], organizationId }, scanId, "publish");
    expect(next.body.approvals).toMatchObject({ approvedCount: 1, verdict: null });
  });

  test("deleting an account anonymizes rather than removes a decided approval", async () => {
    const { organizationId, users } = await seedSharedOrganization(2, 2);
    const scanId = await seedCompletedScan(organizationId, users[0].userId);
    await decide({ ...users[0], organizationId }, scanId, "publish");
    await decide({ ...users[1], organizationId }, scanId, "publish");

    const db = createDb(env.DB);
    await deleteUserAccount(db, users[1].userId);

    const votes = await db
      .select({ userId: schema.scanApprovals.userId })
      .from(schema.scanApprovals)
      .where(eq(schema.scanApprovals.scanId, scanId));
    expect(votes).toHaveLength(2);
    expect(votes).toContainEqual({ userId: null });
    expect((await readDecision(scanId))?.decision).toBe("publish");
  });

  test("the scan detail reports the roster and the bar", async () => {
    const { organizationId, users } = await seedSharedOrganization(2, 2);
    const scanId = await seedCompletedScan(organizationId, users[0].userId);
    await decide({ ...users[0], organizationId }, scanId, "publish", "looks fine");

    const app = buildTestApp({ ...users[1], organizationId });
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`http://test.local/api/v1/scans/${scanId}`), env, ctx);
    await waitOnExecutionContext(ctx);
    const body = (await res.json()) as {
      approvals: {
        required: number;
        approvedCount: number;
        viewerDecision: string | null;
        eligibleApproverCount: number;
        approvals: Array<{ userId: string | null; decision: string; reason: string | null }>;
      };
    };

    expect(body.approvals.required).toBe(2);
    expect(body.approvals.approvedCount).toBe(1);
    expect(body.approvals.eligibleApproverCount).toBe(2);
    // The second reviewer has not voted, and sees who did.
    expect(body.approvals.viewerDecision).toBeNull();
    expect(body.approvals.approvals).toEqual([
      expect.objectContaining({
        userId: users[0].userId,
        decision: "publish",
        reason: "looks fine",
      }),
    ]);
  });

  test("the scan detail and list identify a pre-roster decision as legacy", async () => {
    const { organizationId, users } = await seedSharedOrganization(2, 2);
    const scanId = await seedCompletedScan(organizationId, users[0].userId);
    await createDb(env.DB)
      .update(schema.scans)
      .set({
        decision: "publish",
        decidedByUserId: users[0].userId,
        decidedAt: new Date(),
      })
      .where(eq(schema.scans.id, scanId));

    const app = buildTestApp({ ...users[1], organizationId });
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`http://test.local/api/v1/scans/${scanId}`), env, ctx);
    await waitOnExecutionContext(ctx);
    const body = (await res.json()) as {
      approvals: {
        required: number;
        approvedCount: number;
        verdict: string | null;
        legacyDecision: boolean;
      };
    };

    expect(body.approvals).toMatchObject({
      required: 2,
      approvedCount: 1,
      verdict: "publish",
      legacyDecision: true,
    });

    const listCtx = createExecutionContext();
    const listRes = await app.fetch(
      new Request("http://test.local/api/v1/scans?filter=all"),
      env,
      listCtx,
    );
    await waitOnExecutionContext(listCtx);
    const listBody = (await listRes.json()) as {
      scans: Array<{ id: string; legacyDecision: boolean }>;
    };
    expect(listBody.scans.find((scan) => scan.id === scanId)).toMatchObject({
      legacyDecision: true,
    });
  });

  test("the scan list carries the tally and the bar", async () => {
    const { organizationId, users } = await seedSharedOrganization(2, 2);
    const scanId = await seedCompletedScan(organizationId, users[0].userId);
    await decide({ ...users[0], organizationId }, scanId, "publish");

    const app = buildTestApp({ ...users[0], organizationId });
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request("http://test.local/api/v1/scans"), env, ctx);
    await waitOnExecutionContext(ctx);
    const body = (await res.json()) as {
      requiredApprovals: number;
      scans: Array<{ id: string; decision: string | null; approvalCount: number }>;
    };

    expect(body.requiredApprovals).toBe(2);
    const row = body.scans.find((entry) => entry.id === scanId);
    // Still in the undecided queue — which is exactly where the second
    // approver needs to find it.
    expect(row).toMatchObject({ decision: null, approvalCount: 1 });
  });
});
