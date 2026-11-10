import { and, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { bumpIdentityKey, changeKey, changeSource } from "../lib/dependency-review/identity";
import { parseDependencyReviewPolicy } from "../lib/dependency-review/policy";
import { emptyProgress } from "../lib/dependency-review/progress";
import type {
  DependencyBump,
  DependencyReviewConclusion,
  DependencyReviewPolicy,
  ReviewedBump,
} from "../lib/dependency-review/types";
import type { AppDb } from "./client";
import { chunkForD1 } from "./d1-chunk";
import type { DependencyReviewStatus } from "./enums";
import { dependencyReviewApprovals, dependencyReviewSettings, dependencyReviews } from "./schema";

export interface DependencyReviewSettings {
  enabled: boolean;
  policy: DependencyReviewPolicy;
  extraBotLogins: string[];
  updatedAt: Date | null;
}

// A GitHub login, optionally an app bot's `[bot]` login.
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
export const MAX_EXTRA_BOT_LOGINS = 10;

export function parseExtraBotLogins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const logins = value.filter(
    (entry): entry is string => typeof entry === "string" && GITHUB_LOGIN.test(entry),
  );
  return [...new Set(logins.map((login) => login.toLowerCase()))].slice(0, MAX_EXTRA_BOT_LOGINS);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function getDependencyReviewSettings(
  db: AppDb,
  organizationId: string,
): Promise<DependencyReviewSettings> {
  const [row] = await db
    .select()
    .from(dependencyReviewSettings)
    .where(eq(dependencyReviewSettings.organizationId, organizationId))
    .limit(1);
  if (!row) {
    return {
      enabled: false,
      policy: parseDependencyReviewPolicy({}),
      extraBotLogins: [],
      updatedAt: null,
    };
  }
  // A corrupt row reads as the defaults, which hold more, never less.
  return {
    enabled: row.enabled,
    policy: parseDependencyReviewPolicy(parseJson(row.policyJson)),
    extraBotLogins: parseExtraBotLogins(parseJson(row.extraBotLoginsJson)),
    updatedAt: row.updatedAt,
  };
}

export async function saveDependencyReviewSettings(
  db: AppDb,
  organizationId: string,
  input: { enabled: boolean; policy: DependencyReviewPolicy; extraBotLogins: string[] },
  userId: string,
): Promise<void> {
  const now = new Date();
  const policyJson = JSON.stringify(input.policy);
  const extraBotLoginsJson = JSON.stringify(parseExtraBotLogins(input.extraBotLogins));
  await db
    .insert(dependencyReviewSettings)
    .values({
      organizationId,
      enabled: input.enabled,
      policyJson,
      extraBotLoginsJson,
      updatedByUserId: userId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: dependencyReviewSettings.organizationId,
      set: {
        enabled: input.enabled,
        policyJson,
        extraBotLoginsJson,
        updatedByUserId: userId,
        updatedAt: now,
      },
    });
}

export interface DependencyReviewRecord {
  id: string;
  organizationId: string;
  installationRowId: string;
  repositoryId: number;
  repositoryFullName: string;
  pullNumber: number;
  headSha: string;
  authorLogin: string;
  checkRunId: number | null;
  status: DependencyReviewStatus;
  conclusion: DependencyReviewConclusion | null;
  bumpCount: number;
  heldCount: number;
  approvedByLogin: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

const RECORD_COLUMNS = {
  id: dependencyReviews.id,
  organizationId: dependencyReviews.organizationId,
  installationRowId: dependencyReviews.installationRowId,
  repositoryId: dependencyReviews.repositoryId,
  repositoryFullName: dependencyReviews.repositoryFullName,
  pullNumber: dependencyReviews.pullNumber,
  headSha: dependencyReviews.headSha,
  authorLogin: dependencyReviews.authorLogin,
  checkRunId: dependencyReviews.checkRunId,
  status: dependencyReviews.status,
  conclusion: dependencyReviews.conclusion,
  bumpCount: dependencyReviews.bumpCount,
  heldCount: dependencyReviews.heldCount,
  approvedByLogin: dependencyReviews.approvedByLogin,
  approvedAt: dependencyReviews.approvedAt,
  createdAt: dependencyReviews.createdAt,
  updatedAt: dependencyReviews.updatedAt,
  completedAt: dependencyReviews.completedAt,
};

export interface CreateDependencyReviewInput {
  organizationId: string;
  installationRowId: string;
  repositoryId: number;
  repositoryFullName: string;
  pullNumber: number;
  headSha: string;
  authorLogin: string;
}

/**
 * Insert the review for a head commit, or return the existing one: GitHub
 * redelivers webhooks, and `opened` plus `synchronize` can race for one sha.
 * Whether a review is still the PR's head is decided by the job against
 * GitHub, not here: webhooks arrive out of order and can be redelivered.
 */
export async function createDependencyReview(
  db: AppDb,
  input: CreateDependencyReviewInput,
): Promise<{ review: DependencyReviewRecord; created: boolean }> {
  const now = new Date();
  const id = crypto.randomUUID();
  const inserted = await db
    .insert(dependencyReviews)
    .values({ id, ...input, status: "queued", createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .returning(RECORD_COLUMNS);
  if (inserted[0]) return { review: inserted[0], created: true };
  const [existing] = await db
    .select(RECORD_COLUMNS)
    .from(dependencyReviews)
    .where(
      and(
        eq(dependencyReviews.installationRowId, input.installationRowId),
        eq(dependencyReviews.repositoryId, input.repositoryId),
        eq(dependencyReviews.headSha, input.headSha),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("dependency review insert conflicted but no row was found");
  return { review: existing, created: false };
}

export async function getDependencyReview(
  db: AppDb,
  organizationId: string,
  reviewId: string,
): Promise<DependencyReviewRecord | null> {
  const [row] = await db
    .select(RECORD_COLUMNS)
    .from(dependencyReviews)
    .where(
      and(eq(dependencyReviews.id, reviewId), eq(dependencyReviews.organizationId, organizationId)),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The review behind a check run, by the run's `external_id` (the review id the
 * job set on it) or, for a run created without one, its stored id. Either way
 * the review must belong to the installation and repository GitHub named.
 */
export async function getDependencyReviewByCheckRun(
  db: AppDb,
  installationRowId: string,
  repositoryId: number,
  checkRunId: number,
  externalId: string | null,
): Promise<DependencyReviewRecord | null> {
  const [row] = await db
    .select(RECORD_COLUMNS)
    .from(dependencyReviews)
    .where(
      and(
        eq(dependencyReviews.installationRowId, installationRowId),
        eq(dependencyReviews.repositoryId, repositoryId),
        externalId
          ? eq(dependencyReviews.id, externalId)
          : eq(dependencyReviews.checkRunId, checkRunId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The review of one head commit, whatever its status. */
export async function getDependencyReviewForHead(
  db: AppDb,
  installationRowId: string,
  repositoryId: number,
  headSha: string,
): Promise<DependencyReviewRecord | null> {
  const [row] = await db
    .select(RECORD_COLUMNS)
    .from(dependencyReviews)
    .where(
      and(
        eq(dependencyReviews.installationRowId, installationRowId),
        eq(dependencyReviews.repositoryId, repositoryId),
        eq(dependencyReviews.headSha, headSha),
      ),
    )
    .limit(1);
  return row ?? null;
}

// Longer than the job's diff budget plus posting, so a live run is never
// claimed twice; a run whose worker died is claimable again after it.
export const DEPENDENCY_REVIEW_LEASE_MS = 15 * 60 * 1000;

/**
 * Move a review to `running` for one pass. A queued, failed, or superseded
 * review can be claimed: the job checks the PR's live head first, so a
 * superseded review whose commit is the head again (reopened) is reviewed. A
 * completed one only for an explicit `rerun` (the Re-run button), or for an
 * age recheck of the held result still on `recheckOfRun`. A `continuation`
 * (the next pass) takes only a queued review or one whose lease expired. A duplicate message
 * for a review running inside its lease, or one already completed, exits
 * without posting another run.
 *
 * Returns the claim's `attempt`, which every write of the pass names, or null.
 * A queued review keeps its progress (the next pass of a multi-pass review);
 * a running one past its lease does too (its worker died mid-pass). Any other
 * claim starts the review over.
 */
export async function claimDependencyReviewAttempt(
  db: AppDb,
  reviewId: string,
  options: { rerun?: boolean; recheckOfRun?: number; continuation?: boolean; now?: Date } = {},
): Promise<number | null> {
  const now = options.now ?? new Date();
  const restart = Boolean(options.rerun) || options.recheckOfRun !== undefined;
  const claimable = (
    options.continuation
      ? ["queued"]
      : ["queued", "failed", "superseded", ...(options.rerun ? ["completed"] : [])]
  ) as DependencyReviewStatus[];
  const leaseExpired = and(
    eq(dependencyReviews.status, "running"),
    lt(dependencyReviews.updatedAt, new Date(now.getTime() - DEPENDENCY_REVIEW_LEASE_MS)),
  );
  const claimed = await db
    .update(dependencyReviews)
    .set({
      status: "running",
      attempt: sql`${dependencyReviews.attempt} + 1`,
      // SET reads the row's old values, so this tests the status being left.
      // A recheck's fresh progress names the run it rechecks, from the claim
      // on, so a redelivery after any failure in its pass can resume it.
      progressJson:
        options.recheckOfRun !== undefined
          ? JSON.stringify({ ...emptyProgress(now.getTime()), recheckOf: options.recheckOfRun })
          : restart
            ? null
            : sql`CASE WHEN ${dependencyReviews.status} IN ('queued', 'running') THEN ${dependencyReviews.progressJson} ELSE NULL END`,
      updatedAt: now,
    })
    .where(
      and(
        eq(dependencyReviews.id, reviewId),
        options.recheckOfRun !== undefined
          ? and(
              eq(dependencyReviews.status, "completed"),
              eq(dependencyReviews.conclusion, "held"),
              eq(dependencyReviews.checkRunId, options.recheckOfRun),
            )
          : or(inArray(dependencyReviews.status, claimable), leaseExpired),
      ),
    )
    .returning({ attempt: dependencyReviews.attempt });
  return claimed[0]?.attempt ?? null;
}

export async function claimDependencyReview(
  db: AppDb,
  reviewId: string,
  options: { rerun?: boolean; now?: Date } = {},
): Promise<boolean> {
  return (await claimDependencyReviewAttempt(db, reviewId, options)) !== null;
}

// A pass's writes land only while its claim is the newest one.
function ownsClaim(attempt: number | undefined) {
  return attempt === undefined
    ? undefined
    : and(eq(dependencyReviews.status, "running"), eq(dependencyReviews.attempt, attempt));
}

/** Give a claim back before a retry, so the retried message can take it. */
export async function releaseDependencyReview(
  db: AppDb,
  reviewId: string,
  checkRunId: number | null,
  attempt?: number,
): Promise<boolean> {
  const released = await db
    .update(dependencyReviews)
    .set({ status: "queued", updatedAt: new Date() })
    .where(
      and(
        eq(dependencyReviews.id, reviewId),
        eq(dependencyReviews.status, "running"),
        checkRunId === null
          ? isNull(dependencyReviews.checkRunId)
          : eq(dependencyReviews.checkRunId, checkRunId),
        ownsClaim(attempt),
      ),
    )
    .returning({ id: dependencyReviews.id });
  return released.length > 0;
}

export async function setDependencyReviewCheckRun(
  db: AppDb,
  reviewId: string,
  checkRunId: number,
  attempt?: number,
): Promise<void> {
  await db
    .update(dependencyReviews)
    .set({ checkRunId, updatedAt: new Date() })
    .where(and(eq(dependencyReviews.id, reviewId), ownsClaim(attempt)));
}

/** The stored progress of a running review, as written by its passes. */
export async function readDependencyReviewProgress(
  db: AppDb,
  reviewId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ progressJson: dependencyReviews.progressJson })
    .from(dependencyReviews)
    .where(eq(dependencyReviews.id, reviewId))
    .limit(1);
  return row?.progressJson ?? null;
}

/**
 * Store a pass's progress while its claim is current. The `updated_at` bump
 * doubles as a heartbeat: the lease runs from the last write. False means a
 * newer claim owns the review and this pass must stop.
 */
export async function saveDependencyReviewProgress(
  db: AppDb,
  reviewId: string,
  attempt: number,
  progressJson: string,
): Promise<boolean> {
  const saved = await db
    .update(dependencyReviews)
    .set({ progressJson, updatedAt: new Date() })
    .where(and(eq(dependencyReviews.id, reviewId), ownsClaim(attempt)))
    .returning({ id: dependencyReviews.id });
  return saved.length > 0;
}

export async function completeDependencyReview(
  db: AppDb,
  reviewId: string,
  input: {
    conclusion: DependencyReviewConclusion;
    bumps: readonly ReviewedBump[];
    // `bumps` may be the stored prefix of a longer review; these keep the
    // review's real totals so the page can say what was left out.
    bumpCount?: number;
    heldCount?: number;
    coverage: DependencyReviewCoverage;
    approvedByLogin?: string | null;
    // Only overwrite a completed result still on this run: an approval must
    // not land on a review a Re-run has claimed since the click.
    ifCompletedOnRun?: number;
    ifRunningOnRun?: number;
    // With `ifRunningOnRun`: the claim of the pass that completes.
    ifAttempt?: number;
  },
): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(dependencyReviews)
    .set({
      status: "completed",
      conclusion: input.conclusion,
      bumpCount: input.bumpCount ?? input.bumps.length,
      heldCount:
        input.heldCount ??
        input.bumps.filter((b) => b.verdict.status === "hold" && !b.approved).length,
      bumpsJson: JSON.stringify(input.bumps),
      unreadLockfilesJson: JSON.stringify(input.coverage.unreadLockfiles),
      listingComplete: input.coverage.listingComplete,
      failureReason: null,
      progressJson: null,
      ...(input.approvedByLogin ? { approvedByLogin: input.approvedByLogin, approvedAt: now } : {}),
      completedAt: now,
      updatedAt: now,
    })
    .where(
      input.ifCompletedOnRun === undefined
        ? and(
            eq(dependencyReviews.id, reviewId),
            input.ifRunningOnRun === undefined
              ? undefined
              : and(
                  eq(dependencyReviews.status, "running"),
                  eq(dependencyReviews.checkRunId, input.ifRunningOnRun),
                  ownsClaim(input.ifAttempt),
                ),
          )
        : and(
            eq(dependencyReviews.id, reviewId),
            eq(dependencyReviews.status, "completed"),
            eq(dependencyReviews.checkRunId, input.ifCompletedOnRun),
          ),
    )
    .returning({ id: dependencyReviews.id });
  return updated.length > 0;
}

export async function failDependencyReview(
  db: AppDb,
  reviewId: string,
  failureReason: string,
  checkRunId?: number | null,
  attempt?: number,
): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(dependencyReviews)
    .set({ status: "failed", failureReason, progressJson: null, updatedAt: now })
    .where(
      and(
        eq(dependencyReviews.id, reviewId),
        checkRunId === undefined
          ? undefined
          : checkRunId === null
            ? isNull(dependencyReviews.checkRunId)
            : eq(dependencyReviews.checkRunId, checkRunId),
        ownsClaim(attempt),
      ),
    )
    .returning({ id: dependencyReviews.id });
  return updated.length > 0;
}

export interface DependencyReviewCoverage {
  unreadLockfiles: string[];
  listingComplete: boolean;
}

export async function readDependencyReviewResult(
  db: AppDb,
  reviewId: string,
): Promise<{ bumps: ReviewedBump[]; coverage: DependencyReviewCoverage }> {
  const [row] = await db
    .select({
      bumpsJson: dependencyReviews.bumpsJson,
      unreadLockfilesJson: dependencyReviews.unreadLockfilesJson,
      listingComplete: dependencyReviews.listingComplete,
    })
    .from(dependencyReviews)
    .where(eq(dependencyReviews.id, reviewId))
    .limit(1);
  const bumps = row?.bumpsJson ? parseJson(row.bumpsJson) : null;
  const unread = row ? parseJson(row.unreadLockfilesJson) : null;
  return {
    bumps: Array.isArray(bumps) ? (bumps as ReviewedBump[]) : [],
    coverage: {
      unreadLockfiles: Array.isArray(unread)
        ? unread.filter((path): path is string => typeof path === "string")
        : [],
      listingComplete: row?.listingComplete ?? true,
    },
  };
}

export async function listDependencyReviews(
  db: AppDb,
  organizationId: string,
  limit: number,
): Promise<DependencyReviewRecord[]> {
  return db
    .select(RECORD_COLUMNS)
    .from(dependencyReviews)
    .where(
      and(
        eq(dependencyReviews.organizationId, organizationId),
        ne(dependencyReviews.status, "superseded"),
      ),
    )
    .orderBy(desc(dependencyReviews.createdAt))
    .limit(limit);
}

/**
 * The newest later review of the same pull request, if any. Approve on an
 * older commit's check is refused (the head moved), so the dashboard points
 * there instead.
 */
export async function findNewerDependencyReviewId(
  db: AppDb,
  review: Pick<
    DependencyReviewRecord,
    "id" | "organizationId" | "repositoryId" | "pullNumber" | "createdAt"
  >,
): Promise<string | null> {
  const [row] = await db
    .select({ id: dependencyReviews.id })
    .from(dependencyReviews)
    .where(
      and(
        eq(dependencyReviews.organizationId, review.organizationId),
        eq(dependencyReviews.repositoryId, review.repositoryId),
        eq(dependencyReviews.pullNumber, review.pullNumber),
        gt(dependencyReviews.createdAt, review.createdAt),
        ne(dependencyReviews.status, "superseded"),
        ne(dependencyReviews.id, review.id),
      ),
    )
    .orderBy(desc(dependencyReviews.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/** A change's identity for collection and approvals (`bumpIdentityKey`). */
export function dependencyChangeKey(bump: Parameters<typeof bumpIdentityKey>[0]) {
  return bumpIdentityKey(bump);
}

/** Which of `bumps` someone already approved in this repository. */
export async function findApprovedChanges(
  db: AppDb,
  organizationId: string,
  repositoryId: number,
  bumps: readonly DependencyBump[],
): Promise<Set<string>> {
  const approved = new Set<string>();
  const names = [...new Set(bumps.map((bump) => bump.name))];
  for (const chunk of chunkForD1(names, 1, 2)) {
    const rows = await db
      .select({
        ecosystem: dependencyReviewApprovals.ecosystem,
        packageName: dependencyReviewApprovals.packageName,
        fromVersion: dependencyReviewApprovals.fromVersion,
        toVersion: dependencyReviewApprovals.toVersion,
        source: dependencyReviewApprovals.source,
      })
      .from(dependencyReviewApprovals)
      .where(
        and(
          eq(dependencyReviewApprovals.organizationId, organizationId),
          eq(dependencyReviewApprovals.repositoryId, repositoryId),
          inArray(dependencyReviewApprovals.packageName, chunk),
        ),
      );
    for (const row of rows) {
      approved.add(
        changeKey(row.ecosystem, row.packageName, row.fromVersion, row.toVersion, row.source),
      );
    }
  }
  return approved;
}

export function isChangeApproved(approved: Set<string>, bump: DependencyBump): boolean {
  return approved.has(dependencyChangeKey(bump));
}

export async function recordDependencyApprovals(
  db: AppDb,
  input: {
    organizationId: string;
    repositoryId: number;
    reviewId: string;
    approvedByLogin: string;
    approvedByGithubId: number;
    bumps: readonly DependencyBump[];
  },
): Promise<void> {
  const now = new Date();
  const rows = input.bumps.map((bump) => ({
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    repositoryId: input.repositoryId,
    ecosystem: bump.ecosystem,
    packageName: bump.name,
    fromVersion: bump.fromVersion ?? "",
    toVersion: bump.toVersion,
    source: changeSource(bump),
    approvedByLogin: input.approvedByLogin,
    approvedByGithubId: input.approvedByGithubId,
    reviewId: input.reviewId,
    approvedAt: now,
  }));
  for (const chunk of chunkForD1(rows, 11)) {
    await db.insert(dependencyReviewApprovals).values(chunk).onConflictDoNothing();
  }
}

export async function supersedeDependencyReview(
  db: AppDb,
  reviewId: string,
  checkRunId: number,
  attempt?: number,
): Promise<void> {
  await db
    .update(dependencyReviews)
    .set({ status: "superseded", progressJson: null, updatedAt: new Date() })
    .where(
      and(
        eq(dependencyReviews.id, reviewId),
        eq(dependencyReviews.checkRunId, checkRunId),
        ownsClaim(attempt),
      ),
    );
}
