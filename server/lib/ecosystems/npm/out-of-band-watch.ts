import { type AppDb } from "../../../db/client";
import {
  createPackageWatch,
  hasScanForRelease,
  listPackageWatches,
  listWatchTargets,
  recordOutOfBandPublish,
  updatePackageWatchVersions,
  type PackageWatchRow,
} from "../../../db/package-watch";
import { recordScanEvent } from "../../../db/events";
import { mapWithConcurrency } from "../../platform/concurrency";
import { recordProductEvent } from "../../platform/analytics";
import { describeOperationalError, emitOperationalEvent } from "../../platform/observability";
import { notifyOutOfBandPublish } from "../../notify";
import { fetchPackageMetadata, isValidNpmPackageName, type RegistryMetadata } from "./registry";
import { fetchNpmVersionStatus, type NpmVersionStatusLookup } from "./version-status";
import type { TokenForDiscovery } from "./staged-publishes-discovery";

// The 50 most recently reviewed packages are watched; 20 packuments per sweep
// round-robin through them (worst case a package is rechecked every 30
// minutes on the 15-minute cron). Candidates per package are capped so one
// mass-publish cannot spend the sweep's status-lookup budget by itself.
const WATCH_TARGET_LIMIT = 50;
const WATCH_CHECK_LIMIT = 20;
const WATCH_FETCH_CONCURRENCY = 3;
const CANDIDATE_LIMIT = 5;

export type OutOfBandCandidateDecision =
  | "alarm-confirmed"
  | "alarm-unconfirmed"
  | "defer"
  | "ignore";

/**
 * What to do about a version that is in the public packument but has no
 * review. The packument presence is the evidence; npm's version-status lookup
 * only refines it. A failed lookup (custom registry without the endpoint, an
 * outage, npm's irreducibly ambiguous 404) must therefore not silence the
 * alarm — except `rejected`/`incomplete_input`, which mean the coordinates
 * themselves are malformed and nothing safe can be said or rendered about them.
 */
export function decideOutOfBandCandidate(
  lookup: NpmVersionStatusLookup,
): OutOfBandCandidateDecision {
  if (lookup.ok) {
    if (lookup.status === "published") return "alarm-confirmed";
    if (lookup.status === "blocked" || lookup.status === "deleted") return "ignore";
    // staged / validating: npm has not made it public; recheck next sweep.
    return "defer";
  }
  if (lookup.reason === "rejected" || lookup.reason === "incomplete_input") return "ignore";
  return "alarm-unconfirmed";
}

export interface SweepOutOfBandPublishesInput {
  db: AppDb;
  env: Cloudflare.Env;
  organizationId: string;
  actorUserId: string;
  connection: TokenForDiscovery;
  allowInsecureLocalhost?: boolean;
}

export interface SweepOutOfBandPublishesResult {
  enabled: boolean;
  watched: number;
  checked: number;
  detected: number;
}

/**
 * Detect versions of previously reviewed packages that reached the public
 * registry without any Drydock review — the fingerprint of a publish that
 * routed around both the staged path and the workflow gate (a laptop publish,
 * a re-enabled token, an account takeover). Advisory by design: it changes no
 * scan, risk, or gate state; it records an alarm row, an audit event, and a
 * send-once email/Slack notification.
 */
