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
  supersedePyPiStageSessions,
  transitionPyPiStageSession,
  updatePyPiProjectToken,
  upsertPyPiStageSession,
} from "../../../db/pypi-stage-sessions";
import { MAX_STREAMED_TOTAL_ARTIFACT_ZIP_BYTES } from "../../github-app/artifacts";
import { mapWithConcurrency } from "../../platform/concurrency";
import { isRecord } from "../../platform/guards";
import { describeOperationalError, emitOperationalEvent } from "../../platform/observability";
import { openSecret, sealSecret } from "../../platform/secret-box";
import { normalizePyPiProjectName } from "./manifest";
import { openPyPiToken } from "./project-token";
import {
  type PyPiFileUpload,
  type PyPiSessionGateway,
  type PyPiSessionSnapshot,
  PyPiSessionError,
  createPyPiSessionGateway,
  openPyPiSession,
  sessionBindingProblems,
  sessionFingerprint,
} from "./session-gateway";
import {
  PyPiStageError,
  basename,
  compareDistributionSets,
  digestPrefix,
  parseAllowedStageUrl,
  selectStagedReleaseFiles,
  summarizeProblems,
} from "./stage";
import { fetchStageProjectPage } from "./stage-fetch";
import type {
  HeldReleaseHooks,
  PublicHeldRelease,
  StagedReleaseInput,
} from "../../workflow-gates/types";

/**
 * PEP 694 mode B (preview, opt-in per project): Drydock creates, stages,
 * holds, and publishes the session. The workflow holds no PyPI credential.
 *
 *   create/adopt ──► staging ──(uploads verified on the stage)──► held
 *                      │  └──(upload or verify failed; file removed)──► upload_failed
 *                      │                       (a retried review restages it)
 *   held ──(approval recorded; re-verify)──► publishing ──► published
 *    │  │                  │ files changed        │ 409/4xx, index error, or
 *    │  │                  └──► stale             │ still open (see below) ──► error
 *    │  │                                         └─(transport/5xx: unknown, poll)
 *    │  └──(human reject; also from stale, staging, upload_failed)──► canceling ──► canceled
 *    ├──(cron observes)──► expired | externally_published | externally_canceled | stale
 *    ├──(a later gate adopts the same index session)──► superseded
 *    └──(token deleted; also from stale, staging, upload_failed, canceling)──► token_removed
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

export interface ManagedRelease {
  name: string;
  version: string;
  index: string;
  /** The reviewed bundle files for this project: artifact path + digest. */
  reviewed: Array<{ path: string; sha256: string }>;
}

export interface StagingContext {
  env: Cloudflare.Env;
  db: AppDb;
  organizationId: string;
  gateId: string;
  rereadReleaseFiles: StagedReleaseInput["rereadReleaseFiles"];
  fetchImpl?: typeof fetch;
  completionPollDelaysMs?: number[];
}

/**
 * A staging step failed in a way a retry can fix (the index was unreachable,
 * an upload failed and was removed). Not a `WorkflowArtifactError`, so the gate
 * stays pending; the session row records what happened. Messages carry no
 * URLs or token material.
 */
class PyPiStagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PyPiStagingError";
  }
}

interface StagingSession {
  release: ManagedRelease;
  project: string;
  row: PyPiStageSessionRow;
  tokenId: string;
  gateway: PyPiSessionGateway;
  snapshot: PyPiSessionSnapshot;
  links: SessionLinks;
  /** basename → reviewed sha256 */
  expected: Map<string, string>;
  uploaded: Set<string>;
}

/**
 * Mode B: Drydock creates each opted-in project's PEP 694 session with the
 * organization's stored project token, uploads the reviewed artifact bytes
 * itself, and verifies through the stage page that the session holds exactly
 * those bytes. The workflow holds no PyPI credential and never names a
 * session. Returns the normalized projects now held.
 *
 * Bytes come from a second read of the workflow run's artifacts, and each
 * file's sha256 must equal the reviewed digest before it is uploaded. A
 * failed upload is deleted from the session and the row is left
 * `upload_failed` (never publishable); the gate stays pending for a retry.
 */
export async function stageManagedReleases(
  ctx: StagingContext,
  releases: ManagedRelease[],
): Promise<Set<string>> {
  if (releases.length === 0) return new Set();
  // Every project needs its token before any project's session is touched.
  for (const release of releases) {
    const project = normalizePyPiProjectName(release.name);
    if (!(await findPyPiProjectToken(ctx.db, ctx.organizationId, release.index, project))) {
      throw new PyPiStageError(
        "stage_reference_invalid",
        `Drydock-held staging for ${release.name} needs a PyPI token for the project on ${release.index} (Settings, Integrations, PyPI project tokens)`,
      );
    }
  }
  const sessions: StagingSession[] = [];
  try {
    for (const release of releases) sessions.push(await openStagingSession(ctx, release));
    return await uploadAndVerify(ctx, sessions);
  } catch (err) {
    // A row a specific failure already marked keeps its detail; any other
    // row still `staging` is never left looking like work in progress.
    for (const session of sessions) {
      await markUploadFailed(
        ctx.db,
        session.row,
        "staging stopped before this project's session was verified",
        ["staging"],
      );
    }
    throw err;
  }
}

