import type { AppDb } from "../../../db/client";
import type { PyPiStageSessionState, WorkflowGateStatus } from "../../../db/enums";
import { recordScanEvent } from "../../../db/events";
import {
  type PyPiStageSessionRow,
  type ReviewedStagedFile,
  findPyPiProjectToken,
  getPyPiProjectToken,
  claimPyPiStageSessionForPublish,
  listUndeliveredApprovedGates,
  listGatePyPiStageSessions,
  listPyPiStageSessionsDue,
  publicPyPiStageSession,
  transitionPyPiStageSession,
  updatePyPiProjectToken,
  upsertPyPiStageSession,
} from "../../../db/pypi-stage-sessions";
import { mapWithConcurrency } from "../../platform/concurrency";
import { isRecord } from "../../platform/guards";
import { describeOperationalError, emitOperationalEvent } from "../../platform/observability";
import { openSecret, sealSecret } from "../../platform/secret-box";
import { normalizePyPiProjectName } from "./manifest";
import { openPyPiToken } from "./project-token";
import {
  type PyPiSessionGateway,
  type PyPiSessionSnapshot,
  PyPiSessionError,
  createPyPiSessionGateway,
  sessionBindingProblems,
  sessionFingerprint,
} from "./session-gateway";
import {
  PyPiStageError,
  compareDistributionSets,
  parseAllowedStageUrl,
  selectStagedReleaseFiles,
  summarizeProblems,
  type PyPiStageReferenceEntry,
} from "./stage";
import { fetchStageProjectPage } from "./stage-fetch";
import type { HeldReleaseHooks, PublicHeldRelease } from "../../workflow-gates/types";

/**
 * PEP 694 mode B (preview, opt-in per project): Drydock holds the session.
 *
 *   register ──► held ──(approval recorded; re-verify)──► publishing ──► published
 *                 │  │                  │ files changed        │ 409/4xx, index error, or
 *                 │  │                  └──► stale             │ still open (see below) ──► error
 *                 │  │                                         └─(transport/5xx: unknown, poll)
 *                 │  └──(human reject; also from stale)──► canceling ──► canceled
 *                 ├──(cron observes)──► expired | externally_published |
 *                 │                     externally_canceled | stale
 *                 └──(token deleted)──► token_removed   (also from canceling)
 *
 * Drydock never publishes or cancels on its own: publish runs only after the
 * maintainer approval that completes the gate is recorded, cancel only after
 * a maintainer's rejection. A definite publish failure in the decision
 * request turns that approval into a fail-closed rejection. An approval GitHub
 * has not acknowledged 30 minutes later (the request died, or delivery is
 * blocked by an unpublished session) is settled by the cron: delivered once
 * every session is `published`, left alone while one is `publishing`,
 * otherwise rejected. A failure observed after GitHub acknowledged the
 * approval leaves the gate `approved`; the session's state shows it. `open`
 * counts as a refused publish only after a failed request or 30 minutes after
 * the claim, since a read right after a 202 may lag.
 */

const EXTEND_FOR_SECONDS = 7 * 24 * 60 * 60;
// Extend when less than this remains, at most once per `EXTEND_MIN_INTERVAL_MS`.
const EXTEND_WINDOW_MS = 48 * 60 * 60 * 1000;
const EXTEND_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
// The decision route publishes (about two minutes per project at worst) and
// delivers right after the gate CAS; an approval GitHub still has not
// acknowledged after this long is settled by the cron.
const UNDELIVERED_APPROVAL_AFTER_MS = 30 * 60 * 1000;
const UNDELIVERED_APPROVAL_BATCH = 25;
// A published approval GitHub keeps refusing (the run was canceled, say) is
// re-delivered by the cron only this long after the decision; the queue's own
// retries cover transient failures.
const REDELIVER_FOR_MS = 6 * 60 * 60 * 1000;
// GitHub drops a held deployment after 30 days; holding a session past that
// keeps unpublished bytes readable for a gate that can no longer be decided.
const MAX_HOLD_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_RECHECK_MS = 10 * 60 * 1000;
// After an accepted (202) publish, a session read as `open` may be a lagging
// status; only this long after the claim does `open` mean the index never took
// the publish. Longer than the sweep's recheck interval on purpose.
const OPEN_AFTER_PUBLISH_GRACE_MS = 30 * 60 * 1000;
const SWEEP_BATCH = 25;
const SWEEP_CONCURRENCY = 3;
const DEFAULT_PUBLISH_POLL_DELAYS_MS = [1_000, 2_000, 3_000];
const TOKEN_REMOVED_DETAIL = "the PyPI token for this project was removed";

