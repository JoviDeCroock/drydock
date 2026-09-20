/**
 * D1-backed resolver for gate continuity. Record shape, evaluation, and
 * re-validation live in `gate-continuity-record.ts`, which the UI imports;
 * keep everything that touches the database on this side.
 *
 * Advisory and additive: it never moves risk, findings, or a decision. Every
 * lookup failure degrades to "no record", because the artifact review stands on
 * its own and a missing link must not fail a scan.
 */

import type { AppDb } from "../../db/client";
import { loadGateReviewHistory } from "../../db/scans";
import { describeOperationalError, emitOperationalEvent } from "../platform/observability";
import { evaluateGateContinuity, type GateContinuity } from "./gate-continuity-record";
import type { PipelineIdentity } from "./pipeline-phases";

/** Sources whose scans can be bound to a gate review: registry stages only. */
const STAGED_SOURCES = new Set(["manual", "auto_discovery"]);

export async function resolveGateContinuity(args: {
  db: AppDb;
  identity: PipelineIdentity;
  source: string | undefined;
  /**
   * The registry's own coordinates for the stage (npm's stage record), never
   * the tarball manifest: the manifest is package-controlled, and a hostile
   * stage of a gated package must not be able to dodge the lookup by naming
   * itself something else. Null when the registry record was unavailable,
   * which is an absence of evidence and yields no record.
   */
  registryIdentity: { packageName: string; version: string } | null;
  stagedDigest: string | null;
  /**
   * Whether the staged digest was confirmed against the registry's own record.
   * `matched` speaks about the tarball the registry holds, so without this the
   * comparison can only report `unverified`.
   */
  stagedDigestBoundToRegistry: boolean;
}): Promise<GateContinuity | null> {
  if (!STAGED_SOURCES.has(args.source ?? "manual")) return null;
  if (!args.registryIdentity) return null;
  const { packageName, version } = args.registryIdentity;
  try {
    const history = await loadGateReviewHistory(args.db, {
      organizationId: args.identity.organizationId,
      packageName,
      version,
    });
    const continuity = evaluateGateContinuity(
      history,
      args.stagedDigest,
      args.stagedDigestBoundToRegistry,
    );
    if (continuity && continuity.status !== "matched") {
      // A stage the gate never saw, one it did not approve, or one whose bytes
      // drifted from the gated review is the out-of-band signal this record
      // exists to surface.
      emitOperationalEvent("warn", "scan.gate_continuity.broken", {
        scanId: args.identity.scanId,
        organizationId: args.identity.organizationId,
        packageName,
        version,
        status: continuity.status,
        gateScanId: continuity.review?.scanId ?? null,
      });
    }
    return continuity;
  } catch (err) {
    emitOperationalEvent("warn", "scan.gate_continuity.lookup_failed", {
      scanId: args.identity.scanId,
      organizationId: args.identity.organizationId,
      packageName,
      error: describeOperationalError(err),
    });
    return null;
  }
}