async function uploadAndVerify(
  ctx: StagingContext,
  sessions: StagingSession[],
): Promise<Set<string>> {
  const byPath = new Map<string, StagingSession>();
  for (const session of sessions) {
    for (const file of session.release.reviewed) byPath.set(file.path, session);
  }
  await uploadFromArtifacts(ctx, byPath, { remaining: MAX_MANAGED_UPLOAD_BYTES });

  const held = new Set<string>();
  for (const session of sessions) {
    const missing = [...session.expected.keys()].filter((name) => !session.uploaded.has(name));
    if (missing.length > 0) {
      await markUploadFailed(ctx.db, session.row, `not uploaded: ${missing.join(", ")}`);
      throw new PyPiStageError(
        "stage_session_mismatch",
        `the workflow run no longer carries ${summarizeProblems(missing)} for ${session.release.name}`,
      );
    }
    const checked = await verifyStagedSession(session);
    if ("error" in checked) {
      await markUploadFailed(ctx.db, session.row, checked.error);
      throw new PyPiStageError(
        "stage_session_mismatch",
        `${session.release.name} session: ${checked.error}`,
      );
    }
    const moved = await transitionPyPiStageSession(ctx.db, session.row.id, ["staging"], "held", {
      stateDetail: null,
      expiresAt: checked.snapshot.expiresAt,
      lastCheckedAt: new Date(),
    });
    if (!moved) {
      throw new PyPiStagingError(`the ${session.project} PyPI session changed state while staging`);
    }
    await updatePyPiProjectToken(ctx.db, ctx.organizationId, session.tokenId, {
      lastUsedAt: new Date(),
    });
    await recordSessionEvent(ctx.db, ctx.organizationId, ctx.gateId, "pypi_session.held", {
      projectName: session.project,
      version: session.release.version,
    });
    held.add(session.project);
  }
  return held;
}

// The same release-wide budget the artifact path and the mode A stage check
// spend; the second artifact read is bounded by it as well.
const MAX_MANAGED_UPLOAD_BYTES = MAX_STREAMED_TOTAL_ARTIFACT_ZIP_BYTES;

/**
 * Upload each reviewed file as the second artifact read streams it, one file
 * in memory at a time. A file whose bytes no longer hash to the reviewed
 * digest is never uploaded.
 */
async function uploadFromArtifacts(
  ctx: StagingContext,
  byPath: Map<string, StagingSession>,
  budget: { remaining: number },
): Promise<void> {
  await ctx.rereadReleaseFiles(async (file) => {
    const session = byPath.get(file.path);
    if (!session) return;
    const filename = basename(file.path);
    const reviewedSha = session.expected.get(filename) ?? "";
    if (reviewedSha !== file.sha256) {
      throw new PyPiStageError(
        "stage_session_mismatch",
        `${filename} changed between review and staging: reviewed ${digestPrefix(reviewedSha)}, now ${digestPrefix(file.sha256)}`,
      );
    }
    if (session.uploaded.has(filename)) return;
    budget.remaining -= file.bytes.byteLength;
    if (budget.remaining < 0) {
      throw new PyPiStageError(
        "stage_unavailable",
        `the release exceeds the ${MAX_MANAGED_UPLOAD_BYTES}-byte upload budget`,
      );
    }
    await uploadReviewedFile(ctx, session, filename, file.bytes, file.sha256);
    session.uploaded.add(filename);
  });
}