interface SessionLinks {
  session: string;
  stage: string;
}

export interface ManagedSessionRegistration {
  entry: PyPiStageReferenceEntry;
  reviewed: ReviewedStagedFile[];
}

export interface RegistrationContext {
  env: Cloudflare.Env;
  db: AppDb;
  organizationId: string;
  gateId: string;
  fetchImpl?: typeof fetch;
}

/**
 * Take over the sessions an organization opted into: the entry names a
 * `session-url` and the organization stores a token for that project on that
 * index. Everything is verified before anything is persisted, so a mismatch on
 * one project leaves no held rows. Returns the normalized projects now held.
 */
export async function registerManagedSessions(
  ctx: RegistrationContext,
  registrations: ManagedSessionRegistration[],
): Promise<Set<string>> {
  const verified: Array<{
    registration: ManagedSessionRegistration;
    sessionUrl: string;
    tokenId: string;
    snapshot: PyPiSessionSnapshot;
  }> = [];
  for (const registration of registrations) {
    const { entry } = registration;
    if (!entry.sessionUrl) continue;
    const project = normalizePyPiProjectName(entry.name);
    const tokenRow = await findPyPiProjectToken(
      ctx.db,
      ctx.organizationId,
      entry.stageUrl.origin,
      project,
    );
    if (!tokenRow) continue;
    const gateway = createGatewayOrThrow({
      token: await openPyPiToken(ctx.env, tokenRow),
      indexOrigin: tokenRow.indexOrigin,
      sessionUrl: entry.sessionUrl,
      fetchImpl: ctx.fetchImpl,
    });
    let snapshot: PyPiSessionSnapshot;
    try {
      snapshot = await gateway.status();
    } catch (err) {
      throw sessionStageError(entry.name, err);
    }
    const problems = sessionBindingProblems(snapshot, {
      project: entry.name,
      version: entry.version,
      stageUrl: entry.stageUrl.href,
      filenames: registration.reviewed.map((file) => file.filename),
    });
    if (snapshot.links.session !== entry.sessionUrl) {
      problems.push("session status names a different session URL");
    }
    if (problems.length > 0) {
      throw new PyPiStageError(
        "stage_session_mismatch",
        `${entry.name} session: ${summarizeProblems(problems)}`,
      );
    }
    verified.push({ registration, sessionUrl: entry.sessionUrl, tokenId: tokenRow.id, snapshot });
  }

  const held = new Set<string>();
  for (const { registration, sessionUrl, tokenId, snapshot } of verified) {
    const { entry } = registration;
    const project = normalizePyPiProjectName(entry.name);
    const sealed = await sealSecret(
      ctx.env,
      "pypi-session-links",
      JSON.stringify({ session: sessionUrl, stage: entry.stageUrl.href } satisfies SessionLinks),
    );
    const stored = await upsertPyPiStageSession(ctx.db, {
      organizationId: ctx.organizationId,
      gateId: ctx.gateId,
      tokenId,
      projectName: project,
      version: entry.version,
      indexOrigin: entry.stageUrl.origin,
      linksCiphertext: sealed.ciphertext,
      linksNonce: sealed.nonce,
      sessionFingerprint: await sessionFingerprint(sessionUrl),
      reviewedFilesJson: registration.reviewed,
      expiresAt: snapshot.expiresAt,
      lastCheckedAt: new Date(),
    });
    if (!stored) {
      throw new PyPiStageError(
        "stage_session_mismatch",
        `${entry.name} session: this gate already published, canceled, or is publishing a session for the project`,
      );
    }
    await updatePyPiProjectToken(ctx.db, ctx.organizationId, tokenId, { lastUsedAt: new Date() });
    await recordSessionEvent(ctx.db, ctx.organizationId, ctx.gateId, "pypi_session.held", {
      projectName: project,
      version: entry.version,
    });
    held.add(project);
  }
  return held;
}

