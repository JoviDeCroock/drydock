import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { npmPackageClaimMatches, npmPackageManagementAllowed } from "./package-claims";
import type { AppDb } from "./client";
import {
  npmPackageClaims,
  publicationAlerts,
  publicationObservations,
  publicationWatchCandidates,
  publicationWatches,
} from "./schema";

export type PublicationWatch = typeof publicationWatches.$inferSelect;
/** Watches per organization; enrollment SQL enforces the same bound. */
const PUBLICATION_WATCH_LIMIT = 20;
export type PublicationObservation = typeof publicationObservations.$inferSelect;
export class PublicationWatchLimitError extends Error {}
export class PublicationWatchOwnershipError extends Error {}
export class PublicationWatchManagementError extends Error {}

function publicationWatchManagementPending(
  registryUrl: string,
  packageName: string | SQLWrapper,
  organizationId: string | SQLWrapper,
) {
  return sql<boolean>`(${npmPackageClaimMatches(registryUrl, packageName, organizationId)}
    and not ${npmPackageManagementAllowed(registryUrl, packageName, organizationId)})`.mapWith(
    Boolean,
  );
}

export function publicationWatchBlocked(
  registryUrl: string,
  packageName: string | SQLWrapper,
  organizationId: string | SQLWrapper,
) {
  return sql<boolean>`(${publicationWatchOwnershipConflict(registryUrl, packageName, organizationId)}
    or ${publicationWatchManagementPending(registryUrl, packageName, organizationId)})`.mapWith(
    Boolean,
  );
}

export async function getPublicationManagementPending(
  db: AppDb,
  organizationId: string,
  packageName: string,
  registryUrl = PUBLIC_NPM,
): Promise<boolean> {
  const [result] = await db.all<{ pending: number }>(
    sql`select ${publicationWatchManagementPending(registryUrl, packageName, organizationId)} as pending`,
  );
  return Boolean(result?.pending);
}

export async function getPublicationWatchBlocked(
  db: AppDb,
  organizationId: string,
  packageName: string,
  registryUrl = PUBLIC_NPM,
): Promise<boolean> {
  const [result] = await db.all<{ blocked: number }>(
    sql`select ${publicationWatchBlocked(registryUrl, packageName, organizationId)} as blocked`,
  );
  return Boolean(result?.blocked);
}

const PUBLIC_NPM = "https://registry.npmjs.org";

export function publicationWatchOwnershipConflict(
  registryUrl: string,
  packageName: string | SQLWrapper,
  organizationId: string | SQLWrapper,
) {
  return sql<boolean>`(exists (select 1 from ${npmPackageClaims} claim
    where claim.registry_url = ${registryUrl} and claim.ecosystem = 'npm'
      and claim.package_name = ${packageName}
      and (claim.organization_id is null or claim.organization_id != ${organizationId}))
    or (exists (select 1 from ${npmPackageClaims} reserved
      where reserved.registry_url = '*' and reserved.ecosystem = 'npm'
        and reserved.package_name = ${packageName})
      and not ${npmPackageClaimMatches(registryUrl, packageName, organizationId)}))`.mapWith(
    Boolean,
  );
}

export async function getPublicationOwnershipConflict(
  db: AppDb,
  organizationId: string,
  packageName: string,
  registryUrl = PUBLIC_NPM,
): Promise<boolean> {
  const [result] = await db.all<{ conflict: number }>(
    sql`select ${publicationWatchOwnershipConflict(registryUrl, packageName, organizationId)} as conflict`,
  );
  return Boolean(result?.conflict);
}

const unresolvedAlertCount = sql<number>`(select count(*) from publication_alerts a where a.organization_id = publication_watches.organization_id and a.package_name = publication_watches.package_name and a.acknowledged_at is null and exists(select 1 from publication_observations o where o.watch_id = publication_watches.id and o.organization_id = a.organization_id and o.version = a.version))`;

/**
 * How long a problem must last before it counts as a coverage gap: shorter
 * outages resolve on their own and are shown only as the watch's last problem.
 */
const COVERAGE_GAP_AFTER_MS = 60 * 60 * 1000;

/**
 * Why a published release can stay unverified: its bytes could not be hashed
 * or located, so at best npm's own declared shasum was compared. Those outlast
 * a transient failure once they persist past `COVERAGE_GAP_AFTER_MS`, and the
 * organization is told once.
 */
