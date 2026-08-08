import { Hono, type Context } from "hono";
import { createDb, type AppDb } from "../db/client";
import {
  getReleaseSet,
  listReleaseArtifacts,
  listReleaseSetScans,
  markReleaseSetVerified,
  openReleaseSet,
  recordReleaseArtifact,
  sealReleaseSet,
  type CiReleaseSetRecord,
} from "../db/ci-release-sets";
import { recordScanEvent } from "../db/events";
import { RateLimitError, enforceRateLimit } from "../db/rate-limit";
import {
  CiRepositoryError,
  inferReleaseSetEcosystem,
  resolveCiRepository,
} from "../lib/ci/repository";
import {
  normalizeArtifactPath,
  normalizeReleaseKey,
  normalizeSha256,
  readBoundedBody,
  sha256Hex,
} from "../lib/ci/ingest";
import {
  MAX_RELEASE_ARTIFACT_BYTES,
  MAX_RELEASE_SET_ARTIFACTS,
  MAX_RELEASE_SET_BYTES,
  putReleaseArtifact,
  releaseArtifactKey,
} from "../lib/ci/release-store";
import {
  CiOidcError,
  readBearerToken,
  verifyGithubOidcToken,
  type GithubOidcClaims,
} from "../lib/ci/oidc";
import { isEcosystemId } from "../lib/ecosystems/labels";
import { supportedWorkflowGateEcosystems } from "../lib/ecosystems";
import { recordProductEvent } from "../lib/platform/analytics";
import { describeOperationalError, emitOperationalEvent } from "../lib/platform/observability";
import type { Bindings, Variables } from "../types";

/**
 * Push-based CI ingest.
 *
 * These routes are the only `/api/*` surface besides the anonymous package-diff
 * endpoints that does not carry a Better Auth session — they are authenticated,
 * just by GitHub's OIDC rather than by a browser session, and they are mounted
 * ahead of the session and CSRF middleware for that reason (a workflow runner
 * has no cookie and sends no Origin). Every handler re-derives the organization
 * from the verified token; nothing here trusts a caller-supplied id.
 *
 * See `docs/ci-action.md` for the workflow-side contract.
 */
export const ciReleaseRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

type CiContext = Context<{ Bindings: Bindings; Variables: Variables }>;

interface CiCaller {
  claims: GithubOidcClaims;
  organizationId: string;
  installationRowId: string;
  /** Ecosystem pinned by the repository's release targets, if they agree. */
  inferredEcosystem: string | null;
}

/**
 * Authenticate a CI request and resolve the organization the release belongs
 * to. Returns a `Response` on failure so handlers can `if (…instanceof
 * Response) return …` without a second error-shaping layer.
 */
async function authenticateCi(c: CiContext, db: AppDb): Promise<CiCaller | Response> {
  const token = readBearerToken(c.req.header("authorization"));
  if (!token) {
    return c.json(
      { error: "missing OIDC bearer token", hint: "the job needs `permissions: id-token: write`" },
      401,
    );
  }

  let claims: GithubOidcClaims;
  try {
    claims = await verifyGithubOidcToken(c.env, token);
  } catch (err) {
    if (err instanceof CiOidcError) {
      emitOperationalEvent("warn", "ci_release.oidc_rejected", { reason: err.code });
      // `jwks_unavailable` is our problem, not the caller's: a 503 tells the
      // Action to retry instead of failing the release outright.
      return c.json(
        { error: "OIDC token rejected", reason: err.code },
        err.code === "jwks_unavailable" ? 503 : 401,
      );
    }
    throw err;
  }

  try {
    const resolved = await resolveCiRepository(db, claims);
    return {
      claims,
      organizationId: resolved.organizationId,
      installationRowId: resolved.installation.id,
      inferredEcosystem: inferReleaseSetEcosystem(resolved.releaseTargets),
    };
  } catch (err) {
    if (err instanceof CiRepositoryError) {
      emitOperationalEvent("warn", "ci_release.repository_unresolved", {
        reason: err.code,
        repositoryId: claims.repositoryId,
      });
      return c.json({ error: err.message, reason: err.code }, 403);
    }
    throw err;
  }
}

