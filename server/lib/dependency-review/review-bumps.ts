import { getPublicDiffAdapter } from "../ecosystems";
import { mapWithConcurrency } from "../platform/concurrency";
import { describeOperationalError, emitOperationalEvent } from "../platform/observability";
import {
  loadPublicPackageDiff,
  publicDiffEgressAllowed,
  PublicDiffError,
  readCachedPublicPackageDiff,
  type PublicDiffInput,
} from "../public-diff";
import type { PublicDiffVersionListing } from "../public-diff/types";
import type { ReviewContext } from "./context";
import { verifyMirrorBump } from "./mirror-identity";
import { extractBumpEvidence, needsReleaseAge } from "./policy";
import { bumpProgressKey, type ProgressWriter, type StoredBumpProgress } from "./progress";
import { MAX_STORED_BUMPS } from "./render";
import type { BumpOutcome, DependencyBump, DependencyReviewPolicy } from "./types";

// Per pass, against the queue consumer's 30 s CPU limit, which the Worker
// can't observe. A cold diff parses two tarballs in a sandbox isolate but runs
// the rules in this one, and the rules are the cost: over 362 real pairs
// (replay harness, local Node) cold-diff CPU had a median of 268 ms, p90
// 1.8 s, max 15.5 s, and a mean near 0.94 s on a 163-bump lockfile PR. Twelve
// keeps the mean near 11 s with room for one 15 s outlier. A cached pair is
// one KV read and costs none of this budget; cached reads still parse a
// payload each, so they get their own bound (not measured). Registry lookups
// (mirror proofs, publish times) share a third.
export const MAX_COLD_DIFFS_PER_PASS = 12;
const MAX_CACHED_READS_PER_PASS = 100;
const MAX_REGISTRY_LOOKUPS_PER_PASS = 150;
const DIFF_CONCURRENCY = 4;
// Under the queue consumer's wall-clock limit with room to post the result.
export const PASS_BUDGET_MS = 8 * 60 * 1000;

export interface ReviewStage {
  // The collected bumps, with mirror-proven ones turned into public bumps.
  bumps: DependencyBump[];
  // One per bump. Work this pass didn't reach reads as if no pass will:
  // `over-cap` for an undiffed pair, an unknown publish time, an unproven
  // mirror. The caller uses them only when no pass follows.
  outcomes: BumpOutcome[];
  settled: number;
  // Nothing is left for another pass.
  complete: boolean;
}

interface Entry {
  index: number;
  original: DependencyBump;
  key: string;
}

/**
 * One pass of the review stage over a PR's bumps, in collected order (direct
 * first). Up to `MAX_STORED_BUMPS` pairs are diffed across passes; each
 * outcome is recorded as it lands, so a pass the platform kills loses little.
 */