const RELEASE_COVERAGE_GAP_REASONS = [
  "artifact_too_large",
  "artifact_timeout",
  "artifact_unavailable",
  "artifact_identity_invalid",
] as const;

function releaseCoverageGap(now: Date) {
  return and(
    eq(publicationObservations.status, "unknown"),
    inArray(publicationObservations.reason, [...RELEASE_COVERAGE_GAP_REASONS]),
    lte(publicationObservations.firstSeenAt, new Date(now.getTime() - COVERAGE_GAP_AFTER_MS)),
  );
}

// Correlated form of `releaseCoverageGap` for the watch listings.
const unverifiedReleaseCount = () =>
  sql<number>`(select count(*) from publication_observations o where o.watch_id = publication_watches.id and o.organization_id = publication_watches.organization_id and o.status = 'unknown' and o.reason in ${sql.raw(`(${RELEASE_COVERAGE_GAP_REASONS.map((reason) => `'${reason}'`).join(", ")})`)} and o.first_seen_at <= ${Date.now() - COVERAGE_GAP_AFTER_MS})`;

const watchColumns = (registryUrl: string) => ({
  ...getTableColumns(publicationWatches),
  unresolvedAlertCount,
  unverifiedReleaseCount: unverifiedReleaseCount(),
  managementPending: publicationWatchManagementPending(
    registryUrl,
    sql`publication_watches.package_name`,
    sql`publication_watches.organization_id`,
  ),
  ownershipConflict: publicationWatchOwnershipConflict(
    registryUrl,
    sql`publication_watches.package_name`,
    sql`publication_watches.organization_id`,
  ),
});

export function listPublicationWatches(
  db: AppDb,
  organizationId: string,
  registryUrl = PUBLIC_NPM,
) {
  return db
    .select(watchColumns(registryUrl))
    .from(publicationWatches)
    .where(eq(publicationWatches.organizationId, organizationId))
    .orderBy(asc(publicationWatches.createdAt));
}
export async function getPublicationWatchByPackage(
  db: AppDb,
  organizationId: string,
  packageName: string,
  registryUrl = PUBLIC_NPM,
) {
  const [watch] = await db
    .select(watchColumns(registryUrl))
    .from(publicationWatches)
    .where(
      and(
        eq(publicationWatches.organizationId, organizationId),
        eq(publicationWatches.packageName, packageName),
      ),
    )
    .limit(1);
  return watch ?? null;
}

/**
 * Why a package is or is not watched, from the organization's own enrollment
 * evidence. `pending` enrolls at the next reconciliation; `deferred` waits for
 * a free slot under the watch limit; `suggested` is a workflow-gate package
 * whose public visibility nothing has confirmed; `stopped` is a persisted
 * opt-out; `not_enrolled` means no public release was seen here at all.
 */
export type PublicationEnrollment =
  | { state: "watched" }
  | { state: "stopped"; stoppedAt: Date }
  | { state: "suggested" }
  | { state: "pending" }
  | { state: "deferred" }
  | { state: "not_enrolled" };

export async function getPublicationEnrollment(
  db: AppDb,
  organizationId: string,
  packageName: string,
): Promise<PublicationEnrollment> {
  const [candidate] = await db
    .select({
      source: publicationWatchCandidates.source,
      stoppedAt: publicationWatchCandidates.stoppedAt,
    })
    .from(publicationWatchCandidates)
    .where(
      and(
        eq(publicationWatchCandidates.organizationId, organizationId),
        eq(publicationWatchCandidates.packageName, packageName),
      ),
    )
    .limit(1);
  if (!candidate) return { state: "not_enrolled" };
  if (candidate.stoppedAt) return { state: "stopped", stoppedAt: candidate.stoppedAt };
  if (candidate.source === "workflow_gate") return { state: "suggested" };
  const [{ watches }] = await db
    .select({ watches: sql<number>`count(*)` })
    .from(publicationWatches)
    .where(eq(publicationWatches.organizationId, organizationId));
  return { state: watches >= PUBLICATION_WATCH_LIMIT ? "deferred" : "pending" };
}