// ── Human approval: verify, record, then publish ─────────────────────────────

export type ManagedPublishResult = { ok: true } | { ok: false; error: string };

export interface SessionActionOptions {
  fetchImpl?: typeof fetch;
  publishPollDelaysMs?: number[];
  /** The maintainer whose decision this action carries out (audit attribution). */
  actorUserId?: string | null;
}

/**
 * Pre-check, before a maintainer's approval is recorded: every held session
 * is still open and bound and its staged digests are the reviewed ones. A
 * session that changed is settled (`stale`, `expired`, ...) and the approval
 * is refused while the maintainer can still reject. Publishes nothing.
 */
async function verifyManagedSessions(
  env: Cloudflare.Env,
  db: AppDb,
  organizationId: string,
  gateId: string,
  options: SessionActionOptions = {},
): Promise<ManagedPublishResult> {
  const prepared = await prepareHeldSessions(env, db, organizationId, gateId, options);
  return "error" in prepared ? { ok: false, error: prepared.error } : { ok: true };
}

/**
 * Runs only after the approval that completes the gate is durably recorded
 * (the gate CAS out of `pending`), so no concurrent rejection can land while
 * an irreversible publish is in flight. Re-verifies every held session, then
 * publishes them one by one. A definite failure returns `ok: false`; the
 * caller turns the approval into a fail-closed rejection. An unknown outcome
 * (transport failure, 5xx) stays `publishing` for the cron to resolve.
 */
export async function publishManagedSessions(
  env: Cloudflare.Env,
  db: AppDb,
  organizationId: string,
  gateId: string,
  options: SessionActionOptions = {},
): Promise<ManagedPublishResult> {
  const prepared = await prepareHeldSessions(env, db, organizationId, gateId, options);
  if ("error" in prepared) return { ok: false, error: prepared.error };

  for (const { row, gateway, snapshot } of prepared.ready) {
    const claimed = await claimPyPiStageSessionForPublish(db, row.id, options.actorUserId ?? null);
    if (!claimed) {
      return {
        ok: false,
        error: `the ${row.projectName} PyPI session or its gate changed state`,
      };
    }
    const result = await publishClaimedSession(db, claimed, gateway, snapshot, options);
    if (!result.ok) return result;
  }
  return { ok: true };
}

async function publishClaimedSession(
  db: AppDb,
  row: PyPiStageSessionRow,
  gateway: PyPiSessionGateway,
  snapshot: PyPiSessionSnapshot,
  options: SessionActionOptions,
): Promise<ManagedPublishResult> {
  let outcome: PyPiStageSessionState;
  // Only after a failed request does a session still reading `open` prove the
  // index never took the publish; after a 202 it may be a lagging read.
  let openIsRefusal = false;
  try {
    const accepted = await gateway.publish(snapshot);
    outcome = accepted.status === 201 ? "published" : "publishing";
  } catch (err) {
    if (!publishOutcomeUnknown(err)) {
      const detail =
        err instanceof PyPiSessionError && err.code === "session_conflict"
          ? "PyPI refused to publish the session (HTTP 409)"
          : `PyPI did not accept the publish: ${safeSessionMessage(err)}`;
      await settle(db, row, ["publishing"], "error", detail);
      return { ok: false, error: `${row.projectName}: ${detail}` };
    }
    // PyPI may have accepted the publish before the connection failed: never
    // hand the session back as `held`, find out instead.
    await touch(db, row, "publishing", "publish outcome unknown; checking with the index");
    outcome = "publishing";
    openIsRefusal = true;
  }
  if (outcome === "published") {
    await settle(db, row, ["publishing"], "published", null);
    return { ok: true };
  }
  for (const delay of options.publishPollDelaysMs ?? DEFAULT_PUBLISH_POLL_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    outcome = await observePublishing(db, row, gateway, { openIsRefusal });
    if (outcome !== "publishing") break;
  }
  // Still `publishing` is accepted: the cron keeps polling it.
  if (outcome !== "publishing" && outcome !== "published") {
    return {
      ok: false,
      error: `PyPI did not publish ${row.projectName}: the session is ${describeState(outcome)}`,
    };
  }
  return { ok: true };
}