async function openStagingSession(
  ctx: StagingContext,
  release: ManagedRelease,
): Promise<StagingSession> {
  const project = normalizePyPiProjectName(release.name);
  const tokenRow = await findPyPiProjectToken(ctx.db, ctx.organizationId, release.index, project);
  // Checked up front in `stageManagedReleases`; gone now means it was just removed.
  if (!tokenRow) throw new PyPiStagingError(`the PyPI token for ${release.name} was removed`);
  let opened: Awaited<ReturnType<typeof openPyPiSession>>;
  try {
    opened = await openPyPiSession(
      {
        token: await openPyPiToken(ctx.env, tokenRow),
        indexOrigin: tokenRow.indexOrigin,
        fetchImpl: ctx.fetchImpl,
        completionPollDelaysMs: ctx.completionPollDelaysMs,
      },
      { name: release.name, version: release.version },
    );
  } catch (err) {
    throw stagingFailure(release.name, "could not open a session", err);
  }
  const { gateway, snapshot } = opened;
  if (snapshot.status !== "open") {
    throw new PyPiStagingError(
      `${release.name} ${release.version} already has a PyPI session that is ${snapshot.status}; it cannot be staged until that session ends`,
    );
  }
  const stage = snapshot.links.stage;
  if (!stage || parseAllowedStageUrl(stage)?.origin !== release.index) {
    throw new PyPiStageError(
      "stage_session_mismatch",
      `${release.name} session: the index's stage link is not on ${release.index}`,
    );
  }
  const links: SessionLinks = { session: snapshot.links.session, stage };
  const fingerprint = await sessionFingerprint(links.session);
  const busy = await supersedePyPiStageSessions(ctx.db, {
    organizationId: ctx.organizationId,
    sessionFingerprint: fingerprint,
    exceptGateId: ctx.gateId,
  });
  if (busy) {
    throw new PyPiStagingError(
      `another gate's ${release.name} session is ${describeState(busy)}; staging waits for it`,
    );
  }
  const sealed = await sealSecret(ctx.env, "pypi-session-links", JSON.stringify(links));
  const reviewed: ReviewedStagedFile[] = release.reviewed.map((file) => ({
    filename: basename(file.path),
    sha256: file.sha256,
  }));
  const stored = await upsertPyPiStageSession(ctx.db, {
    organizationId: ctx.organizationId,
    gateId: ctx.gateId,
    tokenId: tokenRow.id,
    projectName: project,
    version: release.version,
    indexOrigin: release.index,
    linksCiphertext: sealed.ciphertext,
    linksNonce: sealed.nonce,
    sessionFingerprint: fingerprint,
    reviewedFilesJson: reviewed,
    expiresAt: snapshot.expiresAt,
    lastCheckedAt: new Date(),
  });
  if (!("row" in stored)) {
    throw new PyPiStageError(
      "stage_session_mismatch",
      `${release.name} session: this gate's session for the project is ${describeState(stored.blockedBy ?? "error")} and cannot be staged again`,
    );
  }
  const session: StagingSession = {
    release,
    project,
    row: stored.row,
    tokenId: tokenRow.id,
    gateway,
    snapshot,
    links,
    expected: new Map(reviewed.map((file) => [file.filename, file.sha256])),
    uploaded: new Set(),
  };
  // An adopted session (a retry, or a re-run of the same release) may hold
  // files from an earlier attempt. Drydock cannot tell from the session which
  // bytes they are, so it removes them all and uploads the reviewed set.
  for (const [filename, file] of snapshot.files) {
    if (!file.link) {
      await markUploadFailed(ctx.db, stored.row, `${filename} cannot be removed from the session`);
      throw new PyPiStagingError(
        `${release.name} session holds ${filename}, which the index offers no way to remove`,
      );
    }
    try {
      await gateway.deleteFile(file.link);
    } catch (err) {
      await markUploadFailed(
        ctx.db,
        stored.row,
        `could not remove ${filename} left by an earlier attempt: ${safeSessionMessage(err)}`,
      );
      throw stagingFailure(release.name, `could not remove ${filename}`, err);
    }
  }
  return session;
}

async function uploadReviewedFile(
  ctx: StagingContext,
  session: StagingSession,
  filename: string,
  bytes: Uint8Array,
  sha256: string,
): Promise<void> {
  let upload: PyPiFileUpload | null = null;
  try {
    upload = await session.gateway.createFileUpload(session.snapshot, {
      filename,
      size: bytes.byteLength,
      sha256,
    });
    await session.gateway.uploadFileBytes(upload, bytes);
    await session.gateway.completeFileUpload(upload);
  } catch (err) {
    let removed = upload === null;
    if (upload) {
      try {
        await session.gateway.deleteFile(upload.link);
        removed = true;
      } catch {
        removed = false;
      }
    }
    const detail = `upload of ${filename} failed: ${safeSessionMessage(err)}; ${
      removed ? "nothing of it is left in the session" : "removing the partial upload also failed"
    }`;
    await markUploadFailed(ctx.db, session.row, detail);
    throw indexMisbehaved(err)
      ? new PyPiStageError("stage_session_mismatch", `${session.release.name}: ${detail}`)
      : new PyPiStagingError(`${session.release.name}: ${detail}`);
  }
}

