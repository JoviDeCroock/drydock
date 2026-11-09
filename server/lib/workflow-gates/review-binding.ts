/**
 * What a gate review was bound to, and whether GitHub still reports it.
 *
 * GitHub's deployment-protection callback names a run and an Environment, not
 * a run attempt or a set of artifacts. An approval therefore releases whatever
 * the run holds when the callback lands, so it is delivered only while the run
 * attempt and its Actions artifacts (immutable ids, sizes, digests) are the
 * ones the review listed.
 */
import type { AppDb } from "../../db/client";
import { getInstallationAccessToken } from "../github-app/api";
import { collectRunArtifacts, fetchWorkflowRunAttempt } from "../github-app/artifacts";
import type { GithubAppConfig } from "../github-app/config";
import { getInstallationExternalId } from "../github-app/persistence";
import type { WorkflowGateRecord } from "../github-app/webhook-gates";

/**
 * Pending-gate `failure_reason` values meaning the review no longer matches the
 * run. Approval is refused and the review may be re-run even after package
 * decisions were recorded.
 */
export const GATE_STALE_REVIEW_REASONS = [
  "run_attempt_changed",
  "artifacts_changed",
  // Reviewed before bindings were recorded; nothing to compare against.
  "review_unbound",
] as const;
export type GateStaleReviewReason = (typeof GATE_STALE_REVIEW_REASONS)[number];

const STALE_REASON_SET = new Set<string>(GATE_STALE_REVIEW_REASONS);

export function isGateStaleReviewReason(value: unknown): value is GateStaleReviewReason {
  return typeof value === "string" && STALE_REASON_SET.has(value);
}

interface ReviewedArtifactRef {
  id: number;
  name: string;
  sizeInBytes: number | null;
  digest: string | null;
}

export interface GateReviewBinding {
  runAttempt: number;
  /** The listing filter the review used; the re-check lists with the same one. */
  artifactName: string | null;
  artifactNamePrefix: string | null;
  artifacts: ReviewedArtifactRef[];
}

export function readGateReviewBinding(
  runAttempt: number | null,
  json: unknown,
): GateReviewBinding | null {
  if (typeof runAttempt !== "number" || !json || typeof json !== "object") return null;
  const record = json as Record<string, unknown>;
  if (!Array.isArray(record.artifacts)) return null;
  const artifacts: ReviewedArtifactRef[] = [];
  for (const entry of record.artifacts) {
    if (!entry || typeof entry !== "object") return null;
    const { id, name, sizeInBytes, digest } = entry as Record<string, unknown>;
    if (typeof id !== "number" || typeof name !== "string") return null;
    artifacts.push({
      id,
      name,
      sizeInBytes: typeof sizeInBytes === "number" ? sizeInBytes : null,
      digest: typeof digest === "string" ? digest : null,
    });
  }
  return {
    runAttempt,
    artifactName: typeof record.artifactName === "string" ? record.artifactName : null,
    artifactNamePrefix:
      typeof record.artifactNamePrefix === "string" ? record.artifactNamePrefix : null,
    artifacts,
  };
}

/** Null when the current run state is exactly what was reviewed. */
function compareGateReviewBinding(
  reviewed: GateReviewBinding,
  current: { runAttempt: number; artifacts: readonly ReviewedArtifactRef[] },
): GateStaleReviewReason | null {
  if (current.runAttempt !== reviewed.runAttempt) return "run_attempt_changed";
  const key = (artifact: ReviewedArtifactRef) =>
    `${artifact.id}\0${artifact.name}\0${artifact.sizeInBytes ?? ""}\0${artifact.digest ?? ""}`;
  const before = reviewed.artifacts.map(key).sort();
  const after = current.artifacts.map(key).sort();
  if (before.length !== after.length) return "artifacts_changed";
  return before.every((value, index) => value === after[index]) ? null : "artifacts_changed";
}

export type GateReviewBindingCheck = { ok: true } | { ok: false; reason: GateStaleReviewReason };

/**
 * Ask GitHub for the run's current attempt and artifacts and compare them with
 * the gate's binding. GitHub or installation failures throw, so callers fail
 * closed by not approving rather than reading an outage as a change.
 */
export async function checkGateReviewBinding(
  config: GithubAppConfig,
  db: AppDb,
  gate: WorkflowGateRecord,
): Promise<GateReviewBindingCheck> {
  const binding = gate.reviewBinding;
  if (!binding) return { ok: false, reason: "review_unbound" };
  const installationExternalId = await getInstallationExternalId(
    db,
    gate.installationRowId,
    gate.organizationId,
  );
  if (!installationExternalId) {
    throw new Error(`installation row ${gate.installationRowId} missing for gate ${gate.id}`);
  }
  const token = await getInstallationAccessToken(config, installationExternalId);
  const runAttempt = await fetchWorkflowRunAttempt(token, gate.repositoryFullName, gate.runId);
  if (runAttempt !== binding.runAttempt) return { ok: false, reason: "run_attempt_changed" };
  const artifacts = await collectRunArtifacts(
    token,
    gate.repositoryFullName,
    gate.runId,
    binding.artifactName ?? undefined,
    binding.artifactNamePrefix ?? undefined,
  );
  const reason = compareGateReviewBinding(binding, { runAttempt, artifacts });
  return reason ? { ok: false, reason } : { ok: true };
}
