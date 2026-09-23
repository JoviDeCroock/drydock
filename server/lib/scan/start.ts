/**
 * Starting a scan, shared by every route that starts one: `POST /api/v1/scans`
 * and the publication monitor's post-release review of an alerted release.
 * One path, so a review started from an alert is the same published-pair
 * review, with the same registry resolution, row, and queue message, as one
 * started by hand.
 */
import type { Context } from "hono";
import type { AppDb } from "../../db/client";
import { createScanJob, type ScanSource } from "../../db/scans";
import { recordProductEvent } from "../analytics";
import { getPublishedAdapter } from "../ecosystems";
import { publishedPairStageId } from "../ecosystems/published-pair";
import { workerExecutionContext } from "../platform/execution-context";
import { describeOperationalError, emitOperationalEvent } from "../platform/observability";
import { PublicDiffError } from "../public-diff/error";
import type { Bindings, ScanInput, Variables } from "../../types";
import type { PublishedScanRequest } from "./input";
import { executeScanJob, type ScanQueueMessage } from "./job";

type ScanRouteContext = Context<{ Bindings: Bindings; Variables: Variables }>;

export interface PreparedScan {
  input: ScanInput;
  source: ScanSource;
  ecosystem: string;
  packageName: string | null;
  version: string | null;
  /**
   * Registry-reported stage creation time. Only a staged npm scan has one; a
   * published-pair review was never staged.
   */
  stagedCreatedAt: string | null;
  /** The registry's SHA-1 from the same stage record; only a staged npm scan has one. */
  stagedDeclaredSha1: string | null;
  /**
   * Only a staged npm scan captures one. A published-pair review must leave it
   * null: `createScanJob` uses it to claim the registry coordinates a staged
   * release owns, and a review of an already-public version has no claim on them.
   */
  registryUrl: string | null;
}

/**
 * Resolve a published `package@version` against its public registry before any
 * scan row exists, so an unpublished version is a request error rather than a
 * scan that fails minutes later, and the queued message names an exact pair.
 *
 * No npm credential is read, decrypted, or attached here: acquisition reuses
 * the same public brokers the anonymous `/diff` surface uses.
 */
export async function preparePublishedScan(
  c: ScanRouteContext,
  request: PublishedScanRequest,
): Promise<PreparedScan | { error: Response }> {
  const adapter = getPublishedAdapter(request.ecosystem);
  if (!adapter) return { error: c.json({ error: "unsupported ecosystem" }, 400) };

  let resolved: Awaited<ReturnType<typeof adapter.resolvePair>>;
  try {
    resolved = await adapter.resolvePair(c.env, workerExecutionContext(c.executionCtx), request);
  } catch (err) {
    emitOperationalEvent("warn", "scan.published_pair.resolve_failed", {
      ecosystem: request.ecosystem,
      error: describeOperationalError(err),
    });
    // The public-diff loaders already classify their own failures (unknown
    // package, oversized archive, registry unreachable) with a public-safe
    // message and status; anything else is ours and stays opaque.
    if (err instanceof PublicDiffError) {
      return { error: c.json({ error: err.message }, err.status) };
    }
    return { error: c.json({ error: "could not reach the registry for that package" }, 502) };
  }
  if (!resolved.ok) return { error: c.json({ error: resolved.error }, resolved.status) };

  const pair = resolved.pair;
  return {
    input: { stageId: publishedPairStageId(pair), published: pair },
    source: "published",
    ecosystem: pair.ecosystem,
    packageName: pair.packageName,
    version: pair.version,
    stagedCreatedAt: null,
    stagedDeclaredSha1: null,
    registryUrl: null,
  };
}

/** Persist the scan row for a prepared scan. It runs only once `enqueuePreparedScan` sends it. */
export function createPreparedScan(
  db: AppDb,
  input: { scanId: string; organizationId: string; ownerUserId: string; prepared: PreparedScan },
) {
  const { prepared } = input;
  return createScanJob(db, {
    id: input.scanId,
    stageId: prepared.input.stageId,
    organizationId: input.organizationId,
    ownerUserId: input.ownerUserId,
    source: prepared.source,
    packageName: prepared.packageName,
    stagedVersion: prepared.version,
    stagedCreatedAt: prepared.stagedCreatedAt,
    stagedDeclaredSha1: prepared.stagedDeclaredSha1,
    registryUrl: prepared.registryUrl,
  });
}

/**
 * Send a created scan to the queue (or run it inline without one). Returns
 * whether it was queued.
 */
export async function enqueuePreparedScan(
  c: ScanRouteContext,
  db: AppDb,
  input: { scanId: string; organizationId: string; actorUserId: string; prepared: PreparedScan },
): Promise<boolean> {
  const { prepared } = input;
  const message: ScanQueueMessage = {
    ...prepared.input,
    scanId: input.scanId,
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    source: prepared.source,
  };

  // Counted at creation, not completion, so the queued → completed drop-off
  // is visible: a scan that never reaches a terminal state emits neither
  // `scan.completed` nor `scan.failed` and would otherwise vanish.
  recordProductEvent(c.env, {
    name: "scan.queued",
    organizationId: input.organizationId,
    ecosystem: prepared.ecosystem,
    source: message.source ?? "manual",
  });

  if (c.env.SCAN_QUEUE) {
    await c.env.SCAN_QUEUE.send(message);
    return true;
  }
  c.executionCtx.waitUntil(
    executeScanJob(c.env, workerExecutionContext(c.executionCtx), message, db, {
      finalAttempt: true,
    }),
  );
  return false;
}