/** The created session holds exactly the reviewed files, and its stage serves their digests. */
async function verifyStagedSession(
  session: StagingSession,
): Promise<{ snapshot: PyPiSessionSnapshot } | { error: string }> {
  let snapshot: PyPiSessionSnapshot;
  try {
    snapshot = await session.gateway.status();
  } catch (err) {
    throw stagingFailure(session.release.name, "could not re-read the session", err);
  }
  const reviewed = [...session.expected].map(([filename, sha256]) => ({ filename, sha256 }));
  const problems = sessionBindingProblems(snapshot, {
    project: session.release.name,
    version: session.release.version,
    stageUrl: session.links.stage,
    filenames: reviewed.map((file) => file.filename),
  });
  if (problems.length === 0) {
    let page: Awaited<ReturnType<typeof fetchStageProjectPage>>;
    try {
      // Validated in `openStagingSession`.
      page = await fetchStageProjectPage(new URL(session.links.stage), session.release.name);
    } catch (err) {
      throw stagingFailure(session.release.name, "could not read the stage", err);
    }
    const selected = selectStagedReleaseFiles(page, session.release.name, session.release.version);
    problems.push(
      ...selected.problems,
      ...compareDistributionSets(
        "review",
        reviewed.map((file) => ({ path: file.filename, sha256: file.sha256 })),
        "stage",
        selected.files.map((file) => ({ path: file.filename, sha256: file.sha256 })),
      ),
    );
  }
  return problems.length > 0 ? { error: summarizeProblems(problems) } : { snapshot };
}

async function markUploadFailed(
  db: AppDb,
  row: PyPiStageSessionRow,
  detail: string,
  from: readonly PyPiStageSessionState[] = ["staging", "upload_failed"],
): Promise<void> {
  await settle(db, row, from, "upload_failed", detail);
}

// A refused URL, a redirect, or a malformed answer is the index misbehaving,
// not a transient fault: fail closed. Everything else can be retried.
function indexMisbehaved(err: unknown): boolean {
  return (
    err instanceof PyPiSessionError &&
    (err.code === "session_url_refused" ||
      err.code === "session_redirect_refused" ||
      err.code === "session_malformed")
  );
}

function stagingFailure(project: string, what: string, err: unknown): Error {
  if (err instanceof PyPiStageError) return err;
  if (indexMisbehaved(err)) {
    return new PyPiStageError(
      "stage_session_mismatch",
      `${project} session: ${safeSessionMessage(err)}`,
    );
  }
  return new PyPiStagingError(`${project}: ${what}: ${safeSessionMessage(err)}`);
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
  const rows = await listGatePyPiStageSessions(db, organizationId, gateId);
  const blocked = notPublishable(rows);
  if (blocked) return { ok: false, error: blocked };
  for (const row of rows) {
    const checked = await prepareHeldSession(env, db, row, options);
    if ("error" in checked) return { ok: false, error: checked.error };
  }
  return { ok: true };
}

/**
 * Runs only after the approval that completes the gate is durably recorded
 * (the gate CAS out of `pending`), so no concurrent rejection can land while
 * an irreversible publish is in flight. Publishes the held sessions one by
 * one, re-verifying each session and its stage right before its own claim:
 * publishing an earlier project takes time a later stage could change in. A
 * definite failure returns `ok: false`; the caller turns the approval into a
 * fail-closed rejection. An unknown outcome (transport failure, 5xx) stays
 * `publishing` for the cron to resolve.
 */
export async function publishManagedSessions(
  env: Cloudflare.Env,
  db: AppDb,
  organizationId: string,
  gateId: string,
  options: SessionActionOptions = {},
): Promise<ManagedPublishResult> {
  const rows = await listGatePyPiStageSessions(db, organizationId, gateId);
  const blocked = notPublishable(rows);
  if (blocked) return { ok: false, error: blocked };

  for (const row of rows) {
    const checked = await prepareHeldSession(env, db, row, options);
    if ("error" in checked) return { ok: false, error: checked.error };
    const { gateway, snapshot } = checked;
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

function notPublishable(rows: PyPiStageSessionRow[]): string | null {
  const row = rows.find((candidate) => candidate.state !== "held");
  return row
    ? `the ${row.projectName} PyPI session is ${describeState(row.state)}; it cannot be published`
    : null;
}

/** Open one held session and re-verify it and its stage against the review. */
async function prepareHeldSession(
  env: Cloudflare.Env,
  db: AppDb,
  row: PyPiStageSessionRow,
  options: SessionActionOptions,
): Promise<{ gateway: PyPiSessionGateway; snapshot: PyPiSessionSnapshot } | { error: string }> {
  const opened = await openSession(env, db, row, options);
  if ("error" in opened) return { error: opened.error };
  const checked = await verifyHeldSession(db, row, opened.gateway, opened.links, {
    checkStage: true,
  });
  if ("error" in checked) return { error: checked.error };
  return { gateway: opened.gateway, snapshot: checked.snapshot };
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
    // Stale and not-yet-held sessions are still open on the index with bytes
    // nobody approved.
    const claimed = await transitionPyPiStageSession(
      db,
      row.id,
      ["held", "stale", "staging", "upload_failed"],
      "canceling",
      { stateDetail: null },
    );
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