async function prepareHeldSessions(
  env: Cloudflare.Env,
  db: AppDb,
  organizationId: string,
  gateId: string,
  options: SessionActionOptions,
): Promise<
  | {
      ready: Array<{
        row: PyPiStageSessionRow;
        gateway: PyPiSessionGateway;
        snapshot: PyPiSessionSnapshot;
      }>;
    }
  | { error: string }
> {
  const rows = await listGatePyPiStageSessions(db, organizationId, gateId);
  for (const row of rows) {
    if (row.state !== "held") {
      return {
        error: `the ${row.projectName} PyPI session is ${describeState(row.state)}; it cannot be published`,
      };
    }
  }
  const ready: Array<{
    row: PyPiStageSessionRow;
    gateway: PyPiSessionGateway;
    snapshot: PyPiSessionSnapshot;
  }> = [];
  for (const row of rows) {
    const opened = await openSession(env, db, row, options);
    if ("error" in opened) return { error: opened.error };
    const checked = await verifyHeldSession(db, row, opened.gateway, opened.links, {
      checkStage: true,
    });
    if ("error" in checked) return { error: checked.error };
    ready.push({ row, gateway: opened.gateway, snapshot: checked.snapshot });
  }
  return { ready };
}

// A transport failure or a 5xx may hide an accepted publish; a refused URL,
// redirect, 4xx, or malformed answer means the index did not take it.
function publishOutcomeUnknown(err: unknown): boolean {
  if (!(err instanceof PyPiSessionError)) return true;
  if (err.code === "session_unreachable") return true;
  return err.code === "session_http_error" && (err.status ?? 0) >= 500;
}

// ── Human rejection: cancel ──────────────────────────────────────────────────

/** Runs after a maintainer's rejection is recorded. Never blocks the rejection. */
async function cancelManagedSessions(
  env: Cloudflare.Env,
  db: AppDb,
  organizationId: string,
  gateId: string,
  options: SessionActionOptions = {},
): Promise<void> {
  const rows = await listGatePyPiStageSessions(db, organizationId, gateId);
  for (const row of rows) {
    // A stale session is still open on the index with bytes nobody approved.
    const claimed = await transitionPyPiStageSession(db, row.id, ["held", "stale"], "canceling", {
      stateDetail: null,
    });
    if (!claimed) continue;
    await attemptCancel(env, db, claimed, options);
  }
}

async function attemptCancel(
  env: Cloudflare.Env,
  db: AppDb,
  row: PyPiStageSessionRow,
  options: SessionActionOptions,
): Promise<void> {
  const opened = await openSession(env, db, row, options);
  if ("error" in opened) {
    if (opened.tokenRemoved) await settle(db, row, ["canceling"], "token_removed", opened.error);
    else await touch(db, row, "canceling", opened.error);
    return;
  }
  try {
    await opened.gateway.cancel();
    await settle(db, row, ["canceling"], "canceled", null);
  } catch (err) {
    if (err instanceof PyPiSessionError && err.code === "session_not_found") {
      await settle(db, row, ["canceling"], "canceled", "the session was already gone");
      return;
    }
    await touch(db, row, "canceling", `cancel failed: ${safeSessionMessage(err)}; retrying`);
  }
}

