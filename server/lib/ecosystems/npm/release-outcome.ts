import { type AppDb } from "../../../db/client";
import { getNpmConnection } from "../../../db/npm-connections";
import {
  getScanReleaseIdentity,
  listScansAwaitingRegistryStatus,
  markRegistryPublishReminderSent,
  recordRegistryVersionStatus,
  supersedeRegistryReleaseIncarnations,
  type RegistryStatusCandidate,
} from "../../../db/scans";
import { notifyStagedReleaseAwaitingApproval } from "../../notify";
import { allowInsecureLocalRegistry, decryptNpmToken } from "./connection";
import { emitOperationalEvent } from "../../platform/observability";
import { fetchNpmVersionStatus, type NpmVersionStatus } from "./version-status";

/**
 * Where a reviewed release actually stands with npm.
 *
 * Two things the registry knows and Drydock previously did not. First, npm runs
 * its own automated validation on a staged version — a reviewer looking at a
 * green Drydock report has no way to see that npm has `blocked` the same
 * version, or is still `validating` it. Second, a staged publish leaves
 * `/-/stage` the moment it is approved, discarded, or blocked, and the registry
 * never says which; without asking, `decision` records what the organization
 * decided and nothing records whether that decision took effect.
 *
 * The most common way it does not take effect is the boring one: someone
 * approves the release in Drydock, never runs npm's own approve, and the
 * version sits staged. Catching that is what the reminder here is for.
 */

// One sweep's lookup budget per organization. npm documents 429 on this
// endpoint and the sweep runs every 15 minutes across every connected
// organization, so the ceiling is per-org-per-tick rather than "however many
// are outstanding". A backlog drains over successive ticks.
// Four worst-case five-second lookup waves leave roughly ten seconds inside
// Workers' 30-second waitUntil lifetime for D1 writes and notification delivery.
const LOOKUPS_PER_SWEEP = 16;
const LOOKUP_CONCURRENCY = 4;

// A version npm is still validating resolves in minutes, so it is re-asked on
// roughly every sweep. One parked waiting on a human does not, so it is re-asked
// hourly — often enough for the forgotten-approval nudge to be timely, rarely
// enough that a long-lived stage costs ~24 lookups a day instead of ~96. Both
// are floors rather than schedules: the on-demand "Check npm" button runs this
// too, so "due every sweep" must not mean "due on every button press".
const PENDING_RECHECK_MS = 5 * 60 * 1000;
const STAGED_RECHECK_MS = 60 * 60 * 1000;
// A published version can still be removed. Rechecking daily during the
// bounded release window catches that transition without polling the much
// larger published set on every discovery sweep.
const PUBLISHED_RECHECK_MS = 24 * 60 * 60 * 1000;

// Releases older than this stop being asked about at all. A state we could not
// resolve in a month is not going to resolve, and the alternative is re-asking
// about every scan the organization has ever run, forever.
const MAX_RELEASE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// How long an approved-here release may sit staged on npm before the nudge.
// Long enough that finishing the publish in the next few minutes — the normal
// case — never triggers it.
const FORGOTTEN_APPROVAL_DELAY_MS = 6 * 60 * 60 * 1000;

export interface ResolveReleaseOutcomesInput {
  db: AppDb;
  env: Cloudflare.Env;
  organizationId: string;
  /** Owner used for notification routing and event attribution. */
  ownerUserId: string;
  connection: { token: string; registryUrl: string };
  /** Current stage incarnations from the discovery response, when available. */
  stagedItems?: readonly {
    id: string;
    packageName: string | null;
    version: string | null;
  }[];
  allowInsecureLocalhost?: boolean;
  now?: Date;
  /** Override the per-invocation lookup slice for a shared scheduled sweep. */
  lookupLimit?: number;
  /** Override lookup fan-out when several organizations share one invocation. */
  lookupConcurrency?: number;
}

export interface ResolveReleaseOutcomesResult {
  /** Lookups attempted. */
  checked: number;
  /** Lookups that produced a status. */
  resolved: number;
  /** Resolved statuses by value, for the operational event. */
  statuses: Partial<Record<NpmVersionStatus, number>>;
  /** Forgotten-approval nudges sent this sweep. */
  reminded: number;
}

/**
 * Resolve and persist npm's state for completed reviews, and nudge on releases
 * approved here that npm is still holding.
 *
 * Best-effort throughout: a failed lookup writes only the attempt timestamp, so
 * the scan keeps a null status and is re-asked later rather than being recorded
 * as anything. That asymmetry is the point — npm answers 404 both for a version
 * that does not exist and for one this token may not ask about, so "no answer"
 * must never become a displayed verdict.
 */