export async function sweepOutOfBandPublishes(
  input: SweepOutOfBandPublishesInput,
): Promise<SweepOutOfBandPublishesResult> {
  const { db, env, organizationId, connection } = input;

  // Unlike ai-review (a paid dependency, default-off without the binding),
  // this sweep is deterministic registry metadata, so self-hosters without
  // Flagship get it; the flag exists as an operator killswitch.
  const enabled = env.FLAGS
    ? await env.FLAGS.getBooleanValue("out-of-band-watch", true, {
        targetingKey: organizationId,
        organizationId,
      })
    : true;
  if (!enabled) return { enabled: false, watched: 0, checked: 0, detected: 0 };

  const targets = (
    await listWatchTargets(db, organizationId, connection.registryUrl, WATCH_TARGET_LIMIT)
  ).filter(isValidNpmPackageName);
  if (!targets.length) return { enabled: true, watched: 0, checked: 0, detected: 0 };

  const watchByName = new Map<string, PackageWatchRow>();
  for (const watch of await listPackageWatches(
    db,
    organizationId,
    connection.registryUrl,
    targets,
  )) {
    watchByName.set(watch.packageName, watch);
  }
  // Unwatched packages first (they only get a baseline), then stalest checks.
  const ordered = [...targets].sort((a, b) => {
    const aChecked = watchByName.get(a)?.lastCheckedAt?.getTime() ?? -1;
    const bChecked = watchByName.get(b)?.lastCheckedAt?.getTime() ?? -1;
    return aChecked - bChecked;
  });
  const selected = ordered.slice(0, WATCH_CHECK_LIMIT);

  const detections = await mapWithConcurrency(selected, WATCH_FETCH_CONCURRENCY, async (name) => {
    try {
      return await checkPackage(input, watchByName.get(name) ?? null, name);
    } catch (err) {
      emitOperationalEvent("warn", "package_watch.package_failed", {
        organizationId,
        packageName: name,
        error: describeOperationalError(err),
      });
      return 0;
    }
  });

  const result = {
    enabled: true,
    watched: targets.length,
    checked: selected.length,
    detected: detections.reduce((sum, count) => sum + count, 0),
  };
  if (result.detected > 0) {
    emitOperationalEvent("warn", "package_watch.out_of_band_detected", {
      organizationId,
      ...result,
    });
  }
  return result;
}

// A package that has only ever been staged has no public packument yet; that
// 404 recurs every sweep and means "no public versions", not a failure.
async function fetchWatchedPackument(
  env: Cloudflare.Env,
  packageName: string,
  connection: TokenForDiscovery,
): Promise<RegistryMetadata> {
  try {
    return await fetchPackageMetadata(env, packageName, {
      npmToken: connection.token,
      npmRegistry: connection.registryUrl,
      abbreviated: true,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "metadata fetch failed: 404") return {};
    throw err;
  }
}

async function checkPackage(
  input: SweepOutOfBandPublishesInput,
  watch: PackageWatchRow | null,
  packageName: string,
): Promise<number> {
  const { db, env, organizationId, actorUserId, connection, allowInsecureLocalhost } = input;
  const now = new Date();
  const metadata = await fetchWatchedPackument(env, packageName, connection);
  const publicVersions = Object.keys(metadata.versions ?? {});

  if (!watch) {
    // First sighting: everything already public predates the watch and is
    // baseline, never an alarm.
    await createPackageWatch(db, {
      organizationId,
      registryUrl: connection.registryUrl,
      packageName,
      versions: publicVersions,
      checkedAt: now,
    });
    return 0;
  }

  const accounted = new Set(watch.versions);
  const candidates = publicVersions.filter((version) => !accounted.has(version)).sort();
  let detected = 0;

  for (const version of candidates.slice(0, CANDIDATE_LIMIT)) {
    if (await hasScanForRelease(db, organizationId, connection.registryUrl, packageName, version)) {
      accounted.add(version);
      continue;
    }
    const lookup = await fetchNpmVersionStatus(
      connection.registryUrl,
      connection.token,
      packageName,
      version,
      { allowInsecureLocalhost },
    );
    const decision = decideOutOfBandCandidate(lookup);
    if (decision === "defer") continue;
    accounted.add(version);
    if (decision === "ignore") continue;

    const statusConfirmed = decision === "alarm-confirmed";
    const created = await recordOutOfBandPublish(db, {
      organizationId,
      registryUrl: connection.registryUrl,
      packageName,
      version,
      statusConfirmed,
      detectedAt: now,
    });
    if (!created) continue;
    detected += 1;
    recordProductEvent(env, {
      name: "package_watch.out_of_band",
      organizationId,
      ecosystem: "npm",
    });
    await recordScanEvent(db, {
      organizationId,
      actorUserId,
      type: "package_watch.out_of_band_publish",
      metadata: {
        packageName,
        stagedVersion: version,
        registryUrl: connection.registryUrl,
        statusConfirmed,
      },
    });
    await notifyOutOfBandPublish({
      env,
      db,
      organizationId,
      ownerUserId: actorUserId,
      packageName,
      version,
      registryUrl: connection.registryUrl,
      statusConfirmed,
      detectedAt: now,
    });
  }

  await updatePackageWatchVersions(db, { id: watch.id, versions: [...accounted], checkedAt: now });
  return detected;
}
