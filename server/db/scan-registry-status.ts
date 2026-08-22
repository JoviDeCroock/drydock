/**
 * npm registry lifecycle state attached to staged-publish scans.
 *
 * These reads and writes are kept separate from scan job/result persistence:
 * they annotate a completed review in the background and must not make the
 * dashboard's ordinary `updatedAt` polling treat the scan as newly completed.
 */
import {
  aliasedTable,
  and,
  asc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { AppDb } from "./client";
import { scans } from "./schema";

/**
 * Retire every live signal attached to an obsolete registry-stage identity.
 * The share token is a public capability and the feed/badge are public trust
 * assertions, so they must stop with the registry ownership they described.
 */
export function registrySupersessionPatch(supersededAt: Date) {
  return {
    registryStatusSupersededAt: supersededAt,
    registryVersionStatus: null,
    registryVersionStatusAt: null,
    publicShareToken: null,
    publicSharedAt: null,
    publicSharedByUserId: null,
    publicFeedListedAt: null,
    publicPackageKey: null,
  };
}

export async function getScanReleaseIdentity(
  db: AppDb,
  scanId: string,
  organizationId: string,
): Promise<{
  packageName: string | null;
  stagedVersion: string | null;
  registryUrl: string | null;
  registryStatusSupersededAt: Date | null;
} | null> {
  const rows = await db
    .select({
      packageName: scans.registryPackageName,
      stagedVersion: scans.registryVersion,
      registryUrl: scans.registryUrl,
      registryStatusSupersededAt: scans.registryStatusSupersededAt,
    })
    .from(scans)
    .where(and(eq(scans.id, scanId), eq(scans.organizationId, organizationId)))
    .limit(1);
  return rows[0] ?? null;
}

export type BackfillScanRegistryReleaseIdentityResult = "reconciled" | "skipped" | "mismatch";

/**
 * Reconcile control-plane coordinates recovered after a best-effort pre-queue
 * metadata read, while preserving one newest owner for a registry release.
 */
export async function backfillScanRegistryReleaseIdentity(
  db: AppDb,
  input: {
    scanId: string;
    organizationId: string;
    registryUrl: string;
    packageName: string;
    version: string;
    observedAt?: Date;
  },
): Promise<BackfillScanRegistryReleaseIdentityResult> {
  const rows = await db
    .select({
      id: scans.id,
      source: scans.source,
      registryUrl: scans.registryUrl,
      registryPackageName: scans.registryPackageName,
      registryVersion: scans.registryVersion,
      registryStatusSupersededAt: scans.registryStatusSupersededAt,
      createdAt: scans.createdAt,
      // Random scan ids cannot order rows created in the same millisecond.
      rowOrder: sql<number>`${scans}.rowid`,
    })
    .from(scans)
    .where(and(eq(scans.id, input.scanId), eq(scans.organizationId, input.organizationId)))
    .limit(1);
  const current = rows[0];
  if (
    !current ||
    current.registryUrl !== input.registryUrl ||
    !["manual", "auto_discovery"].includes(current.source) ||
    current.registryStatusSupersededAt
  ) {
    return "skipped";
  }
  if (
    (current.registryPackageName !== null && current.registryPackageName !== input.packageName) ||
    (current.registryVersion !== null && current.registryVersion !== input.version)
  ) {
    return "mismatch";
  }

  const observedAt = input.observedAt ?? new Date();
  const owner = aliasedTable(scans, "registry_identity_owner");
  const newerScan = aliasedTable(scans, "newer_registry_identity_scan");
  const activeOwnerExists = exists(
    db
      .select({ id: owner.id })
      .from(owner)
      .where(
        and(
          eq(owner.id, input.scanId),
          eq(owner.organizationId, input.organizationId),
          eq(owner.registryUrl, input.registryUrl),
          eq(owner.registryPackageName, input.packageName),
          eq(owner.registryVersion, input.version),
          inArray(owner.source, ["manual", "auto_discovery"]),
          isNull(owner.registryStatusSupersededAt),
        ),
      )
      .limit(1),
  );
  const newerOwnerExists = exists(
    db
      .select({ id: newerScan.id })
      .from(newerScan)
      .where(
        and(
          eq(newerScan.organizationId, input.organizationId),
          eq(newerScan.registryUrl, input.registryUrl),
          eq(newerScan.registryPackageName, input.packageName),
          eq(newerScan.registryVersion, input.version),
          inArray(newerScan.source, ["manual", "auto_discovery"]),
          isNull(newerScan.registryStatusSupersededAt),
          or(
            gt(newerScan.createdAt, current.createdAt),
            and(
              eq(newerScan.createdAt, current.createdAt),
              gt(sql<number>`${newerScan}.rowid`, current.rowOrder),
            ),
          ),
        ),
      )
      .limit(1),
  );

  const [reconciled] = await db.batch([
    db
      .update(scans)
      .set({ registryPackageName: input.packageName, registryVersion: input.version })
      .where(
        and(
          eq(scans.id, input.scanId),
          eq(scans.organizationId, input.organizationId),
          eq(scans.registryUrl, input.registryUrl),
          inArray(scans.source, ["manual", "auto_discovery"]),
          isNull(scans.registryStatusSupersededAt),
          or(isNull(scans.registryPackageName), eq(scans.registryPackageName, input.packageName)),
          or(isNull(scans.registryVersion), eq(scans.registryVersion, input.version)),
        ),
      )
      .returning({ id: scans.id }),
    db
      .update(scans)
      .set(registrySupersessionPatch(observedAt))
      .where(
        and(
          eq(scans.organizationId, input.organizationId),
          eq(scans.registryUrl, input.registryUrl),
          eq(scans.registryPackageName, input.packageName),
          eq(scans.registryVersion, input.version),
          inArray(scans.source, ["manual", "auto_discovery"]),
          isNull(scans.registryStatusSupersededAt),
          ne(scans.id, input.scanId),
          or(
            lt(scans.createdAt, current.createdAt),
            and(
              eq(scans.createdAt, current.createdAt),
              lt(sql<number>`${scans}.rowid`, current.rowOrder),
            ),
          ),
          activeOwnerExists,
        ),
      ),
    db
      .update(scans)
      .set(registrySupersessionPatch(observedAt))
      .where(
        and(
          eq(scans.id, input.scanId),
          eq(scans.organizationId, input.organizationId),
          isNull(scans.registryStatusSupersededAt),
          newerOwnerExists,
        ),
      ),
  ]);
  if (Array.isArray(reconciled) && reconciled.length > 0) return "reconciled";

  // A concurrent delivery may have changed the row after the initial read.
  const latestRows = await db
    .select({
      source: scans.source,
      registryUrl: scans.registryUrl,
      registryPackageName: scans.registryPackageName,
      registryVersion: scans.registryVersion,
      registryStatusSupersededAt: scans.registryStatusSupersededAt,
    })
    .from(scans)
    .where(and(eq(scans.id, input.scanId), eq(scans.organizationId, input.organizationId)))
    .limit(1);
  const latest = latestRows[0];
  if (
    !latest ||
    latest.registryUrl !== input.registryUrl ||
    !["manual", "auto_discovery"].includes(latest.source) ||
    latest.registryStatusSupersededAt
  ) {
    return "skipped";
  }
  return latest.registryPackageName === input.packageName &&
    latest.registryVersion === input.version
    ? "reconciled"
    : "mismatch";
}

export interface RegistryStatusCandidate {
  id: string;
  stageId: string;
  packageName: string;
  stagedVersion: string;
  decision: string | null;
  decidedAt: Date | null;
  registryVersionStatus: string | null;
  registryPublishReminderAt: Date | null;
}

interface RegistryStatusRecheckRule {
  status: string | null;
  recheckBefore: Date;
}

export interface ListScansAwaitingRegistryStatusOptions {
  limit: number;
  registryUrl: string;
  createdAfter: Date;
  rules: readonly RegistryStatusRecheckRule[];
}

export async function listScansAwaitingRegistryStatus(
  db: AppDb,
  organizationId: string,
  options: ListScansAwaitingRegistryStatusOptions,
): Promise<RegistryStatusCandidate[]> {
  if (!options.rules.length) return [];
  const newerScan = aliasedTable(scans, "newer_registry_scan");
  const ruleConditions = options.rules.map((rule) =>
    and(
      rule.status === null
        ? isNull(scans.registryVersionStatus)
        : eq(scans.registryVersionStatus, rule.status),
      or(
        isNull(scans.registryVersionStatusAttemptedAt),
        lt(scans.registryVersionStatusAttemptedAt, rule.recheckBefore),
      )!,
    )!,
  );

  const rows = await db
    .select({
      id: scans.id,
      stageId: scans.stageId,
      packageName: scans.registryPackageName,
      stagedVersion: scans.registryVersion,
      decision: scans.decision,
      decidedAt: scans.decidedAt,
      registryVersionStatus: scans.registryVersionStatus,
      registryPublishReminderAt: scans.registryPublishReminderAt,
    })
    .from(scans)
    .where(
      and(
        eq(scans.organizationId, organizationId),
        eq(scans.registryUrl, options.registryUrl),
        eq(scans.status, "complete"),
        inArray(scans.source, ["manual", "auto_discovery"]),
        isNotNull(scans.registryPackageName),
        isNotNull(scans.registryVersion),
        isNull(scans.registryStatusSupersededAt),
        gte(scans.createdAt, options.createdAfter),
        notExists(
          db
            .select({ id: newerScan.id })
            .from(newerScan)
            .where(
              and(
                eq(newerScan.organizationId, scans.organizationId),
                eq(newerScan.registryUrl, scans.registryUrl),
                eq(newerScan.registryPackageName, scans.registryPackageName),
                eq(newerScan.registryVersion, scans.registryVersion),
                inArray(newerScan.source, ["manual", "auto_discovery"]),
                isNull(newerScan.registryStatusSupersededAt),
                or(
                  gt(newerScan.createdAt, scans.createdAt),
                  and(eq(newerScan.createdAt, scans.createdAt), gt(newerScan.id, scans.id)),
                ),
              ),
            )
            .limit(1),
        ),
        ruleConditions.length === 1 ? ruleConditions[0] : or(...ruleConditions)!,
      ),
    )
    .orderBy(
      asc(sql<number>`coalesce(${scans.registryVersionStatusAttemptedAt}, ${scans.createdAt})`),
      asc(scans.createdAt),
      asc(scans.id),
    )
    .limit(Math.max(0, Math.floor(options.limit)));

  return rows.flatMap((row) =>
    row.packageName && row.stagedVersion
      ? [
          {
            id: row.id,
            stageId: row.stageId,
            packageName: row.packageName,
            stagedVersion: row.stagedVersion,
            decision: row.decision,
            decidedAt: row.decidedAt,
            registryVersionStatus: row.registryVersionStatus,
            registryPublishReminderAt: row.registryPublishReminderAt,
          },
        ]
      : [],
  );
}

export async function markRegistryPublishReminderSent(
  db: AppDb,
  input: {
    scanId: string;
    organizationId: string;
    expectedDecidedAt: Date;
    expectedRegistryStatusAt: Date;
    sentAt?: Date;
  },
): Promise<boolean> {
  const priorReminder = aliasedTable(scans, "prior_registry_reminder");
  const rows = await db
    .update(scans)
    .set({ registryPublishReminderAt: input.sentAt ?? new Date() })
    .where(
      and(
        eq(scans.id, input.scanId),
        eq(scans.organizationId, input.organizationId),
        eq(scans.decision, "publish"),
        eq(scans.decidedAt, input.expectedDecidedAt),
        eq(scans.registryVersionStatus, "staged"),
        eq(scans.registryVersionStatusAt, input.expectedRegistryStatusAt),
        isNull(scans.registryStatusSupersededAt),
        isNull(scans.registryPublishReminderAt),
        notExists(
          db
            .select({ id: priorReminder.id })
            .from(priorReminder)
            .where(
              and(
                eq(priorReminder.organizationId, scans.organizationId),
                eq(priorReminder.registryUrl, scans.registryUrl),
                eq(priorReminder.stageId, scans.stageId),
                isNotNull(priorReminder.registryPublishReminderAt),
              ),
            )
            .limit(1),
        ),
      ),
    )
    .returning({ id: scans.id });
  return rows.length > 0;
}

export async function recordRegistryVersionStatus(
  db: AppDb,
  input: { scanId: string; organizationId: string; status: string | null; checkedAt?: Date },
): Promise<boolean> {
  const checkedAt = input.checkedAt ?? new Date();
  const values = input.status
    ? {
        registryVersionStatus: input.status,
        registryVersionStatusAt: checkedAt,
        registryVersionStatusAttemptedAt: checkedAt,
      }
    : { registryVersionStatusAttemptedAt: checkedAt };
  const rows = await db
    .update(scans)
    .set(values)
    .where(
      and(
        eq(scans.id, input.scanId),
        eq(scans.organizationId, input.organizationId),
        isNull(scans.registryStatusSupersededAt),
        or(
          isNull(scans.registryVersionStatusAttemptedAt),
          lt(scans.registryVersionStatusAttemptedAt, checkedAt),
        ),
      ),
    )
    .returning({ id: scans.id });
  return rows.length > 0;
}

const REGISTRY_SUPERSESSION_COORDINATES_PER_QUERY = 20;

export async function supersedeRegistryReleaseIncarnations(
  db: AppDb,
  input: {
    organizationId: string;
    registryUrl: string;
    releases: readonly { stageId: string; packageName: string; version: string }[];
    supersededAt?: Date;
  },
): Promise<void> {
  const byCoordinate = new Map<string, (typeof input.releases)[number]>();
  for (const release of input.releases) {
    const key = JSON.stringify([release.packageName, release.version]);
    if (!byCoordinate.has(key)) byCoordinate.set(key, release);
  }
  const releases = [...byCoordinate.values()];
  const supersededAt = input.supersededAt ?? new Date();
  for (
    let index = 0;
    index < releases.length;
    index += REGISTRY_SUPERSESSION_COORDINATES_PER_QUERY
  ) {
    const chunk = releases.slice(index, index + REGISTRY_SUPERSESSION_COORDINATES_PER_QUERY);
    const replacements = chunk.map((release) =>
      and(
        eq(scans.registryPackageName, release.packageName),
        eq(scans.registryVersion, release.version),
        ne(scans.stageId, release.stageId),
      )!,
    );
    await db
      .update(scans)
      .set(registrySupersessionPatch(supersededAt))
      .where(
        and(
          eq(scans.organizationId, input.organizationId),
          eq(scans.registryUrl, input.registryUrl),
          inArray(scans.source, ["manual", "auto_discovery"]),
          isNull(scans.registryStatusSupersededAt),
          replacements.length === 1 ? replacements[0] : or(...replacements)!,
        ),
      );
  }
}