export async function resolveNpmReleaseOutcomes(
  input: ResolveReleaseOutcomesInput,
): Promise<ResolveReleaseOutcomesResult> {
  const { db, env, organizationId, ownerUserId, connection, allowInsecureLocalhost } = input;
  const now = input.now ?? new Date();
  const result: ResolveReleaseOutcomesResult = {
    checked: 0,
    resolved: 0,
    statuses: {},
    reminded: 0,
  };

  // npm returns the staged listing newest-first. Preserve the first stage for
  // each coordinate so an older duplicate later in the response cannot retire
  // the current incarnation or make its historical scan eligible again.
  const currentStages = new Map<
    string,
    NonNullable<ResolveReleaseOutcomesInput["stagedItems"]>[number]
  >();
  for (const item of input.stagedItems ?? []) {
    if (!item.packageName || !item.version) continue;
    const key = releaseCoordinateKey(item.packageName, item.version);
    if (!currentStages.has(key)) currentStages.set(key, item);
  }
  if (currentStages.size) {
    await supersedeRegistryReleaseIncarnations(db, {
      organizationId,
      registryUrl: connection.registryUrl,
      releases: [...currentStages.values()].map((item) => ({
        stageId: item.id,
        packageName: item.packageName!,
        version: item.version!,
      })),
      supersededAt: now,
    });
  }

  const due = await listScansAwaitingRegistryStatus(db, organizationId, {
    limit: input.lookupLimit ?? LOOKUPS_PER_SWEEP,
    registryUrl: connection.registryUrl,
    createdAfter: new Date(now.getTime() - MAX_RELEASE_AGE_MS),
    rules: [
      // Never asked, and mid-validation, are both "in flight": ask often.
      { status: null, recheckBefore: new Date(now.getTime() - PENDING_RECHECK_MS) },
      { status: "validating", recheckBefore: new Date(now.getTime() - PENDING_RECHECK_MS) },
      { status: "staged", recheckBefore: new Date(now.getTime() - STAGED_RECHECK_MS) },
      { status: "published", recheckBefore: new Date(now.getTime() - PUBLISHED_RECHECK_MS) },
    ],
  });
  // npm permits a rejected version to be staged again under a new id. The
  // current listing is an extra fail-closed guard for the brief window before
  // a newly discovered incarnation has a scan row of its own.
  const eligible = due.filter((candidate) => {
    const currentStageId = currentStages.get(
      releaseCoordinateKey(candidate.packageName, candidate.stagedVersion),
    );
    return !currentStageId || currentStageId.id === candidate.stageId;
  });
  if (!eligible.length) return result;
  result.checked = eligible.length;

  await runWithConcurrency(
    eligible,
    input.lookupConcurrency ?? LOOKUP_CONCURRENCY,
    async (candidate) => {
      const lookup = await fetchNpmVersionStatus(
        connection.registryUrl,
        connection.token,
        candidate.packageName,
        candidate.stagedVersion,
        { allowInsecureLocalhost },
      );
      const status = lookup.ok ? lookup.status : null;

      try {
        const persisted = await recordRegistryVersionStatus(db, {
          scanId: candidate.id,
          organizationId,
          status,
          // The sweep's own clock, not each lookup's: one coherent stamp per
          // batch keeps an injected clock meaningful and the recheck floors exact.
          checkedAt: now,
        });
        if (!persisted) return;
      } catch (err) {
        // A write failure just means this scan is retried next sweep. The rest of
        // the batch is unaffected and must not be abandoned for it.
        emitOperationalEvent("warn", "npm.release_outcome.persist_failed", {
          organizationId,
          scanId: candidate.id,
          error: err instanceof Error ? err.name : "unknown",
        });
        return;
      }

      if (!status) return;
      result.resolved += 1;
      result.statuses[status] = (result.statuses[status] ?? 0) + 1;

      if (!shouldRemindAboutForgottenApproval(candidate, status, now)) return;
      if (!candidate.decidedAt) return;
      // Claim the send before sending, so two overlapping sweeps cannot both
      // email about the same release. A failed send costs the reminder rather
      // than risking a duplicate — the release is still visible in the workbench.
      const claimed = await markRegistryPublishReminderSent(db, {
        scanId: candidate.id,
        organizationId,
        expectedDecidedAt: candidate.decidedAt,
        expectedRegistryStatusAt: now,
        sentAt: now,
      });
      if (!claimed) return;
      result.reminded += 1;
      await notifyStagedReleaseAwaitingApproval({
        env,
        db,
        organizationId,
        ownerUserId,
        scanId: candidate.id,
        stageId: candidate.stageId,
        packageName: candidate.packageName,
        version: candidate.stagedVersion,
        decidedAt: candidate.decidedAt,
        registryUrl: connection.registryUrl,
      });
    },
  );

  return result;
}

