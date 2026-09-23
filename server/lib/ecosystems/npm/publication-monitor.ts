import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { AppDb } from "../../../db/client";
import {
  isPublicationAlert,
  listUnnotifiedPublicationAlerts,
  markPublicationAlertNotified,
  savePublicationObservation,
  type PublicationAlertStatus,
} from "../../../db/publication-alerts";
import {
  getPublicationWatch,
  type PublicationObservation,
  type PublicationWatch,
} from "../../../db/publication-watches";
import { publicationObservations, publicationWatches, scans } from "../../../db/schema";
import { recordProductEvent } from "../../analytics";
import { notifyPublicationDiscrepancy } from "../../notify";
import { mapWithConcurrency } from "../../platform/concurrency";
import { isRecord } from "../../platform/guards";
import { describeOperationalError, emitOperationalEvent } from "../../platform/observability";
import type { PublicationMonitorAdapter } from "../types";
import { backfillNpmPublicationWatches, enrollStagedReleases } from "./publication-auto-enrollment";
import { npmPublicationRegistry } from "./publication-registry";
import {
  classifyPublication,
  isSettledUnknownReason,
  PUBLIC_NPM_REGISTRY,
  releaseRecords,
  type ArtifactUnavailableReason,
  type PublishedDigests,
  type Verdict,
} from "./publication-verdict";
import { isPublishedTarballUrlAllowed } from "./published-tarball";
import { pickBaselineVersion } from "./registry";

const METADATA_LIMIT = 4 * 1024 * 1024;
const TARBALL_LIMIT = 16 * 1024 * 1024;
const RESPONSE_DEADLINE_MS = 5_000;
// One check examines a bounded batch of releases, and only some of them may
// download a tarball. Re-evaluating a release from stored digests, or deciding
// one that has no Drydock record, costs queries rather than egress.
const RELEASES_PER_CHECK = 6;
const TARBALLS_PER_CHECK = 3;
const SETTLED_RECHECK_MS = 24 * 60 * 60 * 1000;
const CLAIM_LEASE_MS = 60_000;
const WATCH_DUE_AFTER_MS = 5 * 60_000;
// A scheduled invocation shares its D1 query and subrequest allowance with
// stage discovery and retention. A check costs about a dozen queries and at
// most one metadata plus three tarball fetches, so 24 checks fit inside both
// with room to spare while still covering a full 20-watch organization in one
// tick when it is the only one due.
const SWEEP_WATCH_BUDGET = 24;
const SWEEP_CONCURRENCY = 4;
// No new check starts after this; a running one finishes under its own
// per-response deadlines, well inside the cron wall-clock limit.
const SWEEP_DEADLINE_MS = 60_000;

class PublicEvidenceError extends Error {
  constructor(readonly code: "unavailable" | "too_large" | "timeout") {
    super(`public_evidence_${code}`);
  }
}

async function consumePublicResponse(
  url: string,
  maxBytes: number,
  consume: (chunk: Uint8Array) => void,
) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, RESPONSE_DEADLINE_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: { Accept: "application/json, application/octet-stream" },
    });
    if (!response.ok || !response.body) throw new PublicEvidenceError("unavailable");
    if (Number(response.headers.get("content-length")) > maxBytes)
      throw new PublicEvidenceError("too_large");
    reader = response.body.getReader();
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new PublicEvidenceError("too_large");
      consume(chunk.value);
    }
  } catch (err) {
    if (err instanceof PublicEvidenceError) throw err;
    throw new PublicEvidenceError(timedOut ? "timeout" : "unavailable");
  } finally {
    clearTimeout(timeout);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    controller.abort();
  }
}

async function fetchMetadata(name: string, registry: string): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  await consumePublicResponse(
    `${registry}/${encodeURIComponent(name).replace(/^%40/, "@")}`,
    METADATA_LIMIT,
    (chunk) => {
      chunks.push(chunk);
      size += chunk.byteLength;
    },
  );
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(data) || data.name !== name || !isRecord(data.versions))
    throw new Error("invalid_package_metadata");
  return data;
}

