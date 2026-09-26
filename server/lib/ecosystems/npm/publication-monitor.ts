import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { AppDb } from "../../../db/client";
import { isPublicationAlert, savePublicationObservation } from "../../../db/publication-alerts";
import {
  getPublicationWatch,
  recordWatchCoverageGap,
  type PublicationObservation,
  type PublicationWatch,
} from "../../../db/publication-watches";
import { publicationObservations, publicationWatches, scans } from "../../../db/schema";
import { recordProductEvent } from "../../analytics";
import { mapWithConcurrency } from "../../platform/concurrency";
import { describeOperationalError, emitOperationalEvent } from "../../platform/observability";
import type { PublicationMonitorAdapter } from "../types";
import {
  createPackumentExtractor,
  type PackumentExtract,
  type PackumentVersion,
} from "./packument-stream";
import { backfillNpmPublicationWatches, enrollStagedReleases } from "./publication-auto-enrollment";
import {
  deliverPublicationAlert,
  notifyCoverageGaps,
  redeliverPendingAlerts,
} from "./publication-notices";
import { npmPublicationRegistry } from "./publication-registry";
import {
  classifyPublication,
  isSettledUnknownReason,
  PUBLIC_NPM_REGISTRY,
  releaseRecords,
  type ArtifactUnavailableReason,
  type PublishedDigests,
  type ReviewEvidence,
  type Verdict,
} from "./publication-verdict";
import { isPublishedTarballUrlAllowed } from "./published-tarball";
import { pickBaselineVersion } from "./registry";

// Both documents stream into bounded state (the packument into the fields the
// verdict reads, a tarball into two hashes), so memory stays flat and the caps
// bound time and egress. They are far above any ordinary package: padding a
// release past them takes hundreds of megabytes, and what cannot be verified
// is still reported as a coverage gap.
const METADATA_LIMIT = 64 * 1024 * 1024;
const METADATA_DEADLINE_MS = 15_000;
const TARBALL_LIMIT = 256 * 1024 * 1024;
const TARBALL_DEADLINE_MS = 30_000;
// All of a check's tarball downloads share this deadline, so metadata plus
// downloads end well inside the watch's claim lease and a manual check cannot
// overlap a scheduled one and download the same bytes again.
const DOWNLOAD_BUDGET_MS = 30_000;
// Bytes one sweep (or one manual check) reads, metadata and tarballs together.
// Once spent, no new check or download starts; hashing and parsing cost CPU,
// and the sweep shares its invocation with stage discovery.
const SWEEP_BYTE_BUDGET = 1024 * 1024 * 1024;
const MAX_VERSIONS = 10_000;
// Undecided records read per release, newest first. Decisions are made by
// people, so every decided record is read (up to a generous bound); records
// anyone who can stage or run a gate can create are capped. With more, a byte
// match still decides; without one, the release alerts.
const UNDECIDED_HISTORY_LIMIT = 100;
const DECIDED_HISTORY_LIMIT = 500;
// History queries per check, so a check whose download budget is spent does
// not keep querying every pending release.
const HISTORY_LOOKUPS_PER_CHECK = 12;
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

// Package-wide reasons some release cannot be verified that another check will
// not fix by itself; they become a coverage gap on the watch. A failed read of
// the package document is a weaker one: it becomes a gap only if nothing else
// is recorded, and like any gap is reported only once it has lasted an hour.
const PERSISTENT_WATCH_PROBLEMS = new Set([
  "registry_metadata_too_large",
  "publication_history_limit",
  "invalid_version_metadata",
]);
const TRANSIENT_WATCH_PROBLEM = "registry_evidence_unavailable";

/** Bytes read so far by one sweep or manual check, against `SWEEP_BYTE_BUDGET`. */
interface ByteMeter {
  bytes: number;
}

class PublicEvidenceError extends Error {
  constructor(readonly code: "unavailable" | "too_large" | "timeout") {
    super(`public_evidence_${code}`);
  }
}

async function consumePublicResponse(
  url: string,
  limits: { maxBytes: number; deadlineMs: number; meter: ByteMeter },
  consume: (chunk: Uint8Array) => void,
) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limits.deadlineMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  // A consumer's own error (a malformed document) is not a transport failure.
  let consumerError: unknown;
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: { Accept: "application/json, application/octet-stream" },
    });
    if (!response.ok || !response.body) throw new PublicEvidenceError("unavailable");
    if (Number(response.headers.get("content-length")) > limits.maxBytes)
      throw new PublicEvidenceError("too_large");
    reader = response.body.getReader();
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      limits.meter.bytes += chunk.value.byteLength;
      if (size > limits.maxBytes) throw new PublicEvidenceError("too_large");
      try {
        consume(chunk.value);
      } catch (err) {
        consumerError = err;
        throw err;
      }
    }
  } catch (err) {
    if (err instanceof PublicEvidenceError || (consumerError && err === consumerError)) throw err;
    throw new PublicEvidenceError(timedOut ? "timeout" : "unavailable");
  } finally {
    clearTimeout(timeout);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    controller.abort();
  }
}

