/**
 * One organization's reviewed releases of a single package.
 *
 * Backs the package release view: every scan whose package identity — the
 * registry-captured name where the review has one, else the inspected manifest
 * name — matches, in one ecosystem, newest first. Channel (dist-tag) and the
 * baseline rule are read from the persisted summary so the page can group by
 * channel and say what each release was compared against without loading any
 * report artifact.
 */
import { and, count, desc, eq, lt, or, sql } from "drizzle-orm";
import { npmReleaseOutcome, type NpmReleaseOutcome } from "../lib/ecosystems/npm/version-status";
import type { AppDb } from "./client";
import {
  LIST_SCANS_DEFAULT_LIMIT,
  LIST_SCANS_MAX_LIMIT,
  publishedReleaseOutcomeCondition,
  publishedWithoutDecisionConditions,
  registryFailureCodeSql,
  scanEcosystemSql,
} from "./scan-list";
import { readScanRiskBreakdown, type ScanRiskSummary } from "./scan-risk";
import { scans, user } from "./schema";

export interface ListPackageReleasesOptions {
  packageName: string;
  ecosystem: string;
  cursor?: { createdAtMs: number; id: string } | null;
  limit?: number;
}

interface PackageReleaseRow {
  id: string;
  stageId: string;
  source: string;
  status: string;
  stagedVersion: string | null;
  previousVersion: string | null;
  /** Dist-tag the release was staged under; null when the source records none. */
  tag: string | null;
  baseline: {
    version: string | null;
    source: string | null;
    tag: string | null;
    distTagVersion: string | null;
  } | null;
  risk: string;
  riskSummary: ScanRiskSummary | null;
  decision: string | null;
  decisionReason: string | null;
  decidedByUserId: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  registryUrl: string | null;
  registryVersionStatus: string | null;
  registryVersionStatusAt: Date | null;
  registryReleaseOutcome: NpmReleaseOutcome | null;
  registryStatusSupersededAt: Date | null;
  createdAt: Date;
  completedAt: Date | null;
}

interface PackageReleasesSummary {
  totalReviews: number;
  channels: Array<{ tag: string | null; reviews: number }>;
  lastRelease: { id: string; version: string | null; tag: string | null; createdAt: Date } | null;
  publishedWithoutDecision: number;
  publishedDespiteBlock: number;
}

interface ListPackageReleasesResult {
  package: { name: string; ecosystem: string };
  summary: PackageReleasesSummary;
  releases: PackageReleaseRow[];
  nextCursor: { createdAtMs: number; id: string } | null;
}

// `registry_package_name` is the immutable control-plane identity and wins
// where it exists; the manifest name is the only identity a gate or published
// review has.
const identityNameSql = sql<
  string | null
>`coalesce(${scans.registryPackageName}, ${scans.packageName})`;
const tagSql = sql<string | null>`json_extract(${scans.summaryJson}, '$.stagedPublish.tag')`;

