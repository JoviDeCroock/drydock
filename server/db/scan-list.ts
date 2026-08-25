/**
 * The organization-scoped scan list.
 *
 * Backs the dashboard table: keyset-paginated, filterable by decision, and
 * reading its risk figures off the denormalized summary so a page of rows
 * never has to load findings.
 */
import { and, desc, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import {
  npmReleaseOutcome,
  NPM_RELEASE_OUTCOME_FAILURE_CODES,
  SETTLED_NPM_VERSION_STATUSES,
  type NpmReleaseOutcome,
} from "../lib/ecosystems/npm/version-status";
import type { AppDb } from "./client";
import { countScanApprovals, getOrganizationApprovalPolicy } from "./scan-approvals";
import type { ScanDecisionFilter } from "./scan-decisions";
import { readScanRiskBreakdown, type ScanRiskSummary } from "./scan-risk";
import { scans } from "./schema";

export interface ListScansOptions {
  cursor?: { createdAtMs: number; id: string } | null;
  limit?: number;
  decisionFilter?: ScanDecisionFilter;
}

export interface ListScansResult {
  /** The org's approval bar, so the list can render "1 of 2 approved". */
  requiredApprovals: number;
  scans: Array<{
    id: string;
    stageId: string;
    source: string;
    /** Registry the review describes; null while a workflow-gate scan has no report yet. */
    ecosystem: string | null;
    organizationId: string | null;
    ownerUserId: string | null;
    packageName: string | null;
    stagedVersion: string | null;
    registryUrl: string | null;
    previousVersion: string | null;
    risk: string;
    status: string;
    decision: string | null;
    decisionReason: string | null;
    decidedByUserId: string | null;
    decidedAt: Date | null;
    /** Distinct members who have approved so far — 0 or 1 unless the org requires more. */
    approvalCount: number;
    /** The verdict exists without a member vote roster and must not be compared to today's bar. */
    legacyDecision: boolean;
    changedFileCount: number;
    findingCount: number;
    riskSummary: ScanRiskSummary | null;
    reportVersion: number | null;
    reportDigest: string | null;
    registryVersionStatus: string | null;
    registryVersionStatusAt: Date | null;
    registryReleaseOutcome: NpmReleaseOutcome | null;
    registryStatusSupersededAt: Date | null;
    startedAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
  nextCursor: { createdAtMs: number; id: string } | null;
}

export const LIST_SCANS_DEFAULT_LIMIT = 20;
export const LIST_SCANS_MAX_LIMIT = 100;

/** The terminal failure code a scan recorded, if any. */
export const registryFailureCodeSql = sql<
  string | null
>`json_extract(${scans.errorJson}, '$.code')`;

/**
 * SQL twin of `scanEcosystem` in `lib/public-feed.ts`: npm for the
 * credential-backed staged sources — the only sources that can exist without
 * a report — else the gate provenance or published-pair declaration the report
 * recorded. A pending workflow-gate scan therefore has no ecosystem yet, and
 * stays out of any per-ecosystem package view until its report says which
 * registry it describes. The staged branch is tested first so SQLite never
 * parses a staged review's (large) summary for an answer its source already
 * gives.
 */
export const scanEcosystemSql = sql<string | null>`case
  when ${scans.source} in ('manual', 'auto_discovery') then 'npm'
  else coalesce(
    json_extract(${scans.summaryJson}, '$.stagedPublish.provenance.ecosystem'),
    json_extract(${scans.summaryJson}, '$.stagedPublish.ecosystem')
  )
end`;

/** npm shipped the version, or shipped it and later removed it. */
export function publishedReleaseOutcomeCondition() {
  return or(
    inArray(scans.registryVersionStatus, ["published", "deleted"]),
    inArray(registryFailureCodeSql, [
      NPM_RELEASE_OUTCOME_FAILURE_CODES.published,
      NPM_RELEASE_OUTCOME_FAILURE_CODES.deleted,
    ]),
  )!;
}

/**
 * Releases npm reports as live (or live-then-removed) with no Drydock decision
 * on record. Shared with the package view so its "published without review"
 * count is the same set the dashboard filter shows.
 */
export function publishedWithoutDecisionConditions() {
  return [
    isNull(scans.decision),
    isNull(scans.registryStatusSupersededAt),
    publishedReleaseOutcomeCondition(),
  ];
}

export async function listScans(
  db: AppDb,
  organizationId: string,
  options: ListScansOptions = {},
): Promise<ListScansResult> {
  const limit = Math.min(
    LIST_SCANS_MAX_LIMIT,
    Math.max(1, Math.floor(options.limit ?? LIST_SCANS_DEFAULT_LIMIT)),
  );
  const decisionFilter = options.decisionFilter ?? "undecided";
  const registryFailureCode = registryFailureCodeSql;
  const settledFailureCodes = Object.values(NPM_RELEASE_OUTCOME_FAILURE_CODES);

  const conditions = [eq(scans.organizationId, organizationId)];
  if (decisionFilter === "undecided") {
    // Superseded reviews are immutable history, not pending work: the decision
    // route refuses them, so leaving them in the default queue creates rows the
    // reviewer can never resolve. Settled npm releases are no longer pending;
    // completed reviews remain decidable while failed reviews are read-only.
    // Both stay visible under the `all` filter.
    conditions.push(
      isNull(scans.decision),
      isNull(scans.registryStatusSupersededAt),
      or(
        isNull(scans.registryVersionStatus),
        notInArray(scans.registryVersionStatus, [...SETTLED_NPM_VERSION_STATUSES]),
      )!,
      or(isNull(registryFailureCode), notInArray(registryFailureCode, settledFailureCodes))!,
    );
  } else if (decisionFilter === "published_without_decision") {
    conditions.push(...publishedWithoutDecisionConditions());
  } else if (decisionFilter === "publish") conditions.push(eq(scans.decision, "publish"));
  else if (decisionFilter === "no_publish") conditions.push(eq(scans.decision, "no_publish"));

  if (options.cursor) {
    const cursorDate = new Date(options.cursor.createdAtMs);
    conditions.push(
      or(
        lt(scans.createdAt, cursorDate),
        and(eq(scans.createdAt, cursorDate), lt(scans.id, options.cursor.id)),
      )!,
    );
  }

  const rows = await db
    .select({
      id: scans.id,
      stageId: scans.stageId,
      source: scans.source,
      ecosystem: scanEcosystemSql,
      organizationId: scans.organizationId,
      ownerUserId: scans.ownerUserId,
      packageName: scans.packageName,
      stagedVersion: scans.stagedVersion,
      registryUrl: scans.registryUrl,
      previousVersion: scans.previousVersion,
      risk: scans.risk,
      status: scans.status,
      decision: scans.decision,
      decisionReason: scans.decisionReason,
      decidedByUserId: scans.decidedByUserId,
      decidedAt: scans.decidedAt,
      changedFileCount: scans.changedFileCount,
      findingCount: scans.findingCount,
      riskSummaryJson: scans.riskSummaryJson,
      reportVersion: scans.reportVersion,
      reportDigest: scans.reportDigest,
      registryVersionStatus: scans.registryVersionStatus,
      registryVersionStatusAt: scans.registryVersionStatusAt,
      registryFailureCode,
      registryStatusSupersededAt: scans.registryStatusSupersededAt,
      startedAt: scans.startedAt,
      completedAt: scans.completedAt,
      createdAt: scans.createdAt,
      updatedAt: scans.updatedAt,
    })
    .from(scans)
    .where(and(...conditions))
    .orderBy(desc(scans.createdAt), desc(scans.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? { createdAtMs: new Date(last.createdAt).getTime(), id: last.id } : null;

  const [policy, approvals] = await Promise.all([
    getOrganizationApprovalPolicy(db, organizationId),
    // One grouped read over the page's ids rather than a per-row subquery, so
    // the review queue costs the same one extra query at any page size.
    countScanApprovals(
      db,
      organizationId,
      page.map((row) => row.id),
    ),
  ]);

  if (!page.length) return { scans: [], nextCursor, requiredApprovals: policy.required };

  return {
    requiredApprovals: policy.required,
    scans: page.map((row) => ({
      id: row.id,
      stageId: row.stageId,
      source: row.source,
      ecosystem: row.ecosystem,
      organizationId: row.organizationId,
      ownerUserId: row.ownerUserId,
      packageName: row.packageName,
      stagedVersion: row.stagedVersion,
      registryUrl: row.registryUrl,
      previousVersion: row.previousVersion,
      risk: row.risk,
      status: row.status,
      decision: row.decision,
      decisionReason: row.decisionReason,
      decidedByUserId: row.decidedByUserId,
      decidedAt: row.decidedAt,
      approvalCount:
        (row.decision === null
          ? approvals.get(row.id)?.eligibleApproved
          : approvals.get(row.id)?.approved) ?? (row.decision === "publish" ? 1 : 0),
      legacyDecision:
        !approvals.has(row.id) && (row.decision === "publish" || row.decision === "no_publish"),
      changedFileCount: row.changedFileCount ?? 0,
      findingCount: row.findingCount ?? 0,
      riskSummary: row.status === "complete" ? readScanRiskBreakdown(row.riskSummaryJson) : null,
      reportVersion: row.reportVersion,
      reportDigest: row.reportDigest,
      registryVersionStatus: row.registryVersionStatus,
      registryVersionStatusAt: row.registryVersionStatusAt,
      registryReleaseOutcome: npmReleaseOutcome(row.registryVersionStatus, row.registryFailureCode),
      registryStatusSupersededAt: row.registryStatusSupersededAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    nextCursor,
  };
}
