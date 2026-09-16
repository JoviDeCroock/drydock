import { inArray, isNull, or, sql } from "drizzle-orm";
import { NPM_RELEASE_OUTCOME_FAILURE_CODES } from "../lib/ecosystems/npm/version-status";
import { scans } from "./schema";

// Query fragments the dashboard list and the package-release view share, so
// both answer "published without review" with the same predicate.

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
