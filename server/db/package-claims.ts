import { and, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { AppDb } from "./client";
import {
  npmPackageClaims,
  organizations,
  publicationWatches,
  publicationWatchCandidates,
  scanEvents,
  scans,
} from "./schema";

export class PackageClaimConflictError extends Error {
  constructor() {
    super(
      "This package is unavailable for this organization. Contact support to resolve ownership.",
    );
    this.name = "PackageClaimConflictError";
  }
}

/** A claim authorizes staged admission for its org, never access to another org's scan. */
export function npmPackageClaimMatches(
  registryUrl: string | SQLWrapper,
  packageName: string | SQLWrapper,
  organizationId: string | SQLWrapper,
) {
  return sql`exists (select 1 from ${npmPackageClaims}
    where ${npmPackageClaims.registryUrl} = ${registryUrl}
      and ${npmPackageClaims.ecosystem} = 'npm'
      and ${npmPackageClaims.packageName} = ${packageName}
      and ${npmPackageClaims.organizationId} = ${organizationId})`;
}

/** Must be batched with the scan insert conditioned on the resulting owner. */
export function insertNpmPackageClaim(
  db: AppDb,
  input: {
    registryUrl: string;
    packageName: string;
    organizationId: string;
    stageId: string;
    now: Date;
  },
) {
  // Pre-claim history is ambiguous: even a single org may have connected the
  // wrong token. Only an audited backfill may establish that historical owner.
  // Legacy rows without registry coordinates reserve the name conservatively.
  return db
    .insert(npmPackageClaims)
    .select(sql`select ${input.registryUrl}, 'npm', ${input.packageName},
      ${input.organizationId}, ${input.stageId}, ${input.now.getTime()},
      case when exists(select 1 from organizations o where o.id = ${input.organizationId}
        and o.id = 'personal:' || o.owner_user_id) then null else ${input.now.getTime()} end
      where not exists (select 1 from ${scans}
        where ${scans.source} in ('manual', 'auto_discovery')
          and coalesce(${scans.registryPackageName}, ${scans.packageName}) = ${input.packageName}
          and (rtrim(${scans.registryUrl}, '/') = ${input.registryUrl}
            or nullif(rtrim(${scans.registryUrl}, '/'), '') is null))
        and not exists (select 1 from ${npmPackageClaims}
          where ${npmPackageClaims.registryUrl} = '*'
            and ${npmPackageClaims.ecosystem} = 'npm'
            and ${npmPackageClaims.packageName} = ${input.packageName})`)
    .onConflictDoNothing();
}

/** Preserve pre-claim evidence atomically before its last scan can disappear. */
export function reserveDeletedNpmPackages(db: AppDb, deletionCondition: SQL | undefined) {
  // '*' is an unassigned reservation for a historical scan whose registry was
  // never recorded. It blocks automatic claims in every registry; it can never
  // authorize a scan, badge, or watch. An explicit audited exact claim can.
  return db
    .insert(npmPackageClaims)
    .select(sql`select coalesce(nullif(rtrim(${scans.registryUrl}, '/'), ''), '*'),
      'npm', coalesce(${scans.registryPackageName}, ${scans.packageName}),
      null, ${scans.stageId}, ${Date.now()}, null
      from ${scans}
      where ${deletionCondition ?? sql`1 = 0`}
        and ${scans.source} in ('manual', 'auto_discovery')
        and coalesce(${scans.registryPackageName}, ${scans.packageName}) is not null
      order by ${scans.createdAt}, ${scans.id}`)
    .onConflictDoNothing();
}

/** A personal reservation permits review, but management needs an explicit choice. */
export function npmPackageManagementAllowed(
  registryUrl: string | SQLWrapper,
  packageName: string | SQLWrapper,
  organizationId: string | SQLWrapper,
) {
  return sql`exists (select 1 from npm_package_claims managed
    join organizations management_org on management_org.id = managed.organization_id
    where managed.registry_url = ${registryUrl} and managed.ecosystem = 'npm'
      and managed.package_name = ${packageName} and managed.organization_id = ${organizationId}
      and (management_org.id != 'personal:' || management_org.owner_user_id
        or managed.management_confirmed_at is not null))`;
}

function personalOwner(organizationId: string, userId: string) {
  return sql`exists(select 1 from organizations source_org
    join organization_members source_member on source_member.organization_id = source_org.id
    where source_org.id = ${organizationId} and source_org.id = 'personal:' || ${userId}
      and source_org.owner_user_id = ${userId} and source_member.user_id = ${userId}
      and source_member.role = 'owner')`;
}

function sharedManager(organizationId: string | SQLWrapper, userId: string) {
  return sql`exists(select 1 from organizations destination_org
    join organization_members destination_member on destination_member.organization_id = destination_org.id
    where destination_org.id = ${organizationId}
      and destination_org.id != 'personal:' || destination_org.owner_user_id
      and destination_member.user_id = ${userId} and destination_member.role in ('owner', 'admin'))`;
}

export async function readNpmPackageManagement(
  db: AppDb,
  input: { registryUrl: string; packageName: string; organizationId: string; userId: string },
) {
  const [claim] = await db
    .select({
      personal:
        sql<boolean>`${organizations.id} = 'personal:' || ${organizations.ownerUserId}`.mapWith(
          Boolean,
        ),
      confirmed: npmPackageClaims.managementConfirmedAt,
      canManage: personalOwner(input.organizationId, input.userId).mapWith(Boolean),
    })
    .from(npmPackageClaims)
    .innerJoin(organizations, eq(organizations.id, npmPackageClaims.organizationId))
    .where(
      and(
        eq(npmPackageClaims.registryUrl, input.registryUrl),
        eq(npmPackageClaims.ecosystem, "npm"),
        eq(npmPackageClaims.packageName, input.packageName),
        eq(npmPackageClaims.organizationId, input.organizationId),
      ),
    )
    .limit(1);
  const destinations = await db.all<{
    id: string;
    name: string;
  }>(sql`select id, name from organizations
    where ${personalOwner(input.organizationId, input.userId)}
      and ${sharedManager(sql`organizations.id`, input.userId)} order by name, id`);
  return {
    claim: claim
      ? {
          kind: claim.personal ? ("personal" as const) : ("organization" as const),
          managementConfirmed: !claim.personal || claim.confirmed !== null,
          canManage: claim.canManage,
        }
      : null,
    destinations,
  };
}

export class PackageManagementAuthorizationError extends Error {}
export class PackageManagementConflictError extends Error {}

export async function manageNpmPackageClaim(
  db: AppDb,
  input: {
    registryUrl: string;
    packageName: string;
    organizationId: string;
    userId: string;
    targetOrganizationId: string;
    /** Server-selected registry; never read from the request body. */
    monitoringRegistryUrl?: string;
  },
) {
  const confirming = input.organizationId === input.targetOrganizationId;
  const authorized = sql`${personalOwner(input.organizationId, input.userId)} and
    ${confirming ? sql`1` : sharedManager(input.targetOrganizationId, input.userId)}`;
  const [permission] = await db.all<{ allowed: number }>(sql`select ${authorized} as allowed`);
  if (!permission?.allowed) throw new PackageManagementAuthorizationError();
  const now = new Date();
  const receiptId = crypto.randomUUID();
  const monitor =
    input.registryUrl === (input.monitoringRegistryUrl ?? "https://registry.npmjs.org");
  const capacity = monitor
    ? sql`(exists(select 1 from publication_watches
      where organization_id = ${input.targetOrganizationId} and package_name = ${input.packageName})
      or (select count(*) from publication_watches where organization_id = ${input.targetOrganizationId}) < 20)`
    : sql`1`;
  const successful = sql`exists(select 1 from scan_events where id = ${receiptId})`;
  const eventType = confirming
    ? "npm_package.management_confirmed"
    : "npm_package.management_transferred";
  // The receipt is written immediately after the guarded UPDATE. Later batch
  // statements depend on that receipt, never on a stale ownership pre-read or
  // a timestamp that a concurrent confirmation could also have written.
  await db.batch([
    db
      .update(npmPackageClaims)
      .set({
        organizationId: input.targetOrganizationId,
        managementConfirmedAt: now,
      })
      .where(
        and(
          eq(npmPackageClaims.registryUrl, input.registryUrl),
          eq(npmPackageClaims.ecosystem, "npm"),
          eq(npmPackageClaims.packageName, input.packageName),
          eq(npmPackageClaims.organizationId, input.organizationId),
          authorized,
          capacity,
        ),
      ),
    db.insert(scanEvents).select(sql`select ${receiptId}, ${input.organizationId},
      ${input.userId}, null, ${eventType}, ${JSON.stringify({ packageName: input.packageName })},
      ${now.getTime()} where changes() > 0`),
    ...(!confirming
      ? [
          db.insert(scanEvents).select(sql`select ${crypto.randomUUID()},
      ${input.targetOrganizationId}, ${input.userId}, null, 'npm_package.management_received',
      ${JSON.stringify({ packageName: input.packageName })}, ${now.getTime()} where ${successful}`),
        ]
      : []),
    ...(monitor
      ? [
          db
            .insert(publicationWatches)
            .select(sql`select ${crypto.randomUUID()}, ${input.targetOrganizationId},
        ${input.packageName}, 'manual', ${now.getTime()}, null, null, null, null, null, null
        where ${successful}`)
            .onConflictDoNothing(),
          db
            .insert(publicationWatchCandidates)
            .select(sql`select ${crypto.randomUUID()}, ${input.targetOrganizationId},
        ${input.packageName}, 'manual', ${now.getTime()}, null where ${successful}`)
            .onConflictDoUpdate({
              target: [
                publicationWatchCandidates.organizationId,
                publicationWatchCandidates.packageName,
              ],
              set: { source: "manual", stoppedAt: null },
            }),
        ]
      : []),
  ]);
  const [receipt] = await db
    .select({ id: scanEvents.id })
    .from(scanEvents)
    .where(eq(scanEvents.id, receiptId));
  if (!receipt) throw new PackageManagementConflictError();
}