// ── Cron ─────────────────────────────────────────────────────────────────────

export interface SweepOptions extends SessionActionOptions {
  now?: number;
}

/**
 * Bounded, idempotent upkeep for held sessions: extend those close to expiry,
 * observe external publish/cancel/expiry, poll `publishing`, retry
 * `canceling`. Never publishes and never cancels a session a human has not
 * rejected.
 */
export async function sweepManagedSessions(
  env: Cloudflare.Env,
  db: AppDb,
  options: SweepOptions = {},
): Promise<{ checked: number }> {
  const now = options.now ?? Date.now();
  const due = await listPyPiStageSessionsDue(db, new Date(now - SWEEP_RECHECK_MS), SWEEP_BATCH);
  await mapWithConcurrency(due, SWEEP_CONCURRENCY, async (row) => {
    try {
      await sweepOne(env, db, row, now, options);
    } catch (err) {
      emitOperationalEvent("error", "pypi.session.sweep_failed", {
        organizationId: row.organizationId,
        gateId: row.gateId,
        error: describeOperationalError(err),
      });
    }
  });
  return { checked: due.length };
}

async function sweepOne(
  env: Cloudflare.Env,
  db: AppDb,
  row: PyPiStageSessionRow & { gateStatus: WorkflowGateStatus },
  now: number,
  options: SweepOptions,
): Promise<void> {
  if (row.state === "canceling") {
    await attemptCancel(env, db, row, options);
    return;
  }
  const opened = await openSession(env, db, row, options);
  if ("error" in opened) {
    // Without its token the session can never be acted on again: stop polling.
    // A publish already sent stays `publishing` (see `markTokenSessionsRemoved`).
    if (opened.tokenRemoved && row.state !== "publishing") {
      await settle(db, row, [row.state], "token_removed", opened.error);
    } else {
      await touch(db, row, row.state, opened.error);
    }
    return;
  }
  if (row.state === "publishing") {
    const claimedAt = row.publishClaimedAt?.getTime() ?? row.updatedAt.getTime();
    await observePublishing(db, row, opened.gateway, {
      openIsRefusal: now - claimedAt > OPEN_AFTER_PUBLISH_GRACE_MS,
    });
    return;
  }

  const checked = await verifyHeldSession(db, row, opened.gateway, opened.links, {
    checkStage: false,
  });
  if ("error" in checked) return;
  const snapshot = checked.snapshot;
  const expiresAt = snapshot.expiresAt?.getTime() ?? null;
  // Registration happens while the gate is being reviewed, so the row's age
  // tracks the gate's age within minutes.
  const heldTooLong = now - row.createdAt.getTime() > MAX_HOLD_MS;
  const extendedRecently =
    row.lastExtendedAt !== null && now - row.lastExtendedAt.getTime() < EXTEND_MIN_INTERVAL_MS;
  // A gate that closed without a maintainer's rejection (an automatic block)
  // keeps its session untouched: no cancel, but no further extension either.
  const stopReason =
    row.gateStatus !== "pending"
      ? "no longer extended: the gate is no longer waiting for a decision"
      : heldTooLong
        ? "no longer extended: the gate's decision window has passed"
        : null;
  if (
    expiresAt !== null &&
    expiresAt - now < EXTEND_WINDOW_MS &&
    stopReason === null &&
    !extendedRecently
  ) {
    try {
      const extended = await opened.gateway.extend(snapshot, EXTEND_FOR_SECONDS);
      await transitionPyPiStageSession(db, row.id, ["held"], "held", {
        expiresAt: extended?.expiresAt ?? snapshot.expiresAt,
        lastExtendedAt: new Date(now),
        lastCheckedAt: new Date(now),
        stateDetail: extended ? null : "the index does not support extending sessions",
      });
      return;
    } catch (err) {
      await touch(db, row, "held", `extend failed: ${safeSessionMessage(err)}`);
      return;
    }
  }
  await transitionPyPiStageSession(db, row.id, ["held"], "held", {
    expiresAt: snapshot.expiresAt,
    lastCheckedAt: new Date(now),
    stateDetail: stopReason,
  });
}

