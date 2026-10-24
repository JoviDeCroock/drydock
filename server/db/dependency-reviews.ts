import { and, desc, eq, inArray, lt, ne, or } from "drizzle-orm";
import { parseDependencyReviewPolicy } from "../lib/dependency-review/policy";
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
 * Move a review to `running` for one attempt. A queued, failed, or superseded
 * review can be claimed: the job checks the PR's live head first, so a
 * superseded review whose commit is the head again (reopened) is reviewed. A
 * completed one only for an explicit `rerun` (the Re-run button). A duplicate
 * message for a review running inside its lease, or one already completed,
 * exits without posting another run.
 */
export async function claimDependencyReview(
  db: AppDb,
  reviewId: string,
  options: { rerun?: boolean; now?: Date } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const claimable = [
    "queued",
    "failed",
    "superseded",
    ...(options.rerun ? ["completed"] : []),
  ] as DependencyReviewStatus[];
  const claimed = await db
    .update(dependencyReviews)
    .set({ status: "running", updatedAt: now })
    .where(
      and(
        eq(dependencyReviews.id, reviewId),
        or(
          inArray(dependencyReviews.status, claimable),
          and(
            eq(dependencyReviews.status, "running"),
            lt(dependencyReviews.updatedAt, new Date(now.getTime() - DEPENDENCY_REVIEW_LEASE_MS)),
          ),
        ),
      ),
    )
    .returning({ id: dependencyReviews.id });
  return claimed.length > 0;
}

/** Give a claim back before a retry, so the retried message can take it. */
export async function releaseDependencyReview(db: AppDb, reviewId: string): Promise<void> {
  await db
    .update(dependencyReviews)
    .set({ status: "queued", updatedAt: new Date() })
    .where(and(eq(dependencyReviews.id, reviewId), eq(dependencyReviews.status, "running")));
}

export async function setDependencyReviewCheckRun(
  db: AppDb,
  reviewId: string,
  checkRunId: number,
): Promise<void> {
  await db
    .update(dependencyReviews)
    .set({ checkRunId, updatedAt: new Date() })
    .where(eq(dependencyReviews.id, reviewId));
}

export async function completeDependencyReview(
  db: AppDb,
  reviewId: string,
  input: {
    conclusion: DependencyReviewConclusion;
    bumps: readonly ReviewedBump[];
    coverage: DependencyReviewCoverage;
    approvedByLogin?: string | null;
    // Only overwrite a completed result still on this run: an approval must
    // not land on a review a Re-run has claimed since the click.
    ifCompletedOnRun?: number;
  },
): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(dependencyReviews)
    .set({
      status: "completed",
      conclusion: input.conclusion,
      bumpCount: input.bumps.length,
      heldCount: input.bumps.filter((b) => b.verdict.status === "hold" && !b.approved).length,
      bumpsJson: JSON.stringify(input.bumps),
      unreadLockfilesJson: JSON.stringify(input.coverage.unreadLockfiles),
      listingComplete: input.coverage.listingComplete,
      failureReason: null,
      ...(input.approvedByLogin ? { approvedByLogin: input.approvedByLogin, approvedAt: now } : {}),
      completedAt: now,
      updatedAt: now,
    })
    .where(
      input.ifCompletedOnRun === undefined
        ? eq(dependencyReviews.id, reviewId)
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
): Promise<void> {
  const now = new Date();
  await db
    .update(dependencyReviews)
    .set({ status: "failed", failureReason, updatedAt: now })
    .where(eq(dependencyReviews.id, reviewId));
}

export interface DependencyReviewCoverage {
  unreadLockfiles: string[];
  listingComplete: boolean;
}

export async function readDependencyReviewBumps(
  db: AppDb,
  reviewId: string,
): Promise<ReviewedBump[]> {
  return (await readDependencyReviewResult(db, reviewId)).bumps;
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

export function dependencyChangeKey(
  bump: Pick<DependencyBump, "ecosystem" | "name" | "fromVersion" | "toVersion" | "privateSource">,
) {
  return [
    bump.ecosystem,
    bump.name,
    bump.fromVersion ?? "",
    bump.toVersion,
    changeSource(bump),
  ].join("\u0000");
}

function changeSource(bump: Pick<DependencyBump, "privateSource">): "public" | "private" {
  return bump.privateSource ? "private" : "public";
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
        dependencyChangeKey({
          ecosystem: row.ecosystem as DependencyBump["ecosystem"],
          name: row.packageName,
          fromVersion: row.fromVersion || null,
          toVersion: row.toVersion,
          privateSource: row.source === "private" ? true : undefined,
        }),
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

export async function supersedeDependencyReview(db: AppDb, reviewId: string): Promise<void> {
  await db
    .update(dependencyReviews)
    .set({ status: "superseded", updatedAt: new Date() })
    .where(eq(dependencyReviews.id, reviewId));
}
