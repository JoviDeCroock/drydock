import { type AppDb } from "../../db/client";
import { bindGateToReleaseSet, listReleaseSetsForRun } from "../../db/ci-release-sets";
import type { WorkflowGateRecord } from "../github-app/webhook-gates";
import { emitOperationalEvent } from "../platform/observability";

/**
 * Bind a freshly-opened gate to the release the CI Action already pushed for
 * the same workflow run, if there is exactly one.
 *
 * This is the join between the two paths. The gate webhook knows only
 * `(repository, run)`; a pushed release set is keyed by the same pair, so the
 * match is exact and needs nothing from the maintainer.
 *
 * Deliberately conservative in two places:
 *
 *  - A run that opened *several* keyed release sets binds nothing. One gate row
 *    can collect one review, and releasing a held deployment that publishes
 *    three keyed releases because one of them was approved would be a real
 *    safety hole. Those runs fall back to the pull path, which reviews the whole
 *    uploaded bundle as a single release.
 *  - A binding failure never throws. The pull path is always a correct fallback
 *    — it costs a duplicate download and review, not correctness — so a
 *    transient D1 error must not turn into a failed webhook delivery.
 */
export async function bindGateToPushedRelease(
  db: AppDb,
  gate: WorkflowGateRecord,
): Promise<string | null> {
  try {
    const sets = await listReleaseSetsForRun(db, {
      organizationId: gate.organizationId,
      repositoryId: gate.repositoryId,
      runId: gate.runId,
    });
    if (sets.length === 0) return null;
    if (sets.length > 1) {
      emitOperationalEvent("info", "ci_release_set.gate_bind_skipped", {
        organizationId: gate.organizationId,
        gateId: gate.id,
        runId: gate.runId,
        reason: "multiple_release_sets",
        releaseKeys: sets.map((set) => set.releaseKey || "(default)"),
      });
      return null;
    }

    const set = sets[0];
    const bound = await bindGateToReleaseSet(db, {
      gateId: gate.id,
      organizationId: gate.organizationId,
      releaseSetId: set.id,
    });
    if (!bound) return null;

    emitOperationalEvent("info", "ci_release_set.gate_bound", {
      organizationId: gate.organizationId,
      gateId: gate.id,
      releaseSetId: set.id,
      runId: gate.runId,
      setStatus: set.status,
    });
    return set.id;
  } catch (err) {
    emitOperationalEvent("warn", "ci_release_set.gate_bind_failed", {
      organizationId: gate.organizationId,
      gateId: gate.id,
      runId: gate.runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