async function hashPublishedArtifact(
  value: unknown,
  name: string,
  version: string,
  registry: string,
): Promise<PublishedDigests | ArtifactUnavailableReason> {
  if (
    !isRecord(value) ||
    value.name !== name ||
    value.version !== version ||
    !isRecord(value.dist) ||
    typeof value.dist.tarball !== "string"
  )
    return "artifact_identity_invalid";
  let url: URL;
  try {
    url = new URL(value.dist.tarball);
  } catch {
    return "artifact_identity_invalid";
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !isPublishedTarballUrlAllowed(url.href, registry, registry !== PUBLIC_NPM_REGISTRY)
  )
    return "artifact_identity_invalid";
  const sha1 = createHash("sha1");
  const sha256 = createHash("sha256");
  try {
    await consumePublicResponse(url.href, TARBALL_LIMIT, (chunk) => {
      sha1.update(chunk);
      sha256.update(chunk);
    });
  } catch (err) {
    const code = err instanceof PublicEvidenceError ? err.code : "unavailable";
    return code === "too_large"
      ? "artifact_too_large"
      : code === "timeout"
        ? "artifact_timeout"
        : "artifact_unavailable";
  }
  return { sha1: sha1.digest("hex"), sha256: sha256.digest("hex") };
}

/** The organization `out-of-band-watch` killswitch; on without a FLAGS binding. */
function publicationMonitoringEnabled(env: Cloudflare.Env, organizationId: string) {
  if (!env.FLAGS) return Promise.resolve(true);
  return env.FLAGS.getBooleanValue("out-of-band-watch", true, {
    targetingKey: organizationId,
    organizationId,
  });
}

function watchKey(watch: { id: string; organizationId: string }) {
  return and(
    eq(publicationWatches.id, watch.id),
    eq(publicationWatches.organizationId, watch.organizationId),
  );
}

async function setLastError(
  db: AppDb,
  watch: { id: string; organizationId: string },
  lastError: string | null,
) {
  await db.update(publicationWatches).set({ lastError }).where(watchKey(watch));
}

export async function checkNpmPublicationWatch(
  db: AppDb,
  env: Cloudflare.Env,
  watch: PublicationWatch,
  options: { monitoringEnabled?: boolean } = {},
) {
  const now = new Date();
  // Claim first, before anything that can return early or throw. The lease
  // makes manual checks and overlapping cron invocations share the bound, and
  // it moves a switched-off or failing watch to the back of the sweep order
  // instead of leaving it the oldest forever.
  const claimed = await db
    .update(publicationWatches)
    .set({ lastCheckedAt: now })
    .where(
      and(
        watchKey(watch),
        or(
          isNull(publicationWatches.lastCheckedAt),
          lt(publicationWatches.lastCheckedAt, new Date(now.getTime() - CLAIM_LEASE_MS)),
        ),
      ),
    )
    .returning({ id: publicationWatches.id });
  if (!claimed.length) return getPublicationWatch(db, watch.organizationId, watch.id);
  const enabled =
    options.monitoringEnabled ?? (await publicationMonitoringEnabled(env, watch.organizationId));
  if (!enabled) {
    await setLastError(db, watch, "monitoring_disabled");
    return getPublicationWatch(db, watch.organizationId, watch.id);
  }
  const { lastError, attempted } = await examineReleases(db, env, watch, now);
  // Alert rows are committed before delivery is attempted, and a settled
  // observation is never re-examined, so anything left unsent gets another
  // chance here rather than being lost with the isolate that failed to send it.
  await redeliverPendingAlerts(env, db, watch, attempted);
  await setLastError(db, watch, lastError);
  return getPublicationWatch(db, watch.organizationId, watch.id);
}

type ObservedRelease = Pick<
  PublicationObservation,
  | "id"
  | "version"
  | "status"
  | "reason"
  | "firstSeenAt"
  | "checkedAt"
  | "sha1"
  | "sha256"
  | "distTags"