/** Why npm's package document could not be used. */
class MetadataError extends Error {
  constructor(readonly reason: "registry_evidence_unavailable" | "registry_metadata_too_large") {
    super(reason);
  }
}

/**
 * npm's full package document, streamed into only what the verdict reads.
 * npm's abbreviated install document is much smaller but omits the per-version
 * publish times that bound enrollment and order decisions, so the full one is
 * read, with flat memory, whatever its size up to the cap.
 */
async function fetchMetadata(
  name: string,
  registry: string,
  meter: ByteMeter,
): Promise<PackumentExtract> {
  const extractor = createPackumentExtractor({ maxVersions: MAX_VERSIONS + 1 });
  try {
    await consumePublicResponse(
      `${registry}/${encodeURIComponent(name).replace(/^%40/, "@")}`,
      { maxBytes: METADATA_LIMIT, deadlineMs: METADATA_DEADLINE_MS, meter },
      (chunk) => extractor.write(chunk),
    );
    const metadata = extractor.end();
    if (metadata.name !== name || !metadata.versionsIsObject) throw new Error("invalid_metadata");
    return metadata;
  } catch (err) {
    // A malformed document (`PackumentStreamError`) is unavailable evidence.
    const tooLarge = err instanceof PublicEvidenceError && err.code === "too_large";
    throw new MetadataError(
      tooLarge ? "registry_metadata_too_large" : "registry_evidence_unavailable",
    );
  }
}