// ── Shared steps ─────────────────────────────────────────────────────────────

async function openSession(
  env: Cloudflare.Env,
  db: AppDb,
  row: PyPiStageSessionRow,
  options: SessionActionOptions,
): Promise<
  { gateway: PyPiSessionGateway; links: SessionLinks } | { error: string; tokenRemoved?: true }
> {
  const tokenRow = row.tokenId
    ? await getPyPiProjectToken(db, row.organizationId, row.tokenId)
    : null;
  if (!tokenRow) return { error: TOKEN_REMOVED_DETAIL, tokenRemoved: true };
  if (tokenRow.projectName !== row.projectName || tokenRow.indexOrigin !== row.indexOrigin) {
    return { error: "the stored PyPI token is bound to a different project" };
  }
  const links = parseLinks(
    await openSecret(env, "pypi-session-links", {
      ciphertext: row.linksCiphertext,
      nonce: row.linksNonce,
    }),
  );
  if (!links) return { error: "the held session record is unreadable" };
  try {
    const gateway = createPyPiSessionGateway({
      token: await openPyPiToken(env, tokenRow),
      indexOrigin: tokenRow.indexOrigin,
      sessionUrl: links.session,
      fetchImpl: options.fetchImpl,
    });
    return { gateway, links };
  } catch (err) {
    return { error: safeSessionMessage(err) };
  }
}

/**
 * Re-read a held session and settle it if it is no longer ours to publish.
 * With `checkStage`, also re-read the stage page and require the staged
 * digests to equal the reviewed ones; byte changes keep their filename, so the
 * session's file map alone cannot show them.
 */
async function verifyHeldSession(
  db: AppDb,
  row: PyPiStageSessionRow,
  gateway: PyPiSessionGateway,
  links: SessionLinks,
  options: { checkStage: boolean },
): Promise<{ snapshot: PyPiSessionSnapshot } | { error: string }> {
  const reviewed = reviewedFiles(row);
  let snapshot: PyPiSessionSnapshot;
  try {
    snapshot = await gateway.status();
  } catch (err) {
    if (err instanceof PyPiSessionError && err.code === "session_not_found") {
      await settle(db, row, ["held"], "expired", "the session no longer exists on the index");
      return { error: `the ${row.projectName} PyPI session expired or was removed` };
    }
    await touch(db, row, "held", `status check failed: ${safeSessionMessage(err)}`);
    return {
      error: `could not check the ${row.projectName} PyPI session: ${safeSessionMessage(err)}`,
    };
  }
  const external = externalState(snapshot);
  if (external) {
    await settle(db, row, ["held"], external.state, external.detail);
    return { error: `the ${row.projectName} PyPI session was ${external.detail}` };
  }
  const problems = sessionBindingProblems(snapshot, {
    project: row.projectName,
    version: row.version,
    stageUrl: links.stage,
    filenames: reviewed.map((file) => file.filename),
  });
  if (options.checkStage && problems.length === 0) {
    const stageUrl = parseAllowedStageUrl(links.stage);
    if (!stageUrl) {
      problems.push("the stored stage is no longer on an allowed index");
    } else {
      try {
        const page = await fetchStageProjectPage(stageUrl, row.projectName);
        const selected = selectStagedReleaseFiles(page, row.projectName, row.version);
        problems.push(
          ...selected.problems,
          ...compareDistributionSets(
            "review",
            reviewed.map((file) => ({ path: file.filename, sha256: file.sha256 })),
            "stage",
            selected.files.map((file) => ({ path: file.filename, sha256: file.sha256 })),
          ),
        );
      } catch (err) {
        const message = err instanceof PyPiStageError ? err.message : "the stage could not be read";
        await touch(db, row, "held", message);
        return { error: `could not re-check the ${row.projectName} stage: ${message}` };
      }
    }
  }
  if (problems.length > 0) {
    const detail = `changed since review: ${summarizeProblems(problems)}`;
    await settle(db, row, ["held"], "stale", detail);
    return { error: `the ${row.projectName} PyPI session ${detail}` };
  }
  return { snapshot };
}

