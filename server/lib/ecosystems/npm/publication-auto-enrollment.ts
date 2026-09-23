import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { npmPackageClaimMatches } from "../../../db/package-claims";
import { publicationWatchOwnershipConflict } from "../../../db/publication-watches";
import type { AppDb } from "../../../db/client";
import { publicationWatchCandidates, publicationWatches } from "../../../db/schema";
import { emitOperationalEvent } from "../../platform/observability";
import type { StagedReleaseVisibility } from "../types";
import { isLoopbackHostname, registryProtocolAllowed } from "./connection";
import { npmPublicationRegistry } from "./publication-registry";
import { isValidNpmPackageName } from "./registry";

const PUBLIC_NPM = "https://registry.npmjs.org";
const HISTORY_BATCH = 50;

type CandidateSource = "staged_discovery" | "published_history" | "workflow_gate";
export interface PublicationAutoEnrollment {
  deferred: number;
  suggestions: { packageName: string }[];
}

function validMonitoringRegistry(registryUrl: string): boolean {
  try {
    const url = new URL(registryUrl);
    return (
      registryUrl === PUBLIC_NPM ||
      (url.origin === registryUrl &&
        isLoopbackHostname(url.hostname) &&
        registryProtocolAllowed(url, { allowInsecureLocalhost: true }))
    );
  } catch {
    return false;
  }
}

// Apply the registry name grammar before taking a history batch: malformed
// historical rows must not occupy the same oldest slots forever.
function validHistoricalName(name: SQL): SQL {
  return sql`length(${name}) between 1 and 214 and ${name} not glob '*[^a-z0-9@/._~-]*' and (
    (${name} glob '[a-z0-9]*' and ${name} not glob '*[@/]*') or
    (${name} glob '@[a-z0-9]*/*' and substr(${name}, 2) not glob '*@*'
      and substr(${name}, instr(${name}, '/') + 1) glob '[a-z0-9]*'
      and substr(${name}, instr(${name}, '/') + 1) not glob '*/*'))`;
}

function historicalEligibility(registryUrl: string): SQL {
  return sql`${validHistoricalName(sql`s.registry_package_name`)} and s.source in ('manual', 'auto_discovery') and s.status = 'complete'
    and s.registry_url in (${registryUrl}, ${registryUrl + "/"})
    and s.registry_version_status = 'published'
    and ${npmPackageClaimMatches(registryUrl, sql`s.registry_package_name`, sql`s.organization_id`)}
    and s.registry_package_name is not null and s.registry_version is not null
    and case when json_valid(s.summary_json) then json_extract(s.summary_json, '$.stagedPublish.access') end = 'public'
    and not exists (select 1 from publication_watch_candidates c where c.organization_id = s.organization_id and c.package_name = s.registry_package_name and (c.source != 'workflow_gate' or c.stopped_at is not null))`;
}

function gateEligibility(registryUrl: string): SQL {
  return sql`${validHistoricalName(sql`s.package_name`)} and s.source = 'workflow_gate' and s.status = 'complete' and s.package_name is not null
    and case when json_valid(s.summary_json) then json_extract(s.summary_json, '$.stagedPublish.mode') end = 'workflow_gate'
    and case when json_valid(s.summary_json) then json_extract(s.summary_json, '$.stagedPublish.manifest.schema') end = 'drydock.release-artifacts.v1'
    and case when json_valid(s.summary_json) then json_extract(s.summary_json, '$.stagedPublish.manifest.ecosystem') end = 'npm'
    and case when json_valid(s.summary_json) then json_extract(s.summary_json, '$.stagedPublish.manifest.package') end = s.package_name
    and case when json_valid(s.summary_json) then json_extract(s.summary_json, '$.stagedPublish.manifest.version') end = s.staged_version
    and not ${publicationWatchOwnershipConflict(registryUrl, sql`s.package_name`, sql`s.organization_id`)}
    and not exists (select 1 from publication_watch_candidates c where c.organization_id = s.organization_id and c.package_name = s.package_name)`;
}

