import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { AppDb } from "./client";
import { npmPackageClaims, scans } from "./schema";

export class PackageClaimConflictError extends Error {
  constructor() {
    super(
      "This package is unavailable for this organization. Contact support to resolve ownership.",
    );
    this.name = "PackageClaimConflictError";
  }
}

/** The claim is authority for monitoring and badges, never access to another org's scan. */
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
      ${input.organizationId}, ${input.stageId}, ${input.now.getTime()}
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
      null, ${scans.stageId}, ${Date.now()}
      from ${scans}
      where ${deletionCondition ?? sql`1 = 0`}
        and ${scans.source} in ('manual', 'auto_discovery')
        and coalesce(${scans.registryPackageName}, ${scans.packageName}) is not null
      order by ${scans.createdAt}, ${scans.id}`)
    .onConflictDoNothing();
}