export async function runReviewStage(
  context: ReviewContext,
  bumps: readonly DependencyBump[],
  policy: DependencyReviewPolicy,
  writer: ProgressWriter,
  deadlineMs: number,
): Promise<ReviewStage> {
  const egress = publicDiffEgressAllowed(context.env);
  const stored = (key: string): StoredBumpProgress => writer.progress.bumps[key] ?? {};
  const entries: Entry[] = bumps.map((original, index) => ({
    index,
    original,
    key: bumpProgressKey(original),
  }));
  let lookups = 0;
  const lookupAllowed = () => lookups < MAX_REGISTRY_LOOKUPS_PER_PASS && Date.now() < deadlineMs;

  // A mirror entry becomes a public bump only once both sides are proven to
  // be the public registry's bytes; until then it is private.
  const unproven = entries.filter(
    (entry) => entry.original.mirror && stored(entry.key).mirrorVerified === undefined,
  );
  await mapWithConcurrency(unproven, DIFF_CONCURRENCY, async (entry) => {
    if (!egress) return writer.record(entry.key, { mirrorVerified: false });
    if (!lookupAllowed()) return;
    lookups += 1;
    let verified = false;
    try {
      verified = await verifyMirrorBump(context.env, context.ctx, entry.original);
    } catch (err) {
      emitOperationalEvent("warn", "dependency_review.mirror_check_failed", {
        organizationId: context.review.organizationId,
        reviewId: context.review.id,
        ecosystem: entry.original.ecosystem,
        error: describeOperationalError(err),
      });
    }
    await writer.record(entry.key, { mirrorVerified: verified });
  });

  const resolved = entries.map((entry) => resolveBump(entry.original, stored(entry.key)));
  // The cap counts diffable pairs in order, unproven mirrors included, so
  // proving a mirror later can't reorder what an earlier pass diffed.
  const inCap = new Set<number>();
  for (const entry of entries) {
    if (inCap.size >= MAX_STORED_BUMPS) break;
    const bump = resolved[entry.index];
    if (bump && !bump.privateSource && bump.fromVersion !== null) inCap.add(entry.index);
    else if (bump === null && entry.original.fromVersion !== null) inCap.add(entry.index);
  }

  let coldStarted = 0;
  let cachedReads = 0;
  const toDiff = entries.filter((entry) => {
    const bump = resolved[entry.index];
    const progress = stored(entry.key);
    return (
      bump !== null &&
      inCap.has(entry.index) &&
      !progress.evidence &&
      progress.unreviewed === undefined
    );
  });
  await mapWithConcurrency(toDiff, DIFF_CONCURRENCY, async (entry) => {
    if (Date.now() >= deadlineMs || cachedReads >= MAX_CACHED_READS_PER_PASS) return;
    const bump = resolved[entry.index] as DependencyBump;
    const input = egress ? diffInput(bump) : null;
    if (!input) return writer.record(entry.key, { unreviewed: "unsupported" });
    let cold = false;
    let outcome: StoredBumpProgress;
    try {
      cachedReads += 1;
      let diff = await readCachedPublicPackageDiff(context.env, context.ctx, input);
      if (!diff) {
        if (coldStarted >= MAX_COLD_DIFFS_PER_PASS) return;
        coldStarted += 1;
        cold = true;
        diff = await loadPublicPackageDiff(context.env, context.ctx, input);
      }
      outcome = { evidence: extractBumpEvidence(diff) };
    } catch (err) {
      outcome = { unreviewed: diffFailure(context, bump, err) };
    }
    await writer.record(entry.key, outcome, { urgent: cold });
  });

  // Publish times, only for outcomes the policy would wait out, one registry
  // read per package within a pass.
  const listings = new Map<string, Promise<PublicDiffVersionListing | null>>();
  const outcomeOf = (entry: Entry) =>
    settledOutcome(entry, resolved[entry.index], stored(entry.key), inCap);
  const toDate = entries.filter((entry) => {
    if (entry.index >= MAX_STORED_BUMPS || stored(entry.key).publishedAt !== undefined) {
      return false;
    }
    const outcome = outcomeOf(entry);
    return outcome !== null && needsReleaseAge(outcome, policy);
  });
  await mapWithConcurrency(toDate, DIFF_CONCURRENCY, async (entry) => {
    const bump = resolved[entry.index] as DependencyBump;
    const adapter = getPublicDiffAdapter(bump.ecosystem);
    const listingKey = `${bump.ecosystem}\u0000${adapter?.normalizePackageName(bump.name) ?? bump.name}`;
    let listing = listings.get(listingKey);
    if (!listing) {
      if (!egress) return writer.record(entry.key, { publishedAt: null });
      if (!lookupAllowed()) return;
      lookups += 1;
      listing = listVersions(context, bump);
      listings.set(listingKey, listing);
    }
    await writer.record(entry.key, { publishedAt: publishedAtOf(bump, await listing) });
  });

  let pending = 0;
  const outcomes = entries.map((entry) => {
    const progress = stored(entry.key);
    const outcome = outcomeOf(entry);
    const needsDate =
      outcome !== null &&
      entry.index < MAX_STORED_BUMPS &&
      progress.publishedAt === undefined &&
      needsReleaseAge(outcome, policy);
    if (outcome === null || needsDate) pending += 1;
    return withPublishedAt(outcome ?? leftover(resolved[entry.index]), progress);
  });
  return {
    bumps: entries.map((entry) => resolved[entry.index] ?? entry.original),
    outcomes,
    settled: entries.length - pending,
    complete: pending === 0,
  };
}

