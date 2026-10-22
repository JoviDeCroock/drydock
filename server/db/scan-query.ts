import { inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  NPM_RELEASE_OUTCOME_FAILURE_CODES,
  SETTLED_NPM_VERSION_STATUSES,
} from "../lib/ecosystems/npm/version-status";
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
 * Whether a review's release is public yet, so an anonymous surface (share
 * link, threat feed, listed badge) may disclose the review. A staged security
 * fix is embargoed information until it ships, and its review is the patch
 * itself. Fails closed: an unknown status or an unclassified source is
 * unreleased.
 *
 * - npm staged reviews: npm reports the version published (or published and
 *   later deleted).
 * - Published-pair reviews: the bytes were read from a public registry.
 * - PyPI and VS Code gate reviews: the gate approved the protected publish job.
 *   Nothing later is observable; those registries hold no private stage.
 * - npm gate reviews: approval is not enough, because gated staging runs
 *   `npm stage publish`, which leaves the bytes in a private npm stage. They
 *   need npm evidence that these bytes shipped: this organization's staged
 *   review bound to this gate review by matching digests and published by npm,
 *   or its publication monitor matching the published tarball to this review.
 *   A match to another approval of the same version is not enough: two gate
 *   reviews can carry different bytes under one version, and only one ships.
 *   A gate review with an unknown ecosystem takes this stricter branch.
 *
 * Correlated on the outer `scans` row, so callers must select from `scans`
 * unaliased. Subquery tables are aliased and named by hand.
 */
export function publicDisclosureAllowedCondition() {
  const gateApproved = sql`exists (
    select 1 from github_workflow_gates disclosure_gate
    where disclosure_gate.id = ${scans.gateId}
      and disclosure_gate.organization_id = ${scans.organizationId}
      and disclosure_gate.decision = 'approved'
  )`;
  const npmShippedGateBytes = sql`(exists (
    select 1 from scans disclosure_stage
    where disclosure_stage.organization_id = ${scans.organizationId}
      and disclosure_stage.registry_package_name = ${scans.packageName}
      and disclosure_stage.registry_version = ${scans.stagedVersion}
      and disclosure_stage.source in ('manual', 'auto_discovery')
      and disclosure_stage.registry_status_superseded_at is null
      and disclosure_stage.registry_version_status in ('published', 'deleted')
      and json_extract(disclosure_stage.summary_json, '$.gateContinuity.status') = 'matched'
      and json_extract(disclosure_stage.summary_json, '$.gateContinuity.review.scanId') = ${scans.id}
  ) or exists (
    select 1 from publication_observations disclosure_observation
    join publication_watches disclosure_watch on disclosure_watch.id = disclosure_observation.watch_id
    where disclosure_watch.organization_id = ${scans.organizationId}
      and disclosure_watch.package_name = ${scans.packageName}
      and disclosure_observation.organization_id = ${scans.organizationId}
      and disclosure_observation.version = ${scans.stagedVersion}
      and disclosure_observation.status = 'approved_match'
      and disclosure_observation.scan_id = ${scans.id}
  ))`;
  return sql`(case
    when ${scans.source} in ('manual', 'auto_discovery') then coalesce(${publishedReleaseOutcomeCondition()}, 0)
    when ${scans.source} = 'published' then 1
    when ${scans.source} = 'workflow_gate' then ${gateApproved} and (
      coalesce(${scanEcosystemSql} in ('pypi', 'vscode'), 0) or ${npmShippedGateBytes}
    )
    else 0
  end) = 1`;
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

/**
 * The default **Undecided** work queue: reviews a decision can still act on.
 * Superseded reviews are immutable history, not pending work: the decision
 * route refuses them, so leaving them in the queue creates rows the reviewer
 * can never resolve. Settled npm releases are no longer pending; completed
 * reviews remain decidable while failed reviews are read-only. Both stay
 * visible under the `all` filter. Batch approval selects from this same set.
 */
export function undecidedQueueConditions() {
  const settledFailureCodes = Object.values(NPM_RELEASE_OUTCOME_FAILURE_CODES);
  return [
    isNull(scans.decision),
    isNull(scans.registryStatusSupersededAt),
    or(
      isNull(scans.registryVersionStatus),
      notInArray(scans.registryVersionStatus, [...SETTLED_NPM_VERSION_STATUSES]),
    )!,
    or(isNull(registryFailureCodeSql), notInArray(registryFailureCodeSql, settledFailureCodes))!,
  ];
}