async function recordCandidates(
  db: AppDb,
  organizationId: string,
  names: readonly string[],
  source: CandidateSource,
) {
  const values = [...new Set(names)].filter(isValidNpmPackageName).map((packageName) => ({
    id: crypto.randomUUID(),
    organizationId,
    packageName,
    source,
    createdAt: new Date(),
    stoppedAt: null,
  }));
  for (let offset = 0; offset < values.length; offset += 10) {
    // Gate reviews establish a useful suggestion, never public visibility.
    // Verified visibility can promote a suggestion without clearing stop intent.
    await db
      .insert(publicationWatchCandidates)
      .values(values.slice(offset, offset + 10))
      .onConflictDoUpdate({
        target: [publicationWatchCandidates.organizationId, publicationWatchCandidates.packageName],
        set: { source },
        setWhere: and(
          eq(publicationWatchCandidates.source, "workflow_gate"),
          sql`${source} != 'workflow_gate'`,
        ),
      });
  }
}

async function enrollCandidates(db: AppDb, organizationId: string, registryUrl: string) {
  const pending = await db
    .select({
      packageName: publicationWatchCandidates.packageName,
      source: publicationWatchCandidates.source,
    })
    .from(publicationWatchCandidates)
    .where(
      and(
        eq(publicationWatchCandidates.organizationId, organizationId),
        isNull(publicationWatchCandidates.stoppedAt),
        npmPackageClaimMatches(
          registryUrl ?? PUBLIC_NPM,
          publicationWatchCandidates.packageName,
          organizationId,
        ),
        sql`${publicationWatchCandidates.source} in ('staged_discovery', 'published_history')`,
        sql`not exists(select 1 from publication_watches w where w.organization_id = ${organizationId} and w.package_name = ${publicationWatchCandidates.packageName})`,
      ),
    )
    .orderBy(asc(publicationWatchCandidates.createdAt), asc(publicationWatchCandidates.packageName))
    .limit(20);
  for (const candidate of pending) {
    // Recheck both suppression and capacity in the insert itself. A concurrent
    // stop or enrollment can occur after the pending-candidate read.
    await db
      .insert(publicationWatches)
      .select(sql`select ${crypto.randomUUID()}, ${organizationId}, ${candidate.packageName}, ${candidate.source}, ${Date.now()}, null, null, null, null, null, null
      where (select count(*) from publication_watches where organization_id = ${organizationId}) < 20
      and ${npmPackageClaimMatches(registryUrl, candidate.packageName, organizationId)}
      and exists(select 1 from publication_watch_candidates where organization_id = ${organizationId} and package_name = ${candidate.packageName} and stopped_at is null and source in ('staged_discovery', 'published_history'))`)
      .onConflictDoNothing({
        target: [publicationWatches.organizationId, publicationWatches.packageName],
      });
  }
}

async function enrollmentSummary(
  db: AppDb,
  organizationId: string,
  registryUrl?: string,
): Promise<PublicationAutoEnrollment> {
  const missingWatch = sql`not exists(select 1 from publication_watches w where w.organization_id = ${organizationId} and w.package_name = ${publicationWatchCandidates.packageName})`;
  const [{ deferred }] = await db
    .select({ deferred: sql<number>`count(*)` })
    .from(publicationWatchCandidates)
    .where(
      and(
        eq(publicationWatchCandidates.organizationId, organizationId),
        isNull(publicationWatchCandidates.stoppedAt),
        npmPackageClaimMatches(
          registryUrl ?? PUBLIC_NPM,
          publicationWatchCandidates.packageName,
          organizationId,
        ),
        sql`${publicationWatchCandidates.source} in ('staged_discovery', 'published_history')`,
        missingWatch,
      ),
    );
  const suggestions = await db
    .select({ packageName: publicationWatchCandidates.packageName })
    .from(publicationWatchCandidates)
    .where(
      and(
        eq(publicationWatchCandidates.organizationId, organizationId),
        isNull(publicationWatchCandidates.stoppedAt),
        eq(publicationWatchCandidates.source, "workflow_gate"),
        sql`not ${publicationWatchOwnershipConflict(registryUrl ?? PUBLIC_NPM, publicationWatchCandidates.packageName, organizationId)}`,
        missingWatch,
      ),
    )
    .orderBy(asc(publicationWatchCandidates.createdAt), asc(publicationWatchCandidates.packageName))
    .limit(100);
  const unrecorded = registryUrl
    ? await db.all<{ count: number }>(
        sql`select count(distinct s.registry_package_name) as count from scans s where s.organization_id = ${organizationId} and ${historicalEligibility(registryUrl)}`,
      )
    : [];
  return { deferred: deferred + (unrecorded[0]?.count ?? 0), suggestions };
}