export async function listPackageReleases(
  db: AppDb,
  organizationId: string,
  options: ListPackageReleasesOptions,
): Promise<ListPackageReleasesResult> {
  const limit = Math.min(
    LIST_SCANS_MAX_LIMIT,
    Math.max(1, Math.floor(options.limit ?? LIST_SCANS_DEFAULT_LIMIT)),
  );
  const identity = [
    eq(scans.organizationId, organizationId),
    eq(identityNameSql, options.packageName),
    eq(scanEcosystemSql, options.ecosystem),
  ];

  const pageConditions = [...identity];
  if (options.cursor) {
    const cursorDate = new Date(options.cursor.createdAtMs);
    pageConditions.push(
      or(
        lt(scans.createdAt, cursorDate),
        and(eq(scans.createdAt, cursorDate), lt(scans.id, options.cursor.id)),
      )!,
    );
  }

  const [rows, channelRows, latestRows, [publishedWithoutDecision], [publishedDespiteBlock]] =
    await Promise.all([
      db
        .select({
          id: scans.id,
          stageId: scans.stageId,
          source: scans.source,
          status: scans.status,
          stagedVersion: scans.stagedVersion,
          previousVersion: scans.previousVersion,
          tag: tagSql,
          baselineVersion: sql<
            string | null
          >`json_extract(${scans.summaryJson}, '$.baseline.version')`,
          baselineSource: sql<
            string | null
          >`json_extract(${scans.summaryJson}, '$.baseline.source')`,
          baselineTag: sql<string | null>`json_extract(${scans.summaryJson}, '$.baseline.tag')`,
          baselineDistTagVersion: sql<
            string | null
          >`json_extract(${scans.summaryJson}, '$.baseline.distTagVersion')`,
          hasBaseline: sql<number>`json_type(${scans.summaryJson}, '$.baseline') is not null`,
          risk: scans.risk,
          riskSummaryJson: scans.riskSummaryJson,
          decision: scans.decision,
          decisionReason: scans.decisionReason,
          decidedByUserId: scans.decidedByUserId,
          decidedByName: user.name,
          decidedAt: scans.decidedAt,
          registryUrl: scans.registryUrl,
          registryVersionStatus: scans.registryVersionStatus,
          registryVersionStatusAt: scans.registryVersionStatusAt,
          registryFailureCode: registryFailureCodeSql,
          registryStatusSupersededAt: scans.registryStatusSupersededAt,
          createdAt: scans.createdAt,
          completedAt: scans.completedAt,
        })
        .from(scans)
        .leftJoin(user, eq(user.id, scans.decidedByUserId))
        .where(and(...pageConditions))
        .orderBy(desc(scans.createdAt), desc(scans.id))
        .limit(limit + 1),
      db
        .select({ tag: tagSql, reviews: count() })
        .from(scans)
        .where(and(...identity))
        .groupBy(tagSql)
        .orderBy(desc(count())),
      db
        .select({
          id: scans.id,
          version: scans.stagedVersion,
          tag: tagSql,
          createdAt: scans.createdAt,
        })
        .from(scans)
        .where(and(...identity))
        .orderBy(desc(scans.createdAt), desc(scans.id))
        .limit(1),
      db
        .select({ value: count() })
        .from(scans)
        .where(and(...identity, ...publishedWithoutDecisionConditions())),
      db
        .select({ value: count() })
        .from(scans)
        .where(
          and(...identity, eq(scans.decision, "no_publish"), publishedReleaseOutcomeCondition()),
        ),
    ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? { createdAtMs: new Date(last.createdAt).getTime(), id: last.id } : null;

  return {
    package: { name: options.packageName, ecosystem: options.ecosystem },
    summary: {
      totalReviews: channelRows.reduce((sum, row) => sum + row.reviews, 0),
      channels: channelRows.map((row) => ({ tag: row.tag, reviews: row.reviews })),
      lastRelease: latestRows[0] ?? null,
      publishedWithoutDecision: publishedWithoutDecision?.value ?? 0,
      publishedDespiteBlock: publishedDespiteBlock?.value ?? 0,
    },
    releases: page.map((row) => ({
      id: row.id,
      stageId: row.stageId,
      source: row.source,
      status: row.status,
      stagedVersion: row.stagedVersion,
      previousVersion: row.previousVersion,
      tag: row.tag,
      baseline: row.hasBaseline
        ? {
            version: row.baselineVersion,
            source: row.baselineSource,
            tag: row.baselineTag,
            distTagVersion: row.baselineDistTagVersion,
          }
        : null,
      risk: row.risk,
      riskSummary: row.status === "complete" ? readScanRiskBreakdown(row.riskSummaryJson) : null,
      decision: row.decision,
      decisionReason: row.decisionReason,
      decidedByUserId: row.decidedByUserId,
      decidedByName: row.decidedByName,
      decidedAt: row.decidedAt,
      registryUrl: row.registryUrl,
      registryVersionStatus: row.registryVersionStatus,
      registryVersionStatusAt: row.registryVersionStatusAt,
      registryReleaseOutcome: npmReleaseOutcome(row.registryVersionStatus, row.registryFailureCode),
      registryStatusSupersededAt: row.registryStatusSupersededAt,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
    })),
    nextCursor,
  };
}