>;

const MAX_DIST_TAGS = 100;

/**
 * Which dist-tags point at each version right now, tags sorted. The packument
 * is untrusted: malformed or excess entries are dropped rather than trusted,
 * and the count is capped so a hostile packument cannot turn one check into
 * thousands of writes.
 */
function distTagsByVersion(metadata: Record<string, unknown>): Map<string, string[]> {
  const byVersion = new Map<string, string[]>();
  const raw = metadata["dist-tags"];
  if (!isRecord(raw)) return byVersion;
  for (const [tag, version] of Object.entries(raw).slice(0, MAX_DIST_TAGS)) {
    if (typeof version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tag)) continue;
    byVersion.set(version, [...(byVersion.get(version) ?? []), tag].sort());
  }
  return byVersion;
}

function sameTags(a: readonly string[] | null, b: readonly string[]): boolean {
  const left = a ?? [];
  return left.length === b.length && left.every((tag, index) => tag === b[index]);
}

/**
 * Keep every observation's dist-tags current, settled ones included, so a
 * reader can tell which release line a version is on today. Only rows whose
 * tags changed are written.
 */
async function refreshObservedDistTags(
  db: AppDb,
  watch: PublicationWatch,
  observed: readonly ObservedRelease[],
  tagsByVersion: ReadonlyMap<string, string[]>,
) {
  const updates = observed.flatMap((row) => {
    const tags = tagsByVersion.get(row.version) ?? [];
    if (sameTags(row.distTags, tags)) return [];
    return [
      db
        .update(publicationObservations)
        .set({ distTags: tags })
        .where(
          and(
            eq(publicationObservations.id, row.id),
            eq(publicationObservations.organizationId, watch.organizationId),
          ),
        ),
    ];
  });
  for (let offset = 0; offset < updates.length; offset += 50) {
    const [first, ...rest] = updates.slice(offset, offset + 50);
    if (first) await db.batch([first, ...rest]);
  }
}

/**
 * The published version this release follows, by the same semver-predecessor
 * rule a staged review uses for its baseline. A first release has none: the
 * "highest published" fallback would diff backwards.
 */
function previousPublishedVersion(
  versions: Record<string, unknown>,
  version: string,
): string | null {
  const baseline = pickBaselineVersion({ versions }, version, null);
  return baseline.source === "semver-predecessor" ? baseline.version : null;
}

/** npm's own `dist.shasum` for a version, used only one-sidedly (never as a match). */
function declaredShasum(value: unknown): unknown {
  return isRecord(value) && isRecord(value.dist) ? value.dist.shasum : null;
}

/** Bytes a previous check already established for this immutable version. */
function storedArtifact(
  previous: ObservedRelease | undefined,
): PublishedDigests | ArtifactUnavailableReason | null {
  if (previous?.sha1 && previous.sha256) return { sha1: previous.sha1, sha256: previous.sha256 };
  return previous?.reason === "artifact_too_large" ? "artifact_too_large" : null;
}