async function observePublishing(
  db: AppDb,
  row: PyPiStageSessionRow,
  gateway: PyPiSessionGateway,
  options: { openIsRefusal: boolean },
): Promise<PyPiStageSessionState> {
  try {
    const snapshot = await gateway.status();
    if (snapshot.status === "published") {
      await settle(db, row, ["publishing"], "published", null);
      return "published";
    }
    // An accepted publish moves the session to `processing`. Still `open`
    // after a failed publish request, or long after the claim, means the index
    // never took it (a 5xx that dropped the request, or a claim interrupted
    // before the request).
    if (snapshot.status === "open" && options.openIsRefusal) {
      await settle(db, row, ["publishing"], "error", "PyPI did not accept the publish");
      return "error";
    }
    if (snapshot.status === "error") {
      await settle(db, row, ["publishing"], "error", "PyPI reported an error while publishing");
      return "error";
    }
    if (snapshot.status === "canceled") {
      await settle(db, row, ["publishing"], "externally_canceled", "canceled outside Drydock");
      return "externally_canceled";
    }
    await touch(db, row, "publishing", null);
    return "publishing";
  } catch (err) {
    if (err instanceof PyPiSessionError && err.code === "session_not_found") {
      await settle(db, row, ["publishing"], "expired", "the session no longer exists on the index");
      return "expired";
    }
    await touch(db, row, "publishing", `status check failed: ${safeSessionMessage(err)}`);
    return "publishing";
  }
}

function externalState(
  snapshot: PyPiSessionSnapshot,
): { state: PyPiStageSessionState; detail: string } | null {
  switch (snapshot.status) {
    case "published":
    case "processing":
      return { state: "externally_published", detail: "published outside Drydock" };
    case "canceled":
      return { state: "externally_canceled", detail: "canceled outside Drydock" };
    case "error":
      return { state: "stale", detail: "put into an error state outside Drydock" };
    default:
      return null;
  }
}

async function settle(
  db: AppDb,
  row: PyPiStageSessionRow,
  from: readonly PyPiStageSessionState[],
  to: PyPiStageSessionState,
  detail: string | null,
): Promise<void> {
  const moved = await transitionPyPiStageSession(db, row.id, from, to, {
    stateDetail: detail,
    lastCheckedAt: new Date(),
  });
  if (!moved || to === "held") return;
  // A publish, even one the cron resolves later, carries out the approving
  // maintainer's decision. Other outcomes (an index error, an outside cancel,
  // expiry) are not that maintainer's act.
  await recordSessionEvent(
    db,
    row.organizationId,
    row.gateId,
    `pypi_session.${to}`,
    { projectName: row.projectName, version: row.version },
    to === "published" ? moved.approvedByUserId : null,
  );
  emitOperationalEvent(
    to === "error" || to === "stale" ? "warn" : "info",
    "pypi.session.transition",
    {
      organizationId: row.organizationId,
      gateId: row.gateId,
      state: to,
    },
  );
}

async function touch(
  db: AppDb,
  row: PyPiStageSessionRow,
  state: PyPiStageSessionState,
  detail: string | null,
): Promise<void> {
  await transitionPyPiStageSession(db, row.id, [state], state, {
    stateDetail: detail,
    lastCheckedAt: new Date(),
  });
}

async function recordSessionEvent(
  db: AppDb,
  organizationId: string,
  gateId: string,
  type: string,
  metadata: Record<string, unknown>,
  actorUserId: string | null = null,
): Promise<void> {
  try {
    await recordScanEvent(db, {
      organizationId,
      actorUserId,
      type,
      metadata: { gateId, ...metadata },
    });
  } catch (err) {
    emitOperationalEvent("warn", "pypi.session.event_failed", {
      organizationId,
      gateId,
      type,
      error: describeOperationalError(err),
    });
  }
}

