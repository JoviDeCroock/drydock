/**
 * D1-backed resolver for gate continuity. Record shape, evaluation, and
 * re-validation live in `gate-continuity-record.ts`, which the UI imports;
 * keep everything that touches the database on this side.
 *
 * Advisory and additive: it never moves risk, findings, or a decision, and a
 * failure never fails the scan, because the artifact review stands on its
 * own. A check that could not run persists as `unknown` rather than as no
 * record: no record means the organization does not gate the package, which a
 * failed read cannot establish.
 */

import type { AppDb } from "../../db/client";
import { hasLiveReleaseTarget, loadGateReviewHistory } from "../../db/scans";
import { describeOperationalError, emitOperationalEvent } from "../platform/observability";
import {
  evaluateGateContinuity,
  unknownGateContinuity,
  type GateContinuity,
} from "./gate-continuity-record";
import type { PipelineIdentity } from "./pipeline-phases";

/** Sources whose scans can be bound to a gate review: registry stages only. */
const STAGED_SOURCES = new Set(["manual", "auto_discovery"]);

export async function resolveGateContinuity(args: {
  db: AppDb;
  identity: PipelineIdentity;
  source: string | undefined;
  /**
   * The staged adapter's ecosystem when it hashes its staged artifact — the
   * capability gate continuity needs — else null and there is no record.
   */
  ecosystem: string | null;
  /**
   * The registry's own coordinates for the stage (npm's stage record), never
   * the tarball manifest: the manifest is package-controlled, and a hostile
   * stage of a gated package must not be able to dodge the lookup by naming
   * itself something else. Null when the registry record was unavailable.
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
  const { ecosystem } = args;
  if (!ecosystem || !STAGED_SOURCES.has(args.source ?? "manual")) return null;
  const { organizationId, scanId } = args.identity;
  const packageName = args.registryIdentity?.packageName ?? null;
  try {
    if (!args.registryIdentity) {
      // Nothing trustworthy to key the lookup on. That only matters if the
      // organization could be gating this stage's package at all; with no
      // live release target for the ecosystem, "not applicable" is still true.
      return (await hasLiveReleaseTarget(args.db, organizationId, ecosystem))
        ? unknownGateContinuity("registry-record-unavailable", args.stagedDigest)
        : null;
    }
    const { version } = args.registryIdentity;
    const history = await loadGateReviewHistory(args.db, {
      organizationId,
      ecosystem,
      packageName: args.registryIdentity.packageName,
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
        scanId,
        organizationId,
        packageName,
        version,
        status: continuity.status,
        reason: continuity.reason,
        gateScanId: continuity.review?.scanId ?? null,
      });
    }
    return continuity;
  } catch (err) {
    emitOperationalEvent("warn", "scan.gate_continuity.lookup_failed", {
      scanId,
      organizationId,
      packageName,
      error: describeOperationalError(err),
    });
    return unknownGateContinuity("history-unavailable", args.stagedDigest);
  }
}
