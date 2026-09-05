/**
 * The organization-scoped dashboard overview: what is waiting on a reviewer,
 * what npm is still validating, what went live without a decision, and how
 * quickly decisions land. One aggregate statement, one round trip.
 *
 * Only npm staged-publish scans feed the npm-status figures. Workflow-gate
 * scans may describe PyPI or VS Code releases and published-pair reviews have
 * no stage, so npm's lifecycle status means nothing for either.
 */
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { NPM_RELEASE_OUTCOME_FAILURE_CODES } from "../lib/ecosystems/npm/version-status";
import type { AppDb } from "./client";
import { scans } from "./schema";

const SCAN_OVERVIEW_WINDOW_DAYS = 30;
const WINDOW_MS = SCAN_OVERVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const NPM_STAGED_SOURCES = ["manual", "auto_discovery"] as const;

export interface ScanOverview {
  totalScans: number;
  windowDays: number;
  /** Completed npm reviews with no decision whose stage npm has not settled. */
  waiting: { count: number; oldestCompletedAt: string | null };
  /** npm reviews whose last known status is `validating`; `reviewReady` are those Drydock has finished. */
  validating: { count: number; reviewReady: number };
  /** Went live without a decision, created inside the window. Mirrors the list filter of the same name. */
  publishedWithoutDecision: { count: number };
  decided: {
    count: number;
    approved: number;
    rejected: number;
    /** Median completion-to-decision time over decisions inside the window, or null when none carry both timestamps. */
    medianDecisionMs: number | null;
  };
}

function countWhere(condition: SQL): SQL<number> {
  return sql<number>`coalesce(sum(case when ${condition} then 1 else 0 end), 0)`;
}

export async function getScanOverview(
  db: AppDb,
  organizationId: string,
  options: { now?: Date } = {},
): Promise<ScanOverview> {
  const now = options.now ?? new Date();
  const windowStart = new Date(now.getTime() - WINDOW_MS);
  const windowStartMs = windowStart.getTime();

  const npmStaged = inArray(scans.source, [...NPM_STAGED_SOURCES]);
  const notSuperseded = isNull(scans.registryStatusSupersededAt);
  const undecided = isNull(scans.decision);
  const registryFailureCode = sql<string | null>`json_extract(${scans.errorJson}, '$.code')`;

  const waiting = and(
    npmStaged,
    notSuperseded,
    undecided,
    eq(scans.status, "complete"),
    or(
      isNull(scans.registryVersionStatus),
      inArray(scans.registryVersionStatus, ["staged", "validating"]),
    ),
  )!;
  const validating = and(npmStaged, notSuperseded, eq(scans.registryVersionStatus, "validating"))!;
  const validatingReviewReady = and(validating, eq(scans.status, "complete"))!;
  const publishedWithoutDecision = and(
    npmStaged,
    notSuperseded,
    undecided,
    sql`${scans.createdAt} >= ${windowStartMs}`,
    or(
      inArray(scans.registryVersionStatus, ["published", "deleted"]),
      inArray(registryFailureCode, [
        NPM_RELEASE_OUTCOME_FAILURE_CODES.published,
        NPM_RELEASE_OUTCOME_FAILURE_CODES.deleted,
      ]),
    ),
  )!;
  const decided = sql`${scans.decidedAt} >= ${windowStartMs}`;
  const decidedApproved = and(decided, eq(scans.decision, "publish"))!;
  const decidedRejected = and(decided, eq(scans.decision, "no_publish"))!;

  // SQLite has no median aggregate. The ordered scalar subquery below reads the
  // middle one or two deltas; the outer `avg` collapses both parities.
  const medianDeltaFilter = sql`${scans.organizationId} = ${organizationId} and ${scans.decidedAt} >= ${windowStartMs} and ${scans.completedAt} is not null`;
  const medianDecisionMs = sql<number | null>`(
    select avg(delta) from (
      select ${scans.decidedAt} - ${scans.completedAt} as delta
      from ${scans}
      where ${medianDeltaFilter}
      order by delta
      limit 2 - (select count(*) from ${scans} where ${medianDeltaFilter}) % 2
      offset (select (count(*) - 1) / 2 from ${scans} where ${medianDeltaFilter})
    )
  )`;

  const [row] = await db
    .select({
      totalScans: sql<number>`count(*)`,
      waitingCount: countWhere(waiting),
      waitingOldestCompletedAt: sql<
        number | null
      >`min(case when ${waiting} then ${scans.completedAt} end)`,
      validatingCount: countWhere(validating),
      validatingReviewReady: countWhere(validatingReviewReady),
      publishedWithoutDecisionCount: countWhere(publishedWithoutDecision),
      decidedCount: countWhere(decided),
      decidedApproved: countWhere(decidedApproved),
      decidedRejected: countWhere(decidedRejected),
      medianDecisionMs,
    })
    .from(scans)
    .where(eq(scans.organizationId, organizationId));

  const oldest = row?.waitingOldestCompletedAt;
  const median = row?.medianDecisionMs;
  return {
    totalScans: Number(row?.totalScans ?? 0),
    windowDays: SCAN_OVERVIEW_WINDOW_DAYS,
    waiting: {
      count: Number(row?.waitingCount ?? 0),
      oldestCompletedAt: typeof oldest === "number" ? new Date(oldest).toISOString() : null,
    },
    validating: {
      count: Number(row?.validatingCount ?? 0),
      reviewReady: Number(row?.validatingReviewReady ?? 0),
    },
    publishedWithoutDecision: { count: Number(row?.publishedWithoutDecisionCount ?? 0) },
    decided: {
      count: Number(row?.decidedCount ?? 0),
      approved: Number(row?.decidedApproved ?? 0),
      rejected: Number(row?.decidedRejected ?? 0),
      medianDecisionMs: typeof median === "number" ? Math.round(median) : null,
    },
  };
}