async function examineReleases(
  db: AppDb,
  env: Cloudflare.Env,
  watch: PublicationWatch,
  now: Date,
): Promise<{ lastError: string | null; attempted: Set<string> }> {
  const registry = npmPublicationRegistry(env);
  const attempted = new Set<string>();
  let lastError: string | null = null;
  const note = (problem: string) => {
    lastError ??= problem;
  };
  let metadata: Record<string, unknown>;
  let versions: Record<string, unknown>;
  let times: Record<string, unknown>;
  let observed: ObservedRelease[];
  try {
    metadata = await fetchMetadata(watch.packageName, registry);
    versions = isRecord(metadata.versions) ? metadata.versions : {};
    times = isRecord(metadata.time) ? metadata.time : {};
    observed = await db
      .select({
        id: publicationObservations.id,
        version: publicationObservations.version,
        status: publicationObservations.status,
        reason: publicationObservations.reason,
        firstSeenAt: publicationObservations.firstSeenAt,
        checkedAt: publicationObservations.checkedAt,
        sha1: publicationObservations.sha1,
        sha256: publicationObservations.sha256,
        distTags: publicationObservations.distTags,
      })
      .from(publicationObservations)
      .where(
        and(
          eq(publicationObservations.watchId, watch.id),
          eq(publicationObservations.organizationId, watch.organizationId),
        ),
      )
      .limit(10_001);
  } catch {
    emitOperationalEvent("warn", "npm.publication_monitor.check_failed", {
      organizationId: watch.organizationId,
      watchId: watch.id,
    });
    return { lastError: "registry_evidence_unavailable", attempted };
  }
  if (observed.length > 10_000 || Object.keys(versions).length > 10_000) {
    emitOperationalEvent("warn", "npm.publication_monitor.check_failed", {
      organizationId: watch.organizationId,
      watchId: watch.id,
      reason: "publication_history_limit",
    });
    return { lastError: "publication_history_limit", attempted };
  }
  const tagsByVersion = distTagsByVersion(metadata);
  await refreshObservedDistTags(db, watch, observed, tagsByVersion);
  const existing = new Map(observed.map((item) => [item.version, item]));
  const pending: { version: string; publishedAt: Date | null; previous?: ObservedRelease }[] = [];
  for (const version of Object.keys(versions)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(version)) {
      note("invalid_version_metadata");
      continue;
    }
    const rawTime = times[version];
    const millis = typeof rawTime === "string" ? Date.parse(rawTime) : NaN;
    const publishedAt = Number.isFinite(millis) && millis <= Date.now() ? new Date(millis) : null;
    if (publishedAt && publishedAt < watch.createdAt) continue;
    const previous = existing.get(version);
    if (previous && previous.status !== "unknown") continue;
    if (
      previous &&
      isSettledUnknownReason(previous.reason) &&
      now.getTime() - previous.checkedAt.getTime() < SETTLED_RECHECK_MS
    )
      continue;
    pending.push({ version, publishedAt, previous });
  }
  pending.sort(
    (a, b) =>
      (a.previous?.checkedAt.getTime() ?? 0) - (b.previous?.checkedAt.getTime() ?? 0) ||
      (a.publishedAt?.getTime() ?? 0) - (b.publishedAt?.getTime() ?? 0) ||
      a.version.localeCompare(b.version),
  );

  let examined = 0;
  let downloads = 0;
  for (const item of pending) {
    if (examined >= RELEASES_PER_CHECK) {
      note("pending_release_backlog");
      break;
    }
    const reviews = await db
      .select()
      .from(scans)
      .where(
        and(
          eq(scans.organizationId, watch.organizationId),
          eq(scans.packageName, watch.packageName),
          eq(scans.stagedVersion, item.version),
        ),
      )
      .limit(101);
    let verdict: Verdict;
    let digests: PublishedDigests | null = null;
    if (reviews.length > 100) {
      verdict = { status: "unknown", reason: "review_history_limit", scanId: null };
    } else {
      // Bytes matter only against a Drydock record of this release; a release
      // with none is decided without downloading it.
      let artifact = storedArtifact(item.previous);
      if (
        artifact === null &&
        item.publishedAt &&
        releaseRecords(watch.packageName, item.version, reviews, registry).length > 0
      ) {
        if (downloads >= TARBALLS_PER_CHECK) {
          note("pending_release_backlog");
          continue;
        }
        downloads++;
        artifact = await hashPublishedArtifact(
          versions[item.version],
          watch.packageName,
          item.version,
          registry,
        );
        if (typeof artifact === "string") {
          note(artifact);
          emitOperationalEvent("warn", "npm.publication_monitor.artifact_unavailable", {
            organizationId: watch.organizationId,
            watchId: watch.id,
            reason: artifact,
          });
        }
      }
      if (artifact !== null && typeof artifact === "object") digests = artifact;
      verdict = classifyPublication(
        watch.packageName,
        item.version,
        item.publishedAt,
        artifact,
        reviews,
        { registry, declaredSha1: declaredShasum(versions[item.version]) },
      );
    }
    examined++;
    const createdAlert = await savePublicationObservation(
      db,
      {
        id: item.previous?.id ?? crypto.randomUUID(),
        watchId: watch.id,
        organizationId: watch.organizationId,
        version: item.version,
        publishedAt: item.publishedAt,
        firstSeenAt: item.previous?.firstSeenAt ?? now,
        checkedAt: now,
        ...verdict,
        sha1: digests?.sha1 ?? null,
        sha256: digests?.sha256 ?? null,
        previousVersion: previousPublishedVersion(versions, item.version),
        distTags: tagsByVersion.get(item.version) ?? [],
      },
      watch.packageName,
    );
    if (createdAlert && isPublicationAlert(verdict.status)) {
      recordProductEvent(env, {
        name: "publication.discrepancy",
        organizationId: watch.organizationId,
        ecosystem: "npm",
        status: verdict.status,
      });
      attempted.add(item.version);
      await deliverPublicationAlert(env, db, watch, {
        organizationId: watch.organizationId,
        packageName: watch.packageName,
        version: item.version,
        status: verdict.status,
      });
    }
  }
  return { lastError, attempted };
}