/**
 * Load a release set and confirm the caller's token belongs to the same run
 * that opened it. Without this a token for run B could upload into run A's
 * set — same repository, so the org check above would not catch it.
 */
async function loadOwnedSet(
  c: CiContext,
  db: AppDb,
  caller: CiCaller,
  releaseSetId: string,
): Promise<CiReleaseSetRecord | Response> {
  const set = await getReleaseSet(db, caller.organizationId, releaseSetId);
  if (!set) return c.json({ error: "release set not found" }, 404);
  if (
    set.repositoryId !== caller.claims.repositoryId ||
    set.runId !== caller.claims.runId ||
    set.runAttempt !== caller.claims.runAttempt
  ) {
    return c.json({ error: "release set belongs to a different workflow run" }, 403);
  }
  return set;
}

function rateLimited(c: CiContext, message: string, err: RateLimitError) {
  return c.json({ error: message, retryAfterSeconds: err.retryAfterSeconds }, 429, {
    "retry-after": String(err.retryAfterSeconds),
  });
}

// ── Open ─────────────────────────────────────────────────────────────────────

ciReleaseRoutes.post("/releases", async (c) => {
  const db = createDb(c.env.DB);
  const caller = await authenticateCi(c, db);
  if (caller instanceof Response) return caller;

  const body = (await c.req.json().catch(() => ({}))) as {
    releaseKey?: unknown;
    ecosystem?: unknown;
  };

  const releaseKey = normalizeReleaseKey(body.releaseKey);
  if (releaseKey === null) {
    return c.json({ error: "releaseKey must be a short alphanumeric identifier" }, 400);
  }

  // An explicit ecosystem pins the classifier; otherwise inherit whatever the
  // repository's release targets agree on, and fall back to auto-detection —
  // which is the right answer for a monorepo publishing to several registries.
  const requested = typeof body.ecosystem === "string" ? body.ecosystem.trim() : "";
  let ecosystem: string | null;
  if (requested === "" || requested === "auto") {
    ecosystem = caller.inferredEcosystem;
  } else if (isEcosystemId(requested) && supportedWorkflowGateEcosystems().includes(requested)) {
    ecosystem = requested;
  } else {
    return c.json(
      {
        error: `unsupported ecosystem: ${requested}`,
        supported: supportedWorkflowGateEcosystems(),
      },
      400,
    );
  }

  try {
    await enforceRateLimit(db, {
      key: `ci-release-open:${caller.organizationId}`,
      limit: 120,
      windowMs: 60 * 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) return rateLimited(c, "release rate limit exceeded", err);
    throw err;
  }

  const { set, created } = await openReleaseSet(db, {
    organizationId: caller.organizationId,
    installationRowId: caller.installationRowId,
    repositoryId: caller.claims.repositoryId,
    repositoryFullName: caller.claims.repository,
    runId: caller.claims.runId,
    runAttempt: caller.claims.runAttempt,
    releaseKey,
    ecosystem,
    sha: caller.claims.sha || null,
    ref: caller.claims.ref || null,
    workflowRef: caller.claims.workflowRef || null,
    jobWorkflowRef: caller.claims.jobWorkflowRef || null,
    actor: caller.claims.actor || null,
    eventName: caller.claims.eventName || null,
  });

  if (created) {
    await recordScanEvent(db, {
      organizationId: caller.organizationId,
      type: "ci_release_set.opened",
      metadata: {
        releaseSetId: set.id,
        repositoryFullName: set.repositoryFullName,
        runId: set.runId,
        runAttempt: set.runAttempt,
        releaseKey: set.releaseKey || null,
        ecosystem: set.ecosystem ?? "auto",
        jobWorkflowRef: set.jobWorkflowRef,
      },
    });
    recordProductEvent(c.env, {
      name: "ci_release_set.opened",
      organizationId: caller.organizationId,
    });
  }

  return c.json({ releaseSet: publicReleaseSet(c.env, set, []), created }, created ? 201 : 200);
});

// ── Upload ───────────────────────────────────────────────────────────────────

ciReleaseRoutes.put("/releases/:id/artifacts/:path", async (c) => {
  const db = createDb(c.env.DB);
  const caller = await authenticateCi(c, db);
  if (caller instanceof Response) return caller;

  const set = await loadOwnedSet(c, db, caller, c.req.param("id"));
  if (set instanceof Response) return set;
  if (set.status !== "open") {
    return c.json(
      { error: `release set is ${set.status}; artifacts can only be added while it is open` },
      409,
    );
  }

  const path = normalizeArtifactPath(c.req.param("path"));
  if (!path) return c.json({ error: "artifact name must be a flat, safe filename" }, 400);

  const declaredDigest = normalizeSha256(c.req.header("x-drydock-sha256"));
  if (!declaredDigest) {
    return c.json({ error: "x-drydock-sha256 must be a hex SHA-256 digest" }, 400);
  }

  if (!c.env.ARTIFACTS) {
    emitOperationalEvent("error", "ci_release.storage_unconfigured", { releaseSetId: set.id });
    return c.json({ error: "artifact storage is not configured" }, 503);
  }

  const existing = await listReleaseArtifacts(db, set.id);
  const replacing = existing.find((artifact) => artifact.path === path);
  if (!replacing && existing.length >= MAX_RELEASE_SET_ARTIFACTS) {
    return c.json(
      { error: `a release set holds at most ${MAX_RELEASE_SET_ARTIFACTS} artifacts` },
      413,
    );
  }

  try {
    await enforceRateLimit(db, {
      key: `ci-release-upload:${caller.organizationId}`,
      limit: 600,
      windowMs: 60 * 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) return rateLimited(c, "upload rate limit exceeded", err);
    throw err;
  }

  const body = await readBoundedBody(c.req.raw, MAX_RELEASE_ARTIFACT_BYTES);
  if (body.tooLarge) {
    return c.json({ error: `artifact exceeds the ${MAX_RELEASE_ARTIFACT_BYTES} byte limit` }, 413);
  }
  if (body.bytes.byteLength === 0) return c.json({ error: "artifact body is empty" }, 400);

  const carriedBytes = existing.reduce(
    (total, artifact) => total + (artifact.path === path ? 0 : artifact.sizeBytes),
    0,
  );
  if (carriedBytes + body.bytes.byteLength > MAX_RELEASE_SET_BYTES) {
    return c.json({ error: `release set exceeds the ${MAX_RELEASE_SET_BYTES} byte limit` }, 413);
  }

  // Recompute rather than trust: the digest we record, show as provenance, and
  // later compare the publish-time bytes against must be one we derived from
  // the bytes we actually received.
  const actualDigest = await sha256Hex(body.bytes);
  if (actualDigest !== declaredDigest) {
    emitOperationalEvent("warn", "ci_release.digest_mismatch", {
      organizationId: caller.organizationId,
      releaseSetId: set.id,
      path,
    });
    return c.json(
      { error: "uploaded bytes do not match the declared sha256", declaredDigest, actualDigest },
      422,
    );
  }

  const artifactId = crypto.randomUUID();
  const storageKey = releaseArtifactKey(caller.organizationId, set.id, artifactId);
  await putReleaseArtifact(c.env.ARTIFACTS, storageKey, body.bytes);
  const artifact = await recordReleaseArtifact(db, {
    releaseSetId: set.id,
    organizationId: caller.organizationId,
    path,
    sha256: actualDigest,
    sizeBytes: body.bytes.byteLength,
    storageKey,
  });

  return c.json({
    artifact: { path: artifact.path, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes },
    replaced: Boolean(replacing),
  });
});

// ── Seal ─────────────────────────────────────────────────────────────────────

ciReleaseRoutes.post("/releases/:id/seal", async (c) => {
  const db = createDb(c.env.DB);
  const caller = await authenticateCi(c, db);
  if (caller instanceof Response) return caller;

  const set = await loadOwnedSet(c, db, caller, c.req.param("id"));
  if (set instanceof Response) return set;

  // Re-sealing is a retried job, not an error: report the current state.
  if (set.status !== "open") {
    const artifacts = await listReleaseArtifacts(db, set.id);
    return c.json({ releaseSet: publicReleaseSet(c.env, set, artifacts), sealed: false });
  }

  const artifacts = await listReleaseArtifacts(db, set.id);
  if (artifacts.length === 0) {
    return c.json({ error: "cannot seal a release set with no artifacts" }, 400);
  }

  const sealed = await sealReleaseSet(db, caller.organizationId, set.id);
  if (!sealed) {
    const current = await getReleaseSet(db, caller.organizationId, set.id);
    return c.json({
      releaseSet: current ? publicReleaseSet(c.env, current, artifacts) : null,
      sealed: false,
    });
  }

  await recordScanEvent(db, {
    organizationId: caller.organizationId,
    type: "ci_release_set.sealed",
    metadata: {
      releaseSetId: sealed.id,
      artifactCount: artifacts.length,
      totalBytes: sealed.totalBytes,
    },
  });

  await enqueueReleaseSetReview(c, caller.organizationId, sealed.id);

  return c.json({ releaseSet: publicReleaseSet(c.env, sealed, artifacts), sealed: true });
});

/**
 * Hand the sealed set to the review queue. Falls back to an inline
 * `waitUntil` run when no queue is bound, which is what local dev and the
 * worker test suite use.
 */
async function enqueueReleaseSetReview(
  c: CiContext,
  organizationId: string,
  releaseSetId: string,
): Promise<void> {
  if (c.env.SCAN_QUEUE) {
    await c.env.SCAN_QUEUE.send({ kind: "ci_release_set", organizationId, releaseSetId });
    return;
  }
  const { executeCiReleaseSetJob } = await import("../lib/ci/release-set-job");
  const executionCtx = c.executionCtx;
  const run = executeCiReleaseSetJob(c.env, executionCtx, {
    kind: "ci_release_set",
    organizationId,
    releaseSetId,
  }).catch((err) => {
    emitOperationalEvent("error", "ci_release_set.inline_review_failed", {
      organizationId,
      releaseSetId,
      error: describeOperationalError(err),
    });
  });
  executionCtx.waitUntil(run);
}

// ── Status ───────────────────────────────────────────────────────────────────

ciReleaseRoutes.get("/releases/:id", async (c) => {
  const db = createDb(c.env.DB);
  const caller = await authenticateCi(c, db);
  if (caller instanceof Response) return caller;

  const set = await loadOwnedSet(c, db, caller, c.req.param("id"));
  if (set instanceof Response) return set;

  const artifacts = await listReleaseArtifacts(db, set.id);
  const packages = await listReleaseSetScans(db, {
    releaseSetId: set.id,
    organizationId: caller.organizationId,
  });
  return c.json({ releaseSet: publicReleaseSet(c.env, set, artifacts, packages) });
});

// ── Publish-time verification ────────────────────────────────────────────────

ciReleaseRoutes.post("/releases/:id/verify", async (c) => {
  const db = createDb(c.env.DB);
  const caller = await authenticateCi(c, db);
  if (caller instanceof Response) return caller;

  const set = await loadOwnedSet(c, db, caller, c.req.param("id"));
  if (set instanceof Response) return set;
  // An open set's artifact list can still change, so "these digests match what
  // was reviewed" would be a claim about nothing. Sealing fixes the set, which
  // is the earliest point the comparison means anything.
  if (set.status === "open") {
    return c.json({ error: "release set is still open; seal it before verifying against it" }, 409);
  }

  const body = (await c.req.json().catch(() => ({}))) as { artifacts?: unknown };
  if (!Array.isArray(body.artifacts) || body.artifacts.length === 0) {
    return c.json({ error: "artifacts must be a non-empty array of { path, sha256 }" }, 400);
  }

  const declared = new Map<string, string>();
  for (const entry of body.artifacts) {
    if (!entry || typeof entry !== "object") {
      return c.json({ error: "each artifact must be an object" }, 400);
    }
    const path = normalizeArtifactPath(String((entry as { path?: unknown }).path ?? ""));
    const sha256 = normalizeSha256((entry as { sha256?: unknown }).sha256);
    if (!path || !sha256) {
      return c.json({ error: "each artifact needs a valid path and sha256" }, 400);
    }
    declared.set(path, sha256);
  }

  const reviewed = await listReleaseArtifacts(db, set.id);
  const reviewedByPath = new Map(reviewed.map((artifact) => [artifact.path, artifact.sha256]));

  // Every reviewed artifact must still be present at the same digest, and the
  // publish step must not have invented an artifact Drydock never saw. Both
  // directions matter: the first catches a rebuild, the second catches a
  // smuggled extra package.
  const mismatches: { path: string; reviewed: string | null; publishing: string | null }[] = [];
  for (const [path, sha256] of reviewedByPath) {
    const publishing = declared.get(path) ?? null;
    if (publishing !== sha256) mismatches.push({ path, reviewed: sha256, publishing });
  }
  for (const [path, sha256] of declared) {
    if (!reviewedByPath.has(path)) mismatches.push({ path, reviewed: null, publishing: sha256 });
  }

  const ok = mismatches.length === 0;
  if (ok) {
    await markReleaseSetVerified(db, set.id);
  }
  await recordScanEvent(db, {
    organizationId: caller.organizationId,
    type: ok ? "ci_release_set.verified" : "ci_release_set.verify_failed",
    metadata: {
      releaseSetId: set.id,
      artifactCount: reviewed.length,
      mismatchCount: mismatches.length,
      mismatchPaths: mismatches.slice(0, 20).map((entry) => entry.path),
    },
  });
  if (!ok) {
    emitOperationalEvent("error", "ci_release_set.verify_failed", {
      organizationId: caller.organizationId,
      releaseSetId: set.id,
      mismatchCount: mismatches.length,
    });
  }

  return c.json({ ok, mismatches }, ok ? 200 : 409);
});

// ── Serialization ────────────────────────────────────────────────────────────

function publicReleaseSet(
  env: Cloudflare.Env,
  set: CiReleaseSetRecord,
  artifacts: { path: string; sha256: string; sizeBytes: number }[],
  packages?: {
    scanId: string;
    packageName: string | null;
    stagedVersion: string | null;
    risk: string;
    status: string;
    decision: string | null;
  }[],
) {
  return {
    id: set.id,
    status: set.status,
    repositoryFullName: set.repositoryFullName,
    runId: set.runId,
    runAttempt: set.runAttempt,
    releaseKey: set.releaseKey || null,
    ecosystem: set.ecosystem ?? "auto",
    sha: set.sha,
    artifactCount: set.artifactCount,
    totalBytes: set.totalBytes,
    verified: Boolean(set.verifiedAt),
    failureReason: set.failureReason,
    reviewUrl: releaseSetReviewUrl(env, set),
    artifacts: artifacts.map((artifact) => ({
      path: artifact.path,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
    })),
    ...(packages
      ? {
          packages: packages.map((pkg) => ({
            scanId: pkg.scanId,
            name: pkg.packageName,
            version: pkg.stagedVersion,
            risk: pkg.risk,
            status: pkg.status,
            decision: pkg.decision,
            reviewUrl: scanReviewUrl(env, pkg.scanId),
          })),
        }
      : {}),
  };
}

function releaseSetReviewUrl(env: Cloudflare.Env, set: CiReleaseSetRecord): string | null {
  // Before the review finishes there is no scan to link to, so the release list
  // is the only stable destination.
  return set.scanId ? scanReviewUrl(env, set.scanId) : dashboardUrl(env, "/dashboard");
}

function scanReviewUrl(env: Cloudflare.Env, scanId: string): string | null {
  return dashboardUrl(env, `/dashboard/scans/${scanId}`);
}

function dashboardUrl(env: Cloudflare.Env, path: string): string | null {
  const base = env.BETTER_AUTH_URL?.trim();
  if (!base) return null;
  return `${base.replace(/\/$/, "")}${path}`;
}
