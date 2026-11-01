import {
  type SQL,
  and,
  asc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notExists,
  or,
} from "drizzle-orm";
import type { AppDb } from "./client";
import type { PyPiStageSessionState, WorkflowGateStatus } from "./enums";
import { githubWorkflowGates, pypiProjectTokens, pypiStageSessions, scans } from "./schema";

// ── Project tokens ───────────────────────────────────────────────────────────

export type PyPiProjectTokenRow = typeof pypiProjectTokens.$inferSelect;

/** The only shape of a token row that may leave the server. */
export interface PublicPyPiProjectToken {
  id: string;
  projectName: string;
  indexOrigin: string;
  repositoryId: number;
  repositoryFullName: string;
  tokenFingerprint: string;
  tokenLast4: string | null;
  validatedAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export function publicPyPiProjectToken(row: PyPiProjectTokenRow): PublicPyPiProjectToken {
  return {
    id: row.id,
    projectName: row.projectName,
    indexOrigin: row.indexOrigin,
    repositoryId: row.repositoryId,
    repositoryFullName: row.repositoryFullName,
    tokenFingerprint: row.tokenFingerprint,
    tokenLast4: row.tokenLast4,
    validatedAt: row.validatedAt?.getTime() ?? null,
    lastUsedAt: row.lastUsedAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export async function listPyPiProjectTokens(
  db: AppDb,
  organizationId: string,
): Promise<PyPiProjectTokenRow[]> {
  return db
    .select()
    .from(pypiProjectTokens)
    .where(eq(pypiProjectTokens.organizationId, organizationId))
    .orderBy(asc(pypiProjectTokens.indexOrigin), asc(pypiProjectTokens.projectName));
}

export async function getPyPiProjectToken(
  db: AppDb,
  organizationId: string,
  id: string,
): Promise<PyPiProjectTokenRow | null> {
  const [row] = await db
    .select()
    .from(pypiProjectTokens)
    .where(and(eq(pypiProjectTokens.organizationId, organizationId), eq(pypiProjectTokens.id, id)))
    .limit(1);
  return row ?? null;
}

export async function findPyPiProjectToken(
  db: AppDb,
  organizationId: string,
  indexOrigin: string,
  projectName: string,
): Promise<PyPiProjectTokenRow | null> {
  const [row] = await db
    .select()
    .from(pypiProjectTokens)
    .where(
      and(
        eq(pypiProjectTokens.organizationId, organizationId),
        eq(pypiProjectTokens.indexOrigin, indexOrigin),
        eq(pypiProjectTokens.projectName, projectName),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertPyPiProjectToken(
  db: AppDb,
  values: Omit<typeof pypiProjectTokens.$inferInsert, "id" | "createdAt" | "updatedAt">,
): Promise<PyPiProjectTokenRow | null> {
  const now = new Date();
  const [row] = await db
    .insert(pypiProjectTokens)
    .values({ ...values, id: crypto.randomUUID(), createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

export async function updatePyPiProjectToken(
  db: AppDb,
  organizationId: string,
  id: string,
  values: Partial<
    Pick<
      typeof pypiProjectTokens.$inferInsert,
      | "tokenCiphertext"
      | "tokenNonce"
      | "tokenFingerprint"
      | "tokenLast4"
      | "validatedAt"
      | "lastUsedAt"
    >
  >,
): Promise<PyPiProjectTokenRow | null> {
  const [row] = await db
    .update(pypiProjectTokens)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(pypiProjectTokens.organizationId, organizationId), eq(pypiProjectTokens.id, id)))
    .returning();
  return row ?? null;
}

export async function deletePyPiProjectToken(
  db: AppDb,
  organizationId: string,
  id: string,
): Promise<PyPiProjectTokenRow | null> {
  const [row] = await db
    .delete(pypiProjectTokens)
    .where(and(eq(pypiProjectTokens.organizationId, organizationId), eq(pypiProjectTokens.id, id)))
    .returning();
  return row ?? null;
}

// ── Held sessions ────────────────────────────────────────────────────────────

export type PyPiStageSessionRow = typeof pypiStageSessions.$inferSelect;

export interface ReviewedStagedFile {
  filename: string;
  sha256: string;
}

/** Safe, maintainer-facing view of a held session for the gate workbench. */
export interface PublicPyPiStageSession {
  projectName: string;
  version: string;
  indexOrigin: string;
  state: PyPiStageSessionState;
  stateDetail: string | null;
  expiresAt: number | null;
  updatedAt: number;
}

export function publicPyPiStageSession(row: PyPiStageSessionRow): PublicPyPiStageSession {
  return {
    projectName: row.projectName,
    version: row.version,
    indexOrigin: row.indexOrigin,
    state: row.state,
    stateDetail: row.stateDetail,
    expiresAt: row.expiresAt?.getTime() ?? null,
    updatedAt: row.updatedAt.getTime(),
  };
}

/** States a re-run review may restage from: nothing irreversible happened yet. */
const RESTAGEABLE_STATES: PyPiStageSessionState[] = ["staging", "upload_failed", "held", "stale"];

/**
 * Record (or re-record) the session Drydock is staging for a gate's project,
 * in state `staging`. Returns the row, or null with the existing row's state
 * when that row is past the point of restaging (publishing, published,
 * canceled, ...).
 */
export async function upsertPyPiStageSession(
  db: AppDb,
  values: Omit<typeof pypiStageSessions.$inferInsert, "id" | "createdAt" | "updatedAt" | "state">,
): Promise<{ row: PyPiStageSessionRow } | { blockedBy: PyPiStageSessionState | null }> {
  const now = new Date();
  const [row] = await db
    .insert(pypiStageSessions)
    .values({
      ...values,
      id: crypto.randomUUID(),
      state: "staging",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [pypiStageSessions.gateId, pypiStageSessions.projectName],
      set: {
        ...values,
        state: "staging",
        stateDetail: null,
        lastExtendedAt: null,
        updatedAt: now,
      },
      setWhere: inArray(pypiStageSessions.state, RESTAGEABLE_STATES),
    })
    .returning();
  if (row) return { row };
  const [existing] = await db
    .select({ state: pypiStageSessions.state })
    .from(pypiStageSessions)
    .where(
      and(
        eq(pypiStageSessions.gateId, values.gateId),
        eq(pypiStageSessions.projectName, values.projectName),
      ),
    )
    .limit(1);
  return { blockedBy: existing?.state ?? null };
}

/**
 * Another gate of this organization that still tracks the same index session
 * (PEP 694 hands the existing session back for a re-run of one release).
 * Rows that can still be restaged or canceled are retired as `superseded`, so
 * an old gate's rejection never cancels the session a newer gate now holds.
 *
 * Only a gate of the same repository may take a session over. A live row from
 * another repository is never retired here: that would hand one repository's
 * held release to another with no human involved. Returns what blocks the
 * adoption (`other_repository`, or the state of a row that cannot be retired:
 * publishing, canceling), or null when the session is free to adopt.
 */
export async function supersedePyPiStageSessions(
  db: AppDb,
  input: {
    organizationId: string;
    sessionFingerprint: string;
    exceptGateId: string;
    repositoryId: number;
  },
): Promise<PyPiStageSessionState | "other_repository" | null> {
  const gatesOf = (sameRepository: boolean) =>
    db
      .select({ id: githubWorkflowGates.id })
      .from(githubWorkflowGates)
      .where(
        and(
          eq(githubWorkflowGates.organizationId, input.organizationId),
          sameRepository
            ? eq(githubWorkflowGates.repositoryId, input.repositoryId)
            : ne(githubWorkflowGates.repositoryId, input.repositoryId),
        ),
      );
  const sameSession = and(
    eq(pypiStageSessions.organizationId, input.organizationId),
    eq(pypiStageSessions.sessionFingerprint, input.sessionFingerprint),
    ne(pypiStageSessions.gateId, input.exceptGateId),
  );
  const [foreign] = await db
    .select({ state: pypiStageSessions.state })
    .from(pypiStageSessions)
    .where(
      and(
        sameSession,
        inArray(pypiStageSessions.gateId, gatesOf(false)),
        inArray(pypiStageSessions.state, [...RESTAGEABLE_STATES, "publishing", "canceling"]),
      ),
    )
    .limit(1);
  if (foreign) return "other_repository";
  const [busy] = await db
    .select({ state: pypiStageSessions.state })
    .from(pypiStageSessions)
    .where(and(sameSession, inArray(pypiStageSessions.state, ["publishing", "canceling"])))
    .limit(1);
  if (busy) return busy.state;
  await db
    .update(pypiStageSessions)
    .set({
      state: "superseded",
      stateDetail: "a later run of this release took over the session",
      updatedAt: new Date(),
    })
    .where(
      and(
        sameSession,
        inArray(pypiStageSessions.gateId, gatesOf(true)),
        inArray(pypiStageSessions.state, RESTAGEABLE_STATES),
      ),
    );
  return null;
}

/**
 * A removed token can never act on its sessions again; stop tracking them,
 * including `stale` and not-yet-held rows, which a rejection would otherwise
 * try to cancel. A `publishing` row keeps its state: the publish request
 * already went out and may have succeeded, so calling it `token_removed`
 * (unpublished) would let the interrupted-approval recovery reject a gate
 * whose release is live. Its outcome just can no longer be checked.
 */
export async function markTokenSessionsRemoved(
  db: AppDb,
  organizationId: string,
  tokenId: string,
): Promise<PyPiStageSessionRow[]> {
  const now = new Date();
  const ownedByToken = and(
    eq(pypiStageSessions.organizationId, organizationId),
    eq(pypiStageSessions.tokenId, tokenId),
  );
  await db
    .update(pypiStageSessions)
    .set({
      stateDetail:
        "the PyPI token for this project was removed; the publish outcome can no longer be checked",
      updatedAt: now,
    })
    .where(and(ownedByToken, eq(pypiStageSessions.state, "publishing")));
  return db
    .update(pypiStageSessions)
    .set({
      state: "token_removed",
      stateDetail: "the PyPI token for this project was removed",
      updatedAt: now,
    })
    .where(
      and(
        ownedByToken,
        inArray(pypiStageSessions.state, [
          "staging",
          "upload_failed",
          "held",
          "stale",
          "canceling",
        ]),
      ),
    )
    .returning();
}

export async function listGatePyPiStageSessions(
  db: AppDb,
  organizationId: string,
  gateId: string,
): Promise<PyPiStageSessionRow[]> {
  return db
    .select()
    .from(pypiStageSessions)
    .where(
      and(
        eq(pypiStageSessions.organizationId, organizationId),
        eq(pypiStageSessions.gateId, gateId),
      ),
    )
    .orderBy(asc(pypiStageSessions.projectName));
}

/**
 * Compare-and-set a session's state. The single transition guard for every
 * actor (decision route, cron): only the caller that observes `from` moves it.
 */
export async function transitionPyPiStageSession(
  db: AppDb,
  id: string,
  from: readonly PyPiStageSessionState[],
  to: PyPiStageSessionState,
  extra: Partial<
    Pick<
      typeof pypiStageSessions.$inferInsert,
      "stateDetail" | "expiresAt" | "lastExtendedAt" | "lastCheckedAt"
    >
  > = {},
): Promise<PyPiStageSessionRow | null> {
  const [row] = await db
    .update(pypiStageSessions)
    .set({ ...extra, state: to, updatedAt: new Date() })
    .where(and(eq(pypiStageSessions.id, id), inArray(pypiStageSessions.state, [...from])))
    .returning();
  return row ?? null;
}

/**
 * Sessions the cron still owes work: held (extend/observe), publishing (poll),
 * canceling (retry). Each row carries its gate's status: a decided gate's
 * session is not extended.
 */
export async function listPyPiStageSessionsDue(
  db: AppDb,
  checkedBefore: Date,
  limit: number,
): Promise<Array<PyPiStageSessionRow & { gateStatus: WorkflowGateStatus }>> {
  const rows = await db
    .select({ session: pypiStageSessions, gateStatus: githubWorkflowGates.status })
    .from(pypiStageSessions)
    .innerJoin(githubWorkflowGates, eq(githubWorkflowGates.id, pypiStageSessions.gateId))
    .where(
      and(
        inArray(pypiStageSessions.state, ["held", "publishing", "canceling"]),
        // A publish whose token was removed cannot be polled; see
        // `markTokenSessionsRemoved`.
        or(ne(pypiStageSessions.state, "publishing"), isNotNull(pypiStageSessions.tokenId)),
        or(
          isNull(pypiStageSessions.lastCheckedAt),
          lt(pypiStageSessions.lastCheckedAt, checkedBefore),
        ),
      ),
    )
    .orderBy(asc(pypiStageSessions.lastCheckedAt))
    .limit(limit);
  return rows.map(({ session, gateStatus }) => ({ ...session, gateStatus }));
}

/**
 * Approved gates GitHub has not acknowledged (`decision_delivered_at` unset),
 * decided inside `[decidedAfter, decidedBefore)`, that hold PEP 694 sessions,
 * each with every one of its session states, oldest first. The decision route
 * delivers within seconds of its publish, so a gate here was interrupted or
 * its delivery is held back by an unpublished session.
 *
 * Gates still `publishing` are left out (nothing to settle yet), and so are
 * fully published gates decided before `redeliverAfter`: their delivery was
 * already retried and GitHub keeps refusing it, so they must not take a slot
 * on every tick.
 */
export async function listUndeliveredApprovedGates(
  db: AppDb,
  window: { decidedAfter: Date; decidedBefore: Date; redeliverAfter: Date },
  limit: number,
): Promise<Array<{ organizationId: string; gateId: string; states: PyPiStageSessionState[] }>> {
  const gateSessions = (...conditions: SQL[]) =>
    db
      .select({ id: pypiStageSessions.id })
      .from(pypiStageSessions)
      .where(and(eq(pypiStageSessions.gateId, githubWorkflowGates.id), ...conditions));
  const gates = await db
    .select({
      organizationId: githubWorkflowGates.organizationId,
      gateId: githubWorkflowGates.id,
    })
    .from(githubWorkflowGates)
    .where(
      and(
        eq(githubWorkflowGates.status, "approved"),
        isNull(githubWorkflowGates.decisionDeliveredAt),
        gte(githubWorkflowGates.decidedAt, window.decidedAfter),
        lt(githubWorkflowGates.decidedAt, window.decidedBefore),
        exists(gateSessions()),
        notExists(gateSessions(eq(pypiStageSessions.state, "publishing"))),
        or(
          gte(githubWorkflowGates.decidedAt, window.redeliverAfter),
          exists(gateSessions(ne(pypiStageSessions.state, "published"))),
        ),
      ),
    )
    .orderBy(asc(githubWorkflowGates.decidedAt))
    .limit(limit);
  if (gates.length === 0) return [];
  // Every session of each selected gate, so a limit never hides one.
  const sessions = await db
    .select({ gateId: pypiStageSessions.gateId, state: pypiStageSessions.state })
    .from(pypiStageSessions)
    .where(
      inArray(
        pypiStageSessions.gateId,
        gates.map((gate) => gate.gateId),
      ),
    );
  return gates.map((gate) => ({
    ...gate,
    states: sessions.filter((row) => row.gateId === gate.gateId).map((row) => row.state),
  }));
}

/**
 * Pending gates whose staging never reached a review: no scan, no review
 * started, no live staging lease, at least one session still `staging`,
 * `upload_failed`, or `held`, and the gate row untouched since `staleBefore`.
 * Staging activity (taking or releasing the lease, a recorded fault, a retry)
 * writes the gate row; the cron's own upkeep of a held session does not, so
 * session timestamps are not a staleness signal. Nothing was reviewed or
 * approved for these, so cleaning them up is not a release decision. Each
 * carries the `updatedAt` it was selected at, for the cleanup's CAS.
 */
export async function listAbandonedStagingGates(
  db: AppDb,
  input: { staleBefore: Date; now: Date },
  limit: number,
): Promise<Array<{ organizationId: string; gateId: string; updatedAt: Date }>> {
  const gateSessions = (...conditions: SQL[]) =>
    db
      .select({ id: pypiStageSessions.id })
      .from(pypiStageSessions)
      .where(and(eq(pypiStageSessions.gateId, githubWorkflowGates.id), ...conditions));
  return db
    .select({
      organizationId: githubWorkflowGates.organizationId,
      gateId: githubWorkflowGates.id,
      updatedAt: githubWorkflowGates.updatedAt,
    })
    .from(githubWorkflowGates)
    .where(
      and(
        eq(githubWorkflowGates.status, "pending"),
        isNull(githubWorkflowGates.scanId),
        isNull(githubWorkflowGates.reviewStartedAt),
        lt(githubWorkflowGates.updatedAt, input.staleBefore),
        or(
          isNull(githubWorkflowGates.stagingLeaseUntil),
          lt(githubWorkflowGates.stagingLeaseUntil, input.now),
        ),
        exists(
          gateSessions(inArray(pypiStageSessions.state, ["staging", "upload_failed", "held"])),
        ),
        notExists(gateSessions(eq(pypiStageSessions.state, "publishing"))),
        // A failed review batch leaves scans (possibly with a human decision)
        // while the gate has no representative scan: that is reviewed state.
        notExists(
          db.select({ id: scans.id }).from(scans).where(eq(scans.gateId, githubWorkflowGates.id)),
        ),
      ),
    )
    .orderBy(asc(githubWorkflowGates.updatedAt))
    .limit(limit);
}

/**
 * Claim a held session for publishing, but only while its gate is still
 * `approved`: a gate the cron settled meanwhile stops the decision route.
 */
export async function claimPyPiStageSessionForPublish(
  db: AppDb,
  id: string,
  approvedByUserId: string | null,
): Promise<PyPiStageSessionRow | null> {
  const now = new Date();
  const [row] = await db
    .update(pypiStageSessions)
    .set({
      state: "publishing",
      stateDetail: null,
      approvedByUserId,
      publishClaimedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(pypiStageSessions.id, id),
        eq(pypiStageSessions.state, "held"),
        exists(
          db
            .select({ id: githubWorkflowGates.id })
            .from(githubWorkflowGates)
            .where(
              and(
                eq(githubWorkflowGates.id, pypiStageSessions.gateId),
                eq(githubWorkflowGates.status, "approved"),
              ),
            ),
        ),
      ),
    )
    .returning();
  return row ?? null;
}