export async function getPublicationWatch(
  db: AppDb,
  organizationId: string,
  id: string,
  registryUrl = PUBLIC_NPM,
) {
  const [watch] = await db
    .select(watchColumns(registryUrl))
    .from(publicationWatches)
    .where(
      and(eq(publicationWatches.organizationId, organizationId), eq(publicationWatches.id, id)),
    )
    .limit(1);
  return watch ?? null;
}
/** `packageName` is validated against the registry's name grammar by the caller. */
export async function createPublicationWatch(
  db: AppDb,
  organizationId: string,
  packageName: string,
  registryUrl = PUBLIC_NPM,
) {
  const id = crypto.randomUUID();
  const now = new Date();
  // Clear stop intent only when the cap allows a watch (or one already exists).
  await db.batch([
    db
      .insert(publicationWatches)
      .select(
        sql`select ${id}, ${organizationId}, ${packageName}, 'manual', ${now.getTime()}, null, null, null, null, null, null where (select count(*) from publication_watches where organization_id = ${organizationId}) < 20 and not ${publicationWatchBlocked(registryUrl, packageName, organizationId)}`,
      )
      .onConflictDoNothing({
        target: [publicationWatches.organizationId, publicationWatches.packageName],
      }),
    db
      .insert(publicationWatchCandidates)
      .select(
        sql`select ${crypto.randomUUID()}, ${organizationId}, ${packageName}, 'manual', ${now.getTime()}, null where exists(select 1 from publication_watches where organization_id = ${organizationId} and package_name = ${packageName}) and not ${publicationWatchBlocked(registryUrl, packageName, organizationId)}`,
      )
      .onConflictDoUpdate({
        target: [publicationWatchCandidates.organizationId, publicationWatchCandidates.packageName],
        set: { stoppedAt: null },
      }),
  ]);
  const [watch] = await db
    .select(watchColumns(registryUrl))
    .from(publicationWatches)
    .where(
      and(
        eq(publicationWatches.organizationId, organizationId),
        eq(publicationWatches.packageName, packageName),
      ),
    )
    .limit(1);
  if (
    watch?.managementPending ||
    (!watch &&
      (await getPublicationManagementPending(db, organizationId, packageName, registryUrl)))
  )
    throw new PublicationWatchManagementError(
      "Choose an organization for this package before enabling monitoring.",
    );
  if (
    watch?.ownershipConflict ||
    (!watch &&
      (await getPublicationOwnershipConflict(db, organizationId, packageName, registryUrl)))
  )
    throw new PublicationWatchOwnershipError(
      "This package is already assigned to another organization.",
    );
  if (!watch)
    throw new PublicationWatchLimitError("At most 20 packages can be monitored per organization");
  return watch;
}
export async function deletePublicationWatch(db: AppDb, organizationId: string, id: string) {
  const now = new Date();
  // Suppression and deletion commit together; a stale discovery cannot recreate
  // a removed watch, and explicit re-enrollment gets a fresh identity.
  const [, rows] = await db.batch([
    db
      .insert(publicationWatchCandidates)
      .select(
        sql`select ${crypto.randomUUID()}, organization_id, package_name, 'manual', ${now.getTime()}, ${now.getTime()} from publication_watches where organization_id = ${organizationId} and id = ${id}`,
      )
      .onConflictDoUpdate({
        target: [publicationWatchCandidates.organizationId, publicationWatchCandidates.packageName],
        set: { stoppedAt: now },
      }),
    db
      .delete(publicationWatches)
      .where(
        and(eq(publicationWatches.organizationId, organizationId), eq(publicationWatches.id, id)),
      )
      .returning({ id: publicationWatches.id }),
  ]);
  return rows.length > 0;
}
export function listPublicationObservations(db: AppDb, organizationId: string, watchId: string) {
  return db
    .select({
      ...getTableColumns(publicationObservations),
      acknowledgedAt: publicationAlerts.acknowledgedAt,
      coverageGap: sql<boolean>`coalesce(${releaseCoverageGap(new Date())}, 0)`.mapWith(Boolean),
    })
    .from(publicationObservations)
    .innerJoin(publicationWatches, eq(publicationWatches.id, publicationObservations.watchId))
    .leftJoin(
      publicationAlerts,
      and(
        eq(publicationAlerts.organizationId, publicationObservations.organizationId),
        eq(publicationAlerts.packageName, publicationWatches.packageName),
        eq(publicationAlerts.version, publicationObservations.version),
      ),
    )
    .where(
      and(
        eq(publicationObservations.organizationId, organizationId),
        eq(publicationObservations.watchId, watchId),
      ),
    )
    .orderBy(
      sql`case when ${publicationAlerts.id} is not null and ${publicationAlerts.acknowledgedAt} is null then 0 else 1 end`,
      desc(publicationObservations.firstSeenAt),
      desc(publicationObservations.id),
    )
    .limit(100);
}