/**
 * Send one alert. It is marked notified when a channel accepted it, or when
 * the organization has nowhere to send it (no recipient and no Slack channel),
 * since retrying cannot change that. A delivery that failed stays pending, and
 * the redrive below tries it again on the watch's next check.
 */
async function deliverPublicationAlert(
  env: Cloudflare.Env,
  db: AppDb,
  watch: { id: string; organizationId: string },
  alert: {
    organizationId: string;
    packageName: string;
    version: string;
    status: PublicationAlertStatus;
  },
) {
  const context = { organizationId: watch.organizationId, watchId: watch.id };
  try {
    const outcome = await notifyPublicationDiscrepancy({ env, db, ...alert });
    if (outcome === "failed") {
      emitOperationalEvent("warn", "npm.publication_monitor.notification_failed", context);
      return;
    }
    if (outcome === "no_destination") {
      emitOperationalEvent("warn", "npm.publication_monitor.notification_undeliverable", context);
    }
    await markPublicationAlertNotified(db, alert);
  } catch {
    emitOperationalEvent("warn", "npm.publication_monitor.notification_failed", context);
  }
}

async function redeliverPendingAlerts(
  env: Cloudflare.Env,
  db: AppDb,
  watch: { id: string; organizationId: string; packageName: string },
  attempted: ReadonlySet<string>,
) {
  let pending: Awaited<ReturnType<typeof listUnnotifiedPublicationAlerts>>;
  try {
    pending = await listUnnotifiedPublicationAlerts(db, {
      organizationId: watch.organizationId,
      packageName: watch.packageName,
      watchId: watch.id,
    });
  } catch {
    return;
  }
  for (const alert of pending) {
    // One attempt per alert per check; a delivery that just failed waits for
    // the next check rather than hammering a transport that is down.
    if (attempted.has(alert.version)) continue;
    await deliverPublicationAlert(env, db, watch, {
      organizationId: watch.organizationId,
      packageName: watch.packageName,
      version: alert.version,
      status: alert.status,
    });
  }
}

/**
 * Due watches in round-robin order across organizations: every organization's
 * oldest due watch before any organization's second. A limit taken from this
 * order gives each organization at most its share of the tick, however many
 * watches it holds.
 */