async function hashPublishedArtifact(
  value: PackumentVersion | null | undefined,
  name: string,
  version: string,
  registry: string,
  limits: { deadlineMs: number; meter: ByteMeter },
): Promise<PublishedDigests | ArtifactUnavailableReason> {
  if (!value || value.name !== name || value.version !== version || value.tarball === null)
    return "artifact_identity_invalid";
  let url: URL;
  try {
    url = new URL(value.tarball);
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
    await consumePublicResponse(url.href, { maxBytes: TARBALL_LIMIT, ...limits }, (chunk) => {
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

/**
 * A check that failed after claiming its watch. It has already been recorded
 * on the watch (`check_failed`) and logged, so the sweep only counts it.
 */
class RecordedCheckFailure extends Error {
  constructor(readonly cause: unknown) {
    super("publication_check_failed");
  }
}

export async function checkNpmPublicationWatch(
  db: AppDb,
  env: Cloudflare.Env,
  watch: PublicationWatch,
  options: { monitoringEnabled?: boolean; meter?: ByteMeter } = {},
) {
  const now = new Date();
  // Claim first, before anything that can return early or throw. The lease
  // makes manual checks and overlapping cron invocations share the bound, and
  // it moves a switched-off or failing watch to the back of the sweep order
  // instead of leaving it the oldest forever. It also marks the check
  // unfinished until its outcome is written, so a running or killed check
  // never inherits the previous check's clean result.
  const claimed = await db
    .update(publicationWatches)
    .set({ lastCheckedAt: now, lastError: "check_in_progress" })
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
  try {
    const enabled =
      options.monitoringEnabled ?? (await publicationMonitoringEnabled(env, watch.organizationId));
    if (!enabled) {
      await setLastError(db, watch, "monitoring_disabled");
      return getPublicationWatch(db, watch.organizationId, watch.id);
    }
    const { lastError, attempted, watchGap } = await examineReleases(
      db,
      env,
      watch,
      now,
      options.meter ?? { bytes: 0 },
    );
    await redeliverPendingAlerts(env, db, watch, attempted, now);
    // A read that got past the package document clears a package-wide gap; a
    // failed read records one only when none is recorded, so an outage never
    // resets how long a persistent gap has lasted.
    await recordWatchCoverageGap(db, watch, watchGap, now, {
      weak: watchGap === TRANSIENT_WATCH_PROBLEM,
    });
    await notifyCoverageGaps(env, db, watch, now);
    await setLastError(db, watch, lastError);
    return getPublicationWatch(db, watch.organizationId, watch.id);
  } catch (err) {
    // The claim already moved the watch; record why, so neither the dashboard
    // nor the package page reads a coverage claim from a check that failed.
    await recordWatchFailure(db, watch, err);
    throw new RecordedCheckFailure(err);
  }
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

const DIST_TAG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Which dist-tags point at each version right now, tags sorted, or null when
 * npm listed more tags than the monitor reads: an incomplete list would read
 * as "not latest" when it is only unknown. The packument is untrusted, so
 * malformed tag names are dropped rather than stored.
 */
function distTagsByVersion(metadata: PackumentExtract): Map<string, string[]> | null {
  if (metadata.distTagsTruncated) return null;
  const byVersion = new Map<string, string[]>();
  for (const [tag, version] of metadata.distTags) {
    if (!DIST_TAG_NAME.test(tag)) continue;
    byVersion.set(version, [...(byVersion.get(version) ?? []), tag].sort());
  }
  return byVersion;
}

function tagsFor(tagsByVersion: ReadonlyMap<string, string[]> | null, version: string) {
  return tagsByVersion ? (tagsByVersion.get(version) ?? []) : null;
}

function sameTags(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

/**
 * Keep every observation's dist-tags current, settled ones included, so a
 * reader can tell which release line a version is on today. Only rows whose
 * tags changed are written; the watch records when they were read.
 */
async function refreshObservedDistTags(
  db: AppDb,
  watch: PublicationWatch,
  observed: readonly ObservedRelease[],
  tagsByVersion: ReadonlyMap<string, string[]> | null,
  now: Date,
) {
  const updates = observed.flatMap((row) => {
    const tags = tagsFor(tagsByVersion, row.version);
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
  await db.update(publicationWatches).set({ distTagsCheckedAt: now }).where(watchKey(watch));
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

/** Bytes a previous check already established for this immutable version. */
function storedArtifact(
  previous: ObservedRelease | undefined,
): PublishedDigests | ArtifactUnavailableReason | null {
  if (previous?.sha1 && previous.sha256) return { sha1: previous.sha1, sha256: previous.sha256 };
  return previous?.reason === "artifact_too_large" ? "artifact_too_large" : null;
}

const reviewEvidenceColumns = {
  id: scans.id,
  source: scans.source,
  registryUrl: scans.registryUrl,
  registryPackageName: scans.registryPackageName,
  registryVersion: scans.registryVersion,
  registryStatusSupersededAt: scans.registryStatusSupersededAt,
  stagedDeclaredSha1: scans.stagedDeclaredSha1,
  packageName: scans.packageName,
  stagedVersion: scans.stagedVersion,
  decision: scans.decision,
  decidedAt: scans.decidedAt,
  summaryJson: scans.summaryJson,
  status: scans.status,
} satisfies Record<keyof ReviewEvidence, unknown>;

/**
 * The organization's release-path records of one version: staged reviews and
 * workflow gates, never published-pair reviews. Every decided record is read
 * (up to a bound no person reaches), newest decision first, and the newest
 * undecided ones; `historyLimited` says either bound was hit, so a flood of
 * records (a gate re-run for one version, say) can neither settle the release
 * nor push a decision out of view.
 */
async function releaseHistory(db: AppDb, watch: PublicationWatch, version: string) {
  const releaseOf = and(
    eq(scans.organizationId, watch.organizationId),
    eq(scans.packageName, watch.packageName),
    eq(scans.stagedVersion, version),
    inArray(scans.source, ["manual", "auto_discovery", "workflow_gate"]),
  );
  const [decided, undecided] = await Promise.all([
    db
      .select(reviewEvidenceColumns)
      .from(scans)
      .where(and(releaseOf, isNotNull(scans.decision)))
      .orderBy(desc(scans.decidedAt), desc(scans.id))
      .limit(DECIDED_HISTORY_LIMIT + 1),
    db
      .select(reviewEvidenceColumns)
      .from(scans)
      .where(and(releaseOf, isNull(scans.decision)))
      .orderBy(desc(scans.createdAt), desc(scans.id))
      .limit(UNDECIDED_HISTORY_LIMIT + 1),
  ]);
  return {
    reviews: [
      ...decided.slice(0, DECIDED_HISTORY_LIMIT),
      ...undecided.slice(0, UNDECIDED_HISTORY_LIMIT),
    ],
    historyLimited:
      decided.length > DECIDED_HISTORY_LIMIT || undecided.length > UNDECIDED_HISTORY_LIMIT,
  };
}

interface Examination {
  lastError: string | null;
  attempted: Set<string>;
  /**
   * The package-wide reason some release cannot be verified, or null when
   * npm's document was read and every version could be considered.
   */
  watchGap: string | null;
}

// npm versions are semver, at most 256 characters.
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/;

async function examineReleases(
  db: AppDb,
  env: Cloudflare.Env,
  watch: PublicationWatch,
  now: Date,
  meter: ByteMeter,
): Promise<Examination> {
  const registry = npmPublicationRegistry(env);
  const attempted = new Set<string>();
  let lastError: string | null = null;
  const note = (problem: string) => {
    lastError ??= problem;
  };
  const failed = (problem: string): Examination => {
    emitOperationalEvent("warn", "npm.publication_monitor.check_failed", {
      organizationId: watch.organizationId,
      watchId: watch.id,
      reason: problem,
    });
    return {
      lastError: problem,
      attempted,
      watchGap:
        PERSISTENT_WATCH_PROBLEMS.has(problem) || problem === TRANSIENT_WATCH_PROBLEM
          ? problem
          : null,
    };
  };
  let metadata: PackumentExtract;
  try {
    metadata = await fetchMetadata(watch.packageName, registry, meter);
  } catch (err) {
    return failed(err instanceof MetadataError ? err.reason : "registry_evidence_unavailable");
  }
  const observed: ObservedRelease[] = await db
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
    .limit(MAX_VERSIONS + 1);
  if (
    observed.length > MAX_VERSIONS ||
    metadata.versionLimitExceeded ||
    metadata.versions.size > MAX_VERSIONS
  ) {
    return failed("publication_history_limit");
  }
  const versionKeys: Record<string, true> = Object.fromEntries(
    [...metadata.versions.keys()].map((version) => [version, true as const]),
  );
  const tagsByVersion = distTagsByVersion(metadata);
  await refreshObservedDistTags(db, watch, observed, tagsByVersion, now);
  const existing = new Map(observed.map((item) => [item.version, item]));
  const pending: { version: string; publishedAt: Date | null; previous?: ObservedRelease }[] = [];
  // A version the monitor cannot consider is never skipped quietly: it is a
  // coverage gap, reported like any other once it persists.
  let unconsidered = metadata.oversizedVersionKey;
  for (const version of metadata.versions.keys()) {
    const rawTime = metadata.time.get(version);
    const millis = typeof rawTime === "string" ? Date.parse(rawTime) : NaN;
    const publishedAt = Number.isFinite(millis) && millis <= Date.now() ? new Date(millis) : null;
    if (publishedAt && publishedAt < watch.createdAt) continue;
    if (!VERSION_PATTERN.test(version)) {
      unconsidered = true;
      continue;
    }
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

  if (unconsidered) note("invalid_version_metadata");
  let examined = 0;
  let lookups = 0;
  let downloads = 0;
  let downloadDeadline: number | null = null;
  for (const item of pending) {
    if (examined >= RELEASES_PER_CHECK || lookups >= HISTORY_LOOKUPS_PER_CHECK) {
      note("pending_release_backlog");
      break;
    }
    lookups++;
    const { reviews, historyLimited } = await releaseHistory(db, watch, item.version);
    const entry = metadata.versions.get(item.version);
    let digests: PublishedDigests | null = null;
    // Bytes matter only against a Drydock record of this release; a release
    // with none is decided without downloading it.
    let artifact = storedArtifact(item.previous);
    if (
      artifact === null &&
      item.publishedAt &&
      releaseRecords(watch.packageName, item.version, reviews, registry).length > 0
    ) {
      downloadDeadline ??= Date.now() + DOWNLOAD_BUDGET_MS;
      const remainingMs = Math.min(TARBALL_DEADLINE_MS, downloadDeadline - Date.now());
      if (
        downloads >= TARBALLS_PER_CHECK ||
        remainingMs < 1_000 ||
        meter.bytes >= SWEEP_BYTE_BUDGET
      ) {
        note("pending_release_backlog");
        continue;
      }
      downloads++;
      // A download cut short by the shared deadline is a timeout: a release it
      // leaves unknown is retried on a later check, never settled as unknown.
      artifact = await hashPublishedArtifact(entry, watch.packageName, item.version, registry, {
        deadlineMs: remainingMs,
        meter,
      });
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
    const verdict: Verdict = classifyPublication(
      watch.packageName,
      item.version,
      item.publishedAt,
      artifact,
      reviews,
      // npm's own `dist.shasum`, used only one-sidedly (never as an approval).
      { registry, declaredSha1: entry?.shasum ?? null, historyLimited },
    );
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
        previousVersion: previousPublishedVersion(versionKeys, item.version),
        distTags: tagsFor(tagsByVersion, item.version),
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
        version: item.version,
        status: verdict.status,
        reason: verdict.reason,
      });
    }
  }
  return { lastError, attempted, watchGap: unconsidered ? "invalid_version_metadata" : null };
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
  const meter: ByteMeter = { bytes: 0 };
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
      if (started >= budget || Date.now() > deadline || meter.bytes >= SWEEP_BYTE_BUDGET) {
        counts.skipped++;
        return;
      }
      started++;
      await checkNpmPublicationWatch(db, env, watch, { monitoringEnabled: true, meter });
      counts.checked++;
    } catch (err) {
      counts.failed++;
      if (!(err instanceof RecordedCheckFailure)) await recordWatchFailure(db, watch, err);
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