export async function reconcilePublicationWatches(
  db: AppDb,
  organizationId: string,
  registryUrl = PUBLIC_NPM,
): Promise<PublicationAutoEnrollment> {
  if (!validMonitoringRegistry(registryUrl)) return enrollmentSummary(db, organizationId);
  const history = await db.all<{ packageName: string }>(
    sql`select s.registry_package_name as packageName from scans s where s.organization_id = ${organizationId} and ${historicalEligibility(registryUrl)} group by s.registry_package_name order by min(s.created_at), s.registry_package_name limit ${HISTORY_BATCH}`,
  );
  await recordCandidates(
    db,
    organizationId,
    history.map((item) => item.packageName),
    "published_history",
  );
  const gates = await db.all<{ packageName: string }>(
    sql`select s.package_name as packageName from scans s where s.organization_id = ${organizationId} and ${gateEligibility(registryUrl)} group by s.package_name order by min(s.created_at), s.package_name limit ${HISTORY_BATCH}`,
  );
  await recordCandidates(
    db,
    organizationId,
    gates.map((item) => item.packageName),
    "workflow_gate",
  );
  await enrollCandidates(db, organizationId, registryUrl);
  return enrollmentSummary(db, organizationId, registryUrl);
}

export async function registerStagedPublicationCandidates(
  db: AppDb,
  organizationId: string,
  items: readonly { packageName: string | null; access: string | null }[],
  registryUrl: string,
): Promise<PublicationAutoEnrollment> {
  if (!validMonitoringRegistry(registryUrl)) return enrollmentSummary(db, organizationId);
  await recordCandidates(
    db,
    organizationId,
    items
      .filter((item) => item.access === "public" && item.packageName !== null)
      .map((item) => item.packageName!),
    "staged_discovery",
  );
  return reconcilePublicationWatches(db, organizationId, registryUrl);
}

/**
 * Stages fetched from the organization's npm connection enroll only when that
 * connection is the registry the monitor reads publications from. Enrollment is
 * best-effort: a failure is logged and never fails the review that found it.
 */
export async function enrollStagedReleases(
  db: AppDb,
  env: Cloudflare.Env,
  input: {
    organizationId: string;
    registryUrl: string;
    releases: readonly StagedReleaseVisibility[];
  },
): Promise<void> {
  const publicationRegistry = npmPublicationRegistry(env);
  if (input.registryUrl.replace(/\/$/, "") !== publicationRegistry) return;
  try {
    await registerStagedPublicationCandidates(
      db,
      input.organizationId,
      input.releases,
      publicationRegistry,
    );
  } catch {
    emitOperationalEvent("warn", "npm.publication_monitor.enrollment_failed", {
      organizationId: input.organizationId,
    });
  }
}

export async function backfillNpmPublicationWatches(db: AppDb, registryUrl = PUBLIC_NPM) {
  if (!validMonitoringRegistry(registryUrl)) return;
  // Process previously unrecorded evidence rather than restarting the first
  // organizations each tick. Deferred candidates rejoin once a slot is freed.
  const organizations = await db.all<{ organizationId: string }>(sql`
    select organizationId from (
      select s.organization_id as organizationId, min(s.created_at) as pendingAt from scans s
      where s.organization_id is not null and (${historicalEligibility(registryUrl)} or ${gateEligibility(registryUrl)}) group by s.organization_id
      union all
      select c.organization_id as organizationId, min(c.created_at) as pendingAt from publication_watch_candidates c
      where c.stopped_at is null and c.source in ('staged_discovery', 'published_history')
      and ${npmPackageClaimMatches(registryUrl, sql`c.package_name`, sql`c.organization_id`)}
      and not exists(select 1 from publication_watches w where w.organization_id = c.organization_id and w.package_name = c.package_name)
      and (select count(*) from publication_watches w where w.organization_id = c.organization_id) < 20
      group by c.organization_id
    ) group by organizationId order by min(pendingAt), organizationId limit 8`);
  for (const organization of organizations)
    await reconcilePublicationWatches(db, organization.organizationId, registryUrl);
}
