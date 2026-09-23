import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { AppDb } from "./client";
import { packageBadgeOptOuts, scans } from "./schema";

export interface PackageBadgeVisibility {
  enabled: boolean;
  disabledAt: Date | null;
  /** This organization has a review that may answer with no opt-in at all. */
  answersByDefault: boolean;
  /** This organization has deliberately feed-listed a review under the key. */
  listed: boolean;
}

/**
 * The organization's badge state for one package key. Organization-scoped
 * throughout: the key is a filter, never an authority, so asking about a
 * package this organization never reviewed reads as enabled with nothing that
 * answers — the same thing the badge itself would say.
 */
export async function readPackageBadgeVisibility(
  db: AppDb,
  input: { organizationId: string; packageKey: string },
): Promise<PackageBadgeVisibility> {
  const [optOut, defaultOn, listed] = await Promise.all([
    db
      .select({ createdAt: packageBadgeOptOuts.createdAt })
      .from(packageBadgeOptOuts)
      .where(
        and(
          eq(packageBadgeOptOuts.organizationId, input.organizationId),
          eq(packageBadgeOptOuts.packageKey, input.packageKey),
        ),
      )
      .limit(1),
    db
      .select({ id: scans.id })
      .from(scans)
      .where(
        and(
          eq(scans.badgePackageKey, input.packageKey),
          eq(scans.organizationId, input.organizationId),
          eq(scans.badgePublic, true),
        ),
      )
      .limit(1),
    db
      .select({ id: scans.id })
      .from(scans)
      .where(
        and(
          eq(scans.publicPackageKey, input.packageKey),
          eq(scans.organizationId, input.organizationId),
          isNotNull(scans.publicFeedListedAt),
        ),
      )
      .limit(1),
  ]);
  return {
    enabled: optOut.length === 0,
    disabledAt: optOut[0]?.createdAt ?? null,
    answersByDefault: defaultOn.length > 0,
    listed: listed.length > 0,
  };
}

/**
 * The dist-tags this organization's reviews under the key carry, so turning
 * the badge off or on can purge every release line's cached body rather than
 * only `latest`'s. Bounded: a purge is best effort and colo-local anyway.
 */
export async function listPackageBadgeTags(
  db: AppDb,
  input: { organizationId: string; packageKey: string },
): Promise<string[]> {
  const tag = sql<string | null>`json_extract(${scans.summaryJson}, '$.stagedPublish.tag')`;
  const rows = await db
    .selectDistinct({ tag })
    .from(scans)
    .where(
      and(
        eq(scans.organizationId, input.organizationId),
        sql`(${scans.badgePackageKey} = ${input.packageKey} or ${scans.publicPackageKey} = ${input.packageKey})`,
        isNotNull(tag),
      ),
    )
    .limit(20);
  return rows.flatMap((row) => (typeof row.tag === "string" ? [row.tag] : []));
}

/**
 * Turn this organization's public badge for one package on or off. Returns
 * whether the stored state changed, so a caller audits and purges only on a
 * real change.
 *
 * Touches nothing but the opt-out: badge consent and publication-watch
 * enrollment are independent, so this never starts, stops, or suppresses a
 * watch.
 */
export async function setPackageBadgeEnabled(
  db: AppDb,
  input: { organizationId: string; packageKey: string; enabled: boolean; actorUserId: string },
): Promise<boolean> {
  if (input.enabled) {
    const deleted = await db
      .delete(packageBadgeOptOuts)
      .where(
        and(
          eq(packageBadgeOptOuts.organizationId, input.organizationId),
          eq(packageBadgeOptOuts.packageKey, input.packageKey),
        ),
      )
      .returning({ id: packageBadgeOptOuts.id });
    return deleted.length > 0;
  }
  const inserted = await db
    .insert(packageBadgeOptOuts)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      packageKey: input.packageKey,
      createdAt: new Date(),
      createdByUserId: input.actorUserId,
    })
    .onConflictDoNothing({
      target: [packageBadgeOptOuts.organizationId, packageBadgeOptOuts.packageKey],
    })
    .returning({ id: packageBadgeOptOuts.id });
  return inserted.length > 0;
}
