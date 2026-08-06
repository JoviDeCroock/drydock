/**
 * Tolerant re-reader for a persisted build-attestation verdict.
 *
 * Persisted JSON is untyped by the time it is read back, and the report export
 * and UI both consume it. The governing rule, the same one
 * `normalizeIntentEnvelope` follows: **a persisted status must not outlive the
 * evidence that justified it**. A blob claiming `verified` without the checks
 * that produce `verified` reads as null rather than rendering a
 * machine-verified build claim nobody ever established.
 */

import { normalizeRepositoryUrl } from "../intent-envelope";
import type {
  BuildAttestation,
  BuildAttestationCheck,
  BuildAttestationCheckKind,
  BuildAttestationCheckResult,
  BuildAttestationStatus,
  BuildClaim,
} from "./types";

const STATUSES: ReadonlySet<string> = new Set([
  "verified",
  "partial",
  "mismatch",
  "absent",
  "unavailable",
]);

const CHECK_KINDS: ReadonlySet<string> = new Set([
  "subject-digest",
  "repository",
  "workflow-run",
  "source-commit",
  "signature",
]);

const CHECK_RESULTS: ReadonlySet<string> = new Set(["pass", "fail", "skipped"]);

const MAX_CHECKS = 16;
const MAX_DETAIL_LENGTH = 512;
const MAX_SUBJECT_DIGESTS = 64;
const MAX_FIELD_LENGTH = 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const NUMERIC_ID = /^\d{1,20}$/;

export function normalizeBuildAttestation(value: unknown): BuildAttestation | null {
  if (!isRecord(value)) return null;
  if (typeof value.status !== "string" || !STATUSES.has(value.status)) return null;
  const status = value.status as BuildAttestationStatus;

  const checks = normalizeChecks(value.checks);
  const claim = normalizeClaim(value.claim);
  const trustCeiling = value.trustCeiling === "self-consistent" ? "self-consistent" : "none";

  const passed = (kind: BuildAttestationCheckKind) =>
    checks.some((check) => check.kind === kind && check.result === "pass");
  const failed = (kind: BuildAttestationCheckKind) =>
    checks.some((check) => check.kind === kind && check.result === "fail");

  if (status === "absent" || status === "unavailable") {
    // These states describe the lookup, not an attestation; carrying a claim
    // would mean something was read after all.
    if (claim) return null;
    return { status, claim: null, checks, trustCeiling: "none" };
  }

  // Every remaining status asserts that an attestation was read.
  if (!claim) return null;

  if (status === "mismatch") {
    const contradicted =
      failed("subject-digest") ||
      failed("repository") ||
      failed("workflow-run") ||
      failed("source-commit");
    return contradicted ? { status, claim, checks, trustCeiling: "none" } : null;
  }

  // `partial` and `verified` both require the attestation to actually cover the
  // reviewed bytes, and neither may contradict anything.
  if (!passed("subject-digest")) return null;
  if (
    failed("subject-digest") ||
    failed("repository") ||
    failed("workflow-run") ||
    failed("source-commit")
  ) {
    return null;
  }

  if (status === "verified") {
    const corroborated = passed("repository") || passed("workflow-run");
    if (!corroborated || !passed("signature") || trustCeiling !== "self-consistent") return null;
    return { status, claim, checks, trustCeiling: "self-consistent" };
  }

  return {
    status: "partial",
    claim,
    checks,
    trustCeiling: passed("signature") ? trustCeiling : "none",
  };
}

function normalizeChecks(value: unknown): BuildAttestationCheck[] {
  if (!Array.isArray(value)) return [];
  const checks: BuildAttestationCheck[] = [];
  for (const entry of value.slice(0, MAX_CHECKS)) {
    if (!isRecord(entry)) continue;
    const { kind, result, detail } = entry;
    if (typeof kind !== "string" || !CHECK_KINDS.has(kind)) continue;
    if (typeof result !== "string" || !CHECK_RESULTS.has(result)) continue;
    if (typeof detail !== "string") continue;
    checks.push({
      kind: kind as BuildAttestationCheckKind,
      result: result as BuildAttestationCheckResult,
      detail: detail.slice(0, MAX_DETAIL_LENGTH),
    });
  }
  return checks;
}

function normalizeClaim(value: unknown): BuildClaim | null {
  if (!isRecord(value)) return null;
  const predicateType = str(value.predicateType);
  if (!predicateType) return null;

  const subjectDigests: string[] = [];
  if (Array.isArray(value.subjectDigests)) {
    for (const digest of value.subjectDigests.slice(0, MAX_SUBJECT_DIGESTS)) {
      if (typeof digest !== "string") continue;
      const normalized = digest.trim().toLowerCase();
      if (SHA256_HEX.test(normalized)) subjectDigests.push(normalized);
    }
  }

  const commit = str(value.commit)?.toLowerCase() ?? null;
  const runId = str(value.runId);
  const runAttempt = str(value.runAttempt);

  return {
    predicateType,
    repository: normalizeRepositoryUrl(value.repository),
    workflowPath: str(value.workflowPath),
    ref: str(value.ref),
    commit: commit && COMMIT_SHA.test(commit) ? commit : null,
    runId: runId && NUMERIC_ID.test(runId) ? runId : null,
    runAttempt: runAttempt && NUMERIC_ID.test(runAttempt) ? runAttempt : null,
    builderId: str(value.builderId),
    subjectDigests,
  };
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_FIELD_LENGTH) return null;
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