// null: a mirror entry not yet proven either way.
function resolveBump(bump: DependencyBump, progress: StoredBumpProgress): DependencyBump | null {
  if (!bump.mirror) return bump;
  if (progress.mirrorVerified === undefined) return null;
  if (!progress.mirrorVerified) return bump;
  const { privateSource: _private, mirror: _mirror, remoteSource: _remote, ...rest } = bump;
  return { ...rest, viaMirror: true };
}

// The outcome once this bump's review work is done, or null while it isn't.
function settledOutcome(
  entry: Entry,
  bump: DependencyBump | null,
  progress: StoredBumpProgress,
  inCap: ReadonlySet<number>,
): BumpOutcome | null {
  if (bump === null) return null;
  if (bump.privateSource) {
    return { kind: "unreviewed", reason: bump.remoteSource ? "remote-source" : "private-source" };
  }
  if (bump.fromVersion === null) return { kind: "new-package" };
  if (!inCap.has(entry.index)) return { kind: "unreviewed", reason: "over-cap" };
  if (progress.evidence) return { kind: "diffed", evidence: progress.evidence };
  if (progress.unreviewed) return { kind: "unreviewed", reason: progress.unreviewed };
  return null;
}

// What unfinished work reads as when no pass follows: an unproven mirror
// stays private, an undiffed pair is over the cap.
function leftover(bump: DependencyBump | null): BumpOutcome {
  return { kind: "unreviewed", reason: bump === null ? "private-source" : "over-cap" };
}

function withPublishedAt(outcome: BumpOutcome, progress: StoredBumpProgress): BumpOutcome {
  return progress.publishedAt === undefined
    ? outcome
    : { ...outcome, publishedAt: progress.publishedAt };
}

function diffInput(bump: DependencyBump): PublicDiffInput | null {
  const adapter = getPublicDiffAdapter(bump.ecosystem);
  const fromVersion = bump.fromVersion;
  // npm's public diff also accepts preview URLs as versions; a lockfile
  // version never is one.
  if (
    !adapter ||
    fromVersion === null ||
    !adapter.isValidPackageName(bump.name) ||
    !adapter.isValidVersion(fromVersion) ||
    !adapter.isValidVersion(bump.toVersion) ||
    fromVersion.includes(":") ||
    bump.toVersion.includes(":")
  ) {
    return null;
  }
  return {
    ecosystem: adapter.ecosystem,
    packageName: adapter.normalizePackageName(bump.name),
    fromVersion,
    toVersion: bump.toVersion,
    registryUrl: adapter.registryUrl,
  };
}

function diffFailure(
  context: ReviewContext,
  bump: DependencyBump,
  err: unknown,
): NonNullable<StoredBumpProgress["unreviewed"]> {
  if (err instanceof PublicDiffError) {
    if (err.status === 404) return "not-found";
    if (err.status === 400 || err.status === 413) return "unsupported";
  }
  emitOperationalEvent("warn", "dependency_review.diff_failed", {
    organizationId: context.review.organizationId,
    reviewId: context.review.id,
    ecosystem: bump.ecosystem,
    error: describeOperationalError(err),
  });
  return "failed";
}

// Any failure reads as an unknown publish time, which the fallback holds.
async function listVersions(
  context: ReviewContext,
  bump: DependencyBump,
): Promise<PublicDiffVersionListing | null> {
  const adapter = getPublicDiffAdapter(bump.ecosystem);
  if (!adapter || !adapter.isValidPackageName(bump.name)) return null;
  try {
    return await adapter.listVersions(
      context.env,
      context.ctx,
      adapter.normalizePackageName(bump.name),
    );
  } catch {
    return null;
  }
}

/**
 * The target version's publish time from the public registry's own listing.
 * PyPI's listing reports a release's newest non-yanked upload, not its first:
 * files can be added to a release after it is published, and the age must run
 * from the newest bytes.
 */
function publishedAtOf(bump: DependencyBump, listing: PublicDiffVersionListing | null) {
  const adapter = getPublicDiffAdapter(bump.ecosystem);
  if (!adapter || !listing) return null;
  const same = adapter.versionsEquivalent ?? ((a: string, b: string) => a === b);
  const match = listing.versions.find((entry) => same(entry.version, bump.toVersion));
  return match?.publishedAt ?? null;
}
