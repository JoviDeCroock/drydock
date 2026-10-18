/**
 * Report views: when an organization member loaded a completed review, and
 * whether that happened before npm published the release.
 *
 * A load is "the report was opened", never "the release was reviewed". Views
 * are counted per scan, with no user, IP, or user agent, because the product
 * question is whether anyone in the organization looked before publication.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AppDb } from "./client";
import type { ReportViewSurface } from "./enums";
import { scans } from "./schema";

/**
 * Drydock's clock and npm's are independent, so a view this close to the
 * publication instant is not ordered against it.
 */
export const REPORT_VIEW_CLOCK_SKEW_MS = 10_000;

export type ReportOpenedBeforePublication = "opened" | "not_opened" | "unknown";

type Instant = Date | number | string | null | undefined;

function epoch(value: Instant): number | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export interface ReportViewVerdictInput {
  source: string;
  status: string;
  registryStatusSupersededAt?: Instant;
  registryPublishedAt?: Instant;
  registryVersionStatus?: string | null;
  registryVersionStatusAt?: Instant;
  reportFirstViewedAt?: Instant;
  reportViewCount?: number | null;
}

/**
 * Whether anyone in the organization opened this staged review's report
 * before npm published the release. Null when the question does not apply:
 * not a completed staged review, superseded by a restage, or no evidence of
 * publication. Only npm's own publication time or a `published`/`deleted`
 * version status count as publication; a stage leaving npm's stage list does
 * not.
 *
 * With npm's exact publication time the views order against it, except inside
 * the clock-skew margin. A version status only says the release was published
 * by the time it was observed, so a view before that observation is unknown,
 * and only a view after it (or none at all) is "not opened". "Not opened" also
 * needs the scan to have been counted since creation (`reportViewCount` not
 * null); older rows can only ever prove "opened".
 *
 * `scripts/ops-snapshot.mjs` mirrors this in SQL for the aggregate, and
 * `test/report-view-verdict.test.ts` pins that the two agree.
 */
export function reportOpenedBeforePublication(
  scan: ReportViewVerdictInput,
): ReportOpenedBeforePublication | null {
  if (scan.source !== "manual" && scan.source !== "auto_discovery") return null;
  if (scan.status !== "complete" || epoch(scan.registryStatusSupersededAt) !== null) return null;
  const firstViewedAt = epoch(scan.reportFirstViewedAt);
  const countedSinceCreation = scan.reportViewCount !== null && scan.reportViewCount !== undefined;
  const publishedAt = epoch(scan.registryPublishedAt);
  if (publishedAt !== null) {
    if (firstViewedAt !== null && firstViewedAt < publishedAt - REPORT_VIEW_CLOCK_SKEW_MS) {
      return "opened";
    }
    if (firstViewedAt !== null && firstViewedAt <= publishedAt + REPORT_VIEW_CLOCK_SKEW_MS) {
      return "unknown";
    }
    return countedSinceCreation ? "not_opened" : "unknown";
  }
  const publishedBy =
    scan.registryVersionStatus === "published" || scan.registryVersionStatus === "deleted"
      ? epoch(scan.registryVersionStatusAt)
      : null;
  if (publishedBy === null) return null;
  if (firstViewedAt !== null && firstViewedAt <= publishedBy + REPORT_VIEW_CLOCK_SKEW_MS) {
    return "unknown";
  }
  return countedSinceCreation ? "not_opened" : "unknown";
}

/**
 * Count one report load. Only completed scans have a report, so loads of a
 * queued, running, or failed review are not views. `firstView` is true for
 * exactly one load of a scan counted since creation: the count only ever goes
 * from 0 to 1 once, and a null count (a scan older than view tracking) stays
 * null, so it never reports a first view it cannot vouch for.
 */
export async function recordScanReportView(
  db: AppDb,
  input: { scanId: string; organizationId: string; surface: ReportViewSurface; now: Date },
): Promise<{ firstView: boolean }> {
  const at = input.now.getTime();
  const [row] = await db
    .update(scans)
    .set({
      reportFirstViewedAt: sql`coalesce(${scans.reportFirstViewedAt}, ${at})`,
      reportFirstViewSurface: sql`coalesce(${scans.reportFirstViewSurface}, ${input.surface})`,
      reportLastViewedAt: input.now,
      reportViewCount: sql`${scans.reportViewCount} + 1`,
    })
    .where(
      and(
        eq(scans.id, input.scanId),
        eq(scans.organizationId, input.organizationId),
        eq(scans.status, "complete"),
      ),
    )
    .returning({ viewCount: scans.reportViewCount });
  return { firstView: row?.viewCount === 1 };
}

/**
 * Stamp npm's publication time on this organization's live staged reviews of
 * the published bytes, from the publication monitor's observation. Keyed on
 * the immutable registry coordinates, never the tarball manifest, so a stage
 * whose package.json names another package cannot borrow that package's
 * timeline; and on npm's SHA-1 for the stage, so a stage rejected on npm, its
 * version then published from other bytes, is not told it was published.
 * First write wins: npm does not republish a version.
 */
export async function recordScanRegistryPublishedAt(
  db: AppDb,
  input: {
    organizationId: string;
    registryUrl: string;
    packageName: string;
    version: string;
    publishedAt: Date;
    /** SHA-1 of the published tarball. */
    sha1: string;
  },
): Promise<void> {
  await db
    .update(scans)
    .set({ registryPublishedAt: input.publishedAt })
    .where(
      and(
        eq(scans.organizationId, input.organizationId),
        sql`rtrim(${scans.registryUrl}, '/') = rtrim(${input.registryUrl}, '/')`,
        eq(scans.registryPackageName, input.packageName),
        eq(scans.registryVersion, input.version),
        eq(scans.stagedDeclaredSha1, input.sha1.toLowerCase()),
        inArray(scans.source, ["manual", "auto_discovery"]),
        isNull(scans.registryStatusSupersededAt),
        isNull(scans.registryPublishedAt),
      ),
    );
}