async function dueWatchesByOrganization(db: AppDb, now: Date, limit: number) {
  const dueBefore = now.getTime() - WATCH_DUE_AFTER_MS;
  const ranked = await db.all<{ id: string }>(sql`
    select id from (
      select id, last_checked_at, row_number() over (
        partition by organization_id order by coalesce(last_checked_at, 0), id
      ) as organization_rank
      from publication_watches
      where last_checked_at is null or last_checked_at < ${dueBefore}
    ) order by organization_rank, coalesce(last_checked_at, 0), id limit ${limit}`);
  if (ranked.length === 0) return [];
  const rows = await db
    .select()
    .from(publicationWatches)
    .where(
      inArray(
        publicationWatches.id,
        ranked.map((row) => row.id),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ranked.flatMap((row) => byId.get(row.id) ?? []);
}

/**
 * Move every due watch of an organization whose monitoring is switched off to
 * the back of the order, so it holds no sweep slot, and say why on the watch.
 */
async function deferSwitchedOffOrganization(db: AppDb, organizationId: string, now: Date) {
  await db
    .update(publicationWatches)
    .set({ lastCheckedAt: now, lastError: "monitoring_disabled" })
    .where(
      and(
        eq(publicationWatches.organizationId, organizationId),
        or(
          isNull(publicationWatches.lastCheckedAt),
          lt(publicationWatches.lastCheckedAt, new Date(now.getTime() - WATCH_DUE_AFTER_MS)),
        ),
      ),
    );
}

/** A check that threw still advances its watch, so one failure cannot pin a slot. */
async function recordWatchFailure(db: AppDb, watch: PublicationWatch, err: unknown) {
  emitOperationalEvent("error", "npm.publication_monitor.watch_failed", {
    organizationId: watch.organizationId,
    watchId: watch.id,
    error: describeOperationalError(err),
  });
  try {
    await db
      .update(publicationWatches)
      .set({ lastCheckedAt: new Date(), lastError: "check_failed" })
      .where(watchKey(watch));
  } catch {
    // The database itself is failing; the next tick retries the whole sweep.
  }
}

export async function sweepNpmPublicationWatches(
  db: AppDb,
  env: Cloudflare.Env,
  options: { budget?: number; deadlineMs?: number } = {},
) {
  const startedAt = Date.now();
  const now = new Date(startedAt);
  const budget = options.budget ?? SWEEP_WATCH_BUDGET;
  const deadline = startedAt + (options.deadlineMs ?? SWEEP_DEADLINE_MS);
  // Over-fetch so watches of switched-off organizations, which are deferred
  // rather than checked, do not leave the check budget unspent.
  const candidates = await dueWatchesByOrganization(db, now, budget * 2);
  const enabled = new Map<string, Promise<boolean>>();
  const deferred = new Set<string>();
  const counts = { checked: 0, failed: 0, skipped: 0, switchedOff: 0 };
  let started = 0;
  await mapWithConcurrency(candidates, SWEEP_CONCURRENCY, async (watch) => {
    try {
      let organizationEnabled = enabled.get(watch.organizationId);
      if (!organizationEnabled) {
        organizationEnabled = publicationMonitoringEnabled(env, watch.organizationId);
        enabled.set(watch.organizationId, organizationEnabled);
      }
      if (!(await organizationEnabled)) {
        if (deferred.has(watch.organizationId)) return;
        deferred.add(watch.organizationId);
        counts.switchedOff++;
        await deferSwitchedOffOrganization(db, watch.organizationId, now);
        return;
      }
      if (started >= budget || Date.now() > deadline) {
        counts.skipped++;
        return;
      }
      started++;
      await checkNpmPublicationWatch(db, env, watch, { monitoringEnabled: true });
      counts.checked++;
    } catch (err) {
      counts.failed++;
      await recordWatchFailure(db, watch, err);
    }
  });
  emitOperationalEvent("info", "npm.publication_monitor.swept", {
    candidates: candidates.length,
    ...counts,
    durationMs: Date.now() - startedAt,
  });
}

export const npmPublicationMonitor: PublicationMonitorAdapter = {
  backfillWatches: (db, env) => backfillNpmPublicationWatches(db, npmPublicationRegistry(env)),
  sweepWatches: (db, env) => sweepNpmPublicationWatches(db, env),
  registerStagedReleases: enrollStagedReleases,
};
