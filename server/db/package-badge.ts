import { and, eq, inArray, isNotNull, ne, or, sql, type SQL } from "drizzle-orm";
import {
  PUBLIC_NPM_REGISTRY_URLS,
  REGISTRY_VERIFIED_SCAN_SOURCES,
  publicPackageLookupKey,
  type PublicEcosystem,
} from "../lib/public-feed";
import type { AppDb } from "./client";
import { packageBadgeOptOuts, publicationAlerts, scans } from "./schema";

/**
 * The package a badge request addresses: the ecosystem and the name as the
 * badge route receives it, plus the key both the route and the switch store.
 */
export interface BadgePackage {
  ecosystem: PublicEcosystem;
  packageName: string;
  packageKey: string;
}

export function badgePackage(ecosystem: PublicEcosystem, packageName: string): BadgePackage {
  return { ecosystem, packageName, packageKey: publicPackageLookupKey(ecosystem, packageName) };
}

/**
 * Whether `organizationId` is a **registry-verified publisher** of the
 * package: it has a completed staged review of a stage on the public npm
 * registry that its token could read, under npm's name for the stage, with a
 * manifest that agrees — the same evidence `scanPublicPackageName` accepts as
 * a public identity.
 *
 * That is what earns a say over the badge for everyone. Watching a package,
 * reviewing a published pair, or a workflow gate whose manifest claims the
 * name establishes nothing about the organization's relationship to it, so
 * none of them count. Only npm has a registry-verified source, so no other
 * ecosystem has publishers in this sense.
 */
export function registryVerifiedPublisherSql(organizationId: SQL, target: BadgePackage): SQL {
  if (target.ecosystem !== "npm") return sql`0`;
  return sql`exists (
    select 1 from scans v
    where v.organization_id = ${organizationId}
      and v.source in (${sql.join(
        REGISTRY_VERIFIED_SCAN_SOURCES.map((source) => sql`${source}`),
        sql`, `,
      )})
      and v.status = 'complete'
      and v.registry_package_name = ${target.packageName}
      and v.package_name = v.registry_package_name
      and v.registry_url in (${sql.join(
        PUBLIC_NPM_REGISTRY_URLS.map((url) => sql`${url}`),
        sql`, `,
      )})
  )`;
}

/**
 * Whether the package's public badge is switched off — for everyone, on both
 * routes. One counted opt-out is enough: it is a publisher of the package
 * saying the badge must not speak for it, and letting another organization's
 * review answer instead would make "off" mean nothing. A row only counts while
 * its organization is still a registry-verified publisher, so a row that
 * outlived that evidence cannot hold a badge off.
 */