function createGatewayOrThrow(
  options: Parameters<typeof createPyPiSessionGateway>[0],
): PyPiSessionGateway {
  try {
    return createPyPiSessionGateway(options);
  } catch (err) {
    throw new PyPiStageError("stage_session_mismatch", safeSessionMessage(err));
  }
}

function sessionStageError(project: string, err: unknown): PyPiStageError {
  return new PyPiStageError(
    "stage_session_mismatch",
    `${project} session: ${safeSessionMessage(err)}`,
  );
}

// Gateway errors are written without URLs or tokens; anything else is
// replaced rather than echoed.
function safeSessionMessage(err: unknown): string {
  return err instanceof PyPiSessionError || err instanceof PyPiStageError
    ? err.message
    : "unexpected error";
}

function parseLinks(text: string): SessionLinks | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (isRecord(raw) && typeof raw.session === "string" && typeof raw.stage === "string") {
      return { session: raw.session, stage: raw.stage };
    }
  } catch {
    // fall through
  }
  return null;
}

function reviewedFiles(row: PyPiStageSessionRow): ReviewedStagedFile[] {
  const raw = row.reviewedFilesJson;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (file): file is ReviewedStagedFile =>
      isRecord(file) && typeof file.filename === "string" && typeof file.sha256 === "string",
  );
}

function describeState(state: PyPiStageSessionState): string {
  return state.replace(/_/g, " ");
}

// ── Gate adapter capability ──────────────────────────────────────────────────

/** Browser-safe held sessions for a gate: no URLs, no token material. */
async function listGateHeldReleases(
  db: AppDb,
  organizationId: string,
  gateId: string,
): Promise<PublicHeldRelease[]> {
  const rows = await listGatePyPiStageSessions(db, organizationId, gateId);
  return rows.map((row) => {
    const view = publicPyPiStageSession(row);
    return {
      ecosystem: "pypi",
      projectName: view.projectName,
      version: view.version,
      index: view.indexOrigin,
      state: view.state,
      stateDetail: view.stateDetail,
      expiresAt: view.expiresAt,
      updatedAt: view.updatedAt,
    };
  });
}

export const pypiHeldReleases: HeldReleaseHooks = {
  list: listGateHeldReleases,
  verify: (env, db, organizationId, gateId) =>
    verifyManagedSessions(env, db, organizationId, gateId),
  publish: (env, db, organizationId, gateId, actorUserId) =>
    publishManagedSessions(env, db, organizationId, gateId, { actorUserId }),
  cancel: (env, db, organizationId, gateId) =>
    cancelManagedSessions(env, db, organizationId, gateId),
  sweep: async (env, db, now) => {
    await sweepManagedSessions(env, db, { now });
  },
  undeliveredApprovals: async (db, now) => {
    const gates = await listUndeliveredApprovedGates(
      db,
      {
        decidedAfter: new Date(now - MAX_HOLD_MS),
        decidedBefore: new Date(now - UNDELIVERED_APPROVAL_AFTER_MS),
        redeliverAfter: new Date(now - REDELIVER_FOR_MS),
      },
      UNDELIVERED_APPROVAL_BATCH,
    );
    return gates.flatMap(({ organizationId, gateId, states }) => {
      const settlement = settleUndeliveredApproval(states);
      return settlement ? [{ organizationId, gateId, settlement }] : [];
    });
  },
};

/**
 * An approval GitHub never acknowledged: deliver it once every session is
 * published by Drydock, wait while one is still publishing, otherwise reject.
 * `externally_published` is not ours: those bytes were never re-checked after
 * the approval.
 */
function settleUndeliveredApproval(states: PyPiStageSessionState[]): "deliver" | "reject" | null {
  if (states.some((state) => state === "publishing")) return null;
  return states.every((state) => state === "published") ? "deliver" : "reject";
}