/**
 * What npm's lifecycle status means for a review whose staged tarball we could
 * not read.
 *
 * `staged` and `validating` are absent on purpose: the release is still there
 * and we still could not read it, which is the token-scope problem the
 * unrefined classification already describes correctly.
 */
const RELEASE_OUTCOME_FAILURES: Partial<Record<NpmVersionStatus, StagedReleaseFailure>> = {
  published: {
    code: "staged_release_published",
    message: "This version was approved and published to npm before the review could read it.",
  },
  deleted: {
    code: "staged_release_deleted",
    message: "This version was published to npm and then removed before the review could read it.",
  },
  blocked: {
    code: "staged_release_blocked",
    message: "npm blocked this version during its own validation, so its staged bytes are gone.",
  },
};

interface StagedReleaseFailure {
  code: string;
  message: string;
}

export interface StagedReleaseFate {
  status: NpmVersionStatus;
  /** Set only when the status explains a staged tarball that could not be read. */
  failure: StagedReleaseFailure | null;
}

/**
 * Ask npm what actually became of the release a scan was trying to review.
 *
 * The caller reaches here holding `staged_tarball_unavailable`, which covers
 * 401, 403 and 404 on the stage tarball and whose message blames the
 * organization's token. That is right for 401 and 403 but usually wrong for
 * 404, which is what you get when the maintainer approved the release seconds
 * after discovery queued the scan. Telling someone to rotate a working token
 * because their publish succeeded is the failure mode this removes.
 *
 * Returns null on any problem reaching npm, so the caller keeps its original
 * classification: this can only make a message more accurate, never invent one.
 */
export async function lookupStagedReleaseFate(
  env: Cloudflare.Env,
  db: AppDb,
  scanId: string,
  organizationId: string,
): Promise<StagedReleaseFate | null> {
  try {
    const identity = await getScanReleaseIdentity(db, scanId, organizationId);
    if (
      !identity?.packageName ||
      !identity.stagedVersion ||
      !identity.registryUrl ||
      identity.registryStatusSupersededAt
    ) {
      return null;
    }
    const connection = await getNpmConnection(db, organizationId);
    if (!connection || connection.registryUrl !== identity.registryUrl) return null;
    const token = await decryptNpmToken(env, connection);
    const lookup = await fetchNpmVersionStatus(
      connection.registryUrl,
      token,
      identity.packageName,
      identity.stagedVersion,
      { allowInsecureLocalhost: allowInsecureLocalRegistry(env) },
    );
    if (!lookup.ok) return null;
    const currentIdentity = await getScanReleaseIdentity(db, scanId, organizationId);
    if (
      !currentIdentity ||
      currentIdentity.registryStatusSupersededAt ||
      currentIdentity.packageName !== identity.packageName ||
      currentIdentity.stagedVersion !== identity.stagedVersion ||
      currentIdentity.registryUrl !== identity.registryUrl
    ) {
      return null;
    }
    return { status: lookup.status, failure: RELEASE_OUTCOME_FAILURES[lookup.status] ?? null };
  } catch {
    // Decryption, D1, or the registry — none of it changes what already went
    // wrong with the scan, and the caller is mid-failure-handling.
    return null;
  }
}

function releaseCoordinateKey(packageName: string, version: string): string {
  return JSON.stringify([packageName, version]);
}

/**
 * Whether this release is one the organization approved and npm is still
 * holding.
 *
 * All four conditions matter. The approval has to be ours (`decision`), npm has
 * to still be waiting (`staged` — not `validating`, which is npm working, not a
 * human forgetting), enough time has to have passed that this is not simply a
 * publish in progress, and we must not have said so already.
 */
export function shouldRemindAboutForgottenApproval(
  candidate: Pick<RegistryStatusCandidate, "decision" | "decidedAt" | "registryPublishReminderAt">,
  status: NpmVersionStatus,
  now: Date,
): boolean {
  if (status !== "staged") return false;
  if (candidate.decision !== "publish") return false;
  if (candidate.registryPublishReminderAt) return false;
  const decidedAt = candidate.decidedAt ? new Date(candidate.decidedAt).getTime() : null;
  if (decidedAt === null || Number.isNaN(decidedAt)) return false;
  return now.getTime() - decidedAt >= FORGOTTEN_APPROVAL_DELAY_MS;
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item === undefined) continue;
      try {
        await worker(item);
      } catch {
        // Deliberately swallowed: one unresolvable release must not stop the
        // rest of the batch, and every failure mode here is retried next sweep.
      }
    }
  });
  await Promise.all(runners);
}