export async function isPackageBadgeSwitchedOff(db: AppDb, target: BadgePackage): Promise<boolean> {
  if (target.ecosystem !== "npm") return false;
  const rows = await db
    .select({ id: packageBadgeOptOuts.id })
    .from(packageBadgeOptOuts)
    .where(
      and(
        eq(packageBadgeOptOuts.packageKey, target.packageKey),
        registryVerifiedPublisherSql(sql`${packageBadgeOptOuts.organizationId}`, target),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function isRegistryVerifiedPublisher(
  db: AppDb,
  organizationId: string,
  target: BadgePackage,
): Promise<boolean> {
  if (target.ecosystem !== "npm") return false;
  const rows = await db
    .select({ id: scans.id })
    .from(scans)
    .where(
      and(
        eq(scans.organizationId, organizationId),
        inArray(scans.source, [...REGISTRY_VERIFIED_SCAN_SOURCES]),
        eq(scans.status, "complete"),
        eq(scans.registryPackageName, target.packageName),
        sql`${scans.packageName} = ${scans.registryPackageName}`,
        inArray(scans.registryUrl, [...PUBLIC_NPM_REGISTRY_URLS]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export interface PackageBadgeVisibility {
  /** This organization is a registry-verified publisher, so its switch counts. */
  eligible: boolean;
  /** This organization's own switch is off (and counts, because it is eligible). */
  switchedOffByYou: boolean;
  switchedOffAt: Date | null;
  /**
   * Another registry-verified publisher switched the badge off. Only ever true
   * for an eligible organization: telling anyone else would disclose another
   * organization's review and choice to an account with no tie to the package.
   * The other organization is never named.
   */
  switchedOffElsewhere: boolean;
  /** This organization has a review that may answer with no opt-in at all. */
  answersByDefault: boolean;
  /** This organization has deliberately feed-listed a review under the key. */
  listed: boolean;
}

/**
 * The organization's view of one package's badge. The key is a filter, never
 * an authority: another organization's state is read only to answer whether
 * a co-publisher switched the badge off, and only for an eligible reader.
 */
export async function readPackageBadgeVisibility(
  db: AppDb,
  organizationId: string,
  target: BadgePackage,
): Promise<PackageBadgeVisibility> {
  const [eligible, own, elsewhere, defaultOn, listed, postRelease] = await Promise.all([
    isRegistryVerifiedPublisher(db, organizationId, target),
    db
      .select({ createdAt: packageBadgeOptOuts.createdAt })
      .from(packageBadgeOptOuts)
      .where(
        and(
          eq(packageBadgeOptOuts.packageKey, target.packageKey),
          eq(packageBadgeOptOuts.organizationId, organizationId),
        ),
      )
      .limit(1),
    db
      .select({ id: packageBadgeOptOuts.id })
      .from(packageBadgeOptOuts)
      .where(
        and(
          eq(packageBadgeOptOuts.packageKey, target.packageKey),
          ne(packageBadgeOptOuts.organizationId, organizationId),
          registryVerifiedPublisherSql(sql`${packageBadgeOptOuts.organizationId}`, target),
        ),
      )
      .limit(1),
    db
      .select({ id: scans.id })
      .from(scans)
      .where(
        and(
          eq(scans.badgePackageKey, target.packageKey),
          eq(scans.organizationId, organizationId),
          eq(scans.badgePublic, true),
        ),
      )
      .limit(1),
    db
      .select({ id: scans.id })
      .from(scans)
      .where(
        and(
          eq(scans.publicPackageKey, target.packageKey),
          eq(scans.organizationId, organizationId),
          isNotNull(scans.publicFeedListedAt),
        ),
      )
      .limit(1),
    // A decision after release that passed the badge guard answers too, while
    // its review still carries it (`eligible` below re-checks the publisher).
    target.ecosystem === "npm"
      ? db
          .select({ id: publicationAlerts.id })
          .from(publicationAlerts)
          .innerJoin(
            scans,
            and(
              eq(scans.id, publicationAlerts.reviewScanId),
              eq(scans.organizationId, publicationAlerts.organizationId),
            ),
          )
          .where(
            and(
              eq(publicationAlerts.organizationId, organizationId),
              eq(publicationAlerts.packageName, target.packageName),
              eq(publicationAlerts.resolutionBadge, "applied"),
              eq(scans.status, "complete"),
              sql`${scans.decision} = case ${publicationAlerts.resolution} when 'approved_after_release' then 'publish' when 'declined_after_release' then 'no_publish' end`,
            ),
          )
          .limit(1)
      : Promise.resolve([]),
  ]);
  const switchedOffByYou = eligible && own.length > 0;
  return {
    eligible,
    switchedOffByYou,
    switchedOffAt: switchedOffByYou ? (own[0]?.createdAt ?? null) : null,
    switchedOffElsewhere: eligible && elsewhere.length > 0,
    answersByDefault: defaultOn.length > 0 || (eligible && postRelease.length > 0),
    listed: listed.length > 0,
  };
}

/**
 * The dist-tags any review under the key carries, so turning the badge off or
 * on can purge every release line's cached body rather than only `latest`'s.
 * Across organizations, because the switch changes the badge for all of them;
 * the tags never leave the server. Bounded: a purge is best effort and
 * colo-local anyway.
 */
export async function listPackageBadgeTags(db: AppDb, target: BadgePackage): Promise<string[]> {
  const tag = sql<string | null>`json_extract(${scans.summaryJson}, '$.stagedPublish.tag')`;
  const rows = await db
    .selectDistinct({ tag })
    .from(scans)
    .where(
      and(
        or(
          eq(scans.badgePackageKey, target.packageKey),
          eq(scans.publicPackageKey, target.packageKey),
        ),
        isNotNull(tag),
      ),
    )
    .limit(20);
  return rows.flatMap((row) => (typeof row.tag === "string" ? [row.tag] : []));
}

/**
 * Set this organization's own switch. Returns whether the stored state
 * changed, so a caller audits and purges only on a real change. The caller
 * checks eligibility before switching off; switching back on only ever
 * removes this organization's row, so it needs no evidence and can never
 * override another publisher's choice.
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
          eq(packageBadgeOptOuts.packageKey, input.packageKey),
          eq(packageBadgeOptOuts.organizationId, input.organizationId),
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
      target: [packageBadgeOptOuts.packageKey, packageBadgeOptOuts.organizationId],
    })
    .returning({ id: packageBadgeOptOuts.id });
  return inserted.length > 0;
}