type WatchKey = { id: string; organizationId: string };

function watchKey(watch: WatchKey) {
  return and(
    eq(publicationWatches.id, watch.id),
    eq(publicationWatches.organizationId, watch.organizationId),
  );
}

/**
 * Record the package-wide reason no release can be verified right now, keeping
 * when it began while it persists, or clear it after a check got past it.
 */
export async function recordWatchCoverageGap(
  db: AppDb,
  watch: WatchKey,
  reason: string | null,
  now: Date,
  options: { weak?: boolean } = {},
) {
  if (reason === null) {
    await db
      .update(publicationWatches)
      .set({ coverageGap: null, coverageGapSince: null, coverageGapNotifiedAt: null })
      .where(and(watchKey(watch), sql`${publicationWatches.coverageGap} is not null`));
    return;
  }
  // A weak reason (a failed read) never replaces a recorded gap or restarts it.
  await db
    .update(publicationWatches)
    .set({ coverageGap: reason, coverageGapSince: now, coverageGapNotifiedAt: null })
    .where(
      and(
        watchKey(watch),
        options.weak
          ? isNull(publicationWatches.coverageGap)
          : or(isNull(publicationWatches.coverageGap), ne(publicationWatches.coverageGap, reason)),
      ),
    );
}

/**
 * Take the one notice for the watch's package-wide gap once it has lasted past
 * `COVERAGE_GAP_AFTER_MS`. Returns the gap's reason when this caller must send it.
 */
export async function claimWatchCoverageNotice(db: AppDb, watch: WatchKey, now: Date) {
  const [claimed] = await db
    .update(publicationWatches)
    .set({ coverageGapNotifiedAt: now })
    .where(
      and(
        watchKey(watch),
        isNull(publicationWatches.coverageGapNotifiedAt),
        lte(publicationWatches.coverageGapSince, new Date(now.getTime() - COVERAGE_GAP_AFTER_MS)),
      ),
    )
    .returning({ reason: publicationWatches.coverageGap });
  return claimed?.reason ?? null;
}

/** Give back a notice claim whose delivery failed, so a later check sends it. */
export async function releaseWatchCoverageNotice(db: AppDb, watch: WatchKey, claimedAt: Date) {
  await db
    .update(publicationWatches)
    .set({ coverageGapNotifiedAt: null })
    .where(and(watchKey(watch), eq(publicationWatches.coverageGapNotifiedAt, claimedAt)));
}

/** Releases of this watch that are coverage gaps nobody has been told about, oldest first. */
export function listUnnotifiedReleaseCoverageGaps(db: AppDb, watch: WatchKey, now: Date) {
  return db
    .select({
      id: publicationObservations.id,
      version: publicationObservations.version,
      reason: publicationObservations.reason,
    })
    .from(publicationObservations)
    .where(
      and(
        eq(publicationObservations.watchId, watch.id),
        eq(publicationObservations.organizationId, watch.organizationId),
        isNull(publicationObservations.coverageNotifiedAt),
        releaseCoverageGap(now),
      ),
    )
    .orderBy(asc(publicationObservations.firstSeenAt), asc(publicationObservations.id))
    .limit(5);
}

/** Take the one notice for a release coverage gap; false when another check holds it. */
export async function claimReleaseCoverageNotice(
  db: AppDb,
  input: { organizationId: string; observationId: string },
  now: Date,
) {
  const claimed = await db
    .update(publicationObservations)
    .set({ coverageNotifiedAt: now })
    .where(
      and(
        eq(publicationObservations.id, input.observationId),
        eq(publicationObservations.organizationId, input.organizationId),
        isNull(publicationObservations.coverageNotifiedAt),
        releaseCoverageGap(now),
      ),
    )
    .returning({ id: publicationObservations.id });
  return claimed.length > 0;
}

export async function releaseReleaseCoverageNotice(
  db: AppDb,
  input: { organizationId: string; observationId: string },
  claimedAt: Date,
) {
  await db
    .update(publicationObservations)
    .set({ coverageNotifiedAt: null })
    .where(
      and(
        eq(publicationObservations.id, input.observationId),
        eq(publicationObservations.organizationId, input.organizationId),
        eq(publicationObservations.coverageNotifiedAt, claimedAt),
      ),
    );
}
