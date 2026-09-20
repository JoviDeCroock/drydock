/**
 * Gate continuity — binding a registry-staged review to the organization's
 * workflow-gate review of the same bytes.
 *
 * A stage-only trusted publisher lets CI put a candidate into npm's staging
 * area but never publish it; a workflow gate lets Drydock hold the job that
 * stages until the bytes are reviewed. Composed, the gate is the enforced
 * checkpoint and the stage is npm holding exactly the reviewed artifact. npm
 * exposes no hook for a third party to block a stage, so the stage itself is
 * the receipt: this record says whether the tarball npm holds is the tarball
 * the gate reviewed and approved, and — for a package the organization gates —
 * whether a stage appeared that never went through the gate at all.
 *
 * Pure record shape, evaluation, and re-validation. This module is imported by
 * the UI and the report export, so it must stay free of database and Worker
 * imports; the D1-backed resolver lives in `gate-continuity.ts`.
 */

import type { GateReviewHistory } from "../../db/scan-gate-continuity";
import { isRecord } from "../platform/guards";

type GateContinuityStatus =
  /** The staged bytes hash to a tarball the gate reviewed and approved for this version. */
  | "matched"
  /** The gate reviewed exactly these bytes and did not approve them (rejected, pending, or errored). */
  | "gate-not-approved"
  /** The gate reviewed this version, but different bytes were staged. */
  | "digest-mismatch"
  /** The gate reviewed this version; one of the two digests is unavailable, so nothing is bound. */
  | "unverified"
  /** The organization gates this package, and this version never passed the gate. */
  | "ungated";

interface GateContinuityReview {
  scanId: string;
  gateId: string | null;
  repository: string | null;
  environment: string | null;
  runId: number | null;
  status: string | null;
  decision: string | null;
  decidedAt: string | null;
  /** SHA-256 the gate recorded for the reviewed tarball (from its provenance block). */
  sha256: string | null;
}

export interface GateContinuity {
  status: GateContinuityStatus;
  algorithm: "sha256";
  /** SHA-256 the sandbox computed from the staged bytes; null when unavailable. */
  stagedDigest: string | null;
  /** The gate review this stage was compared against; null when `ungated`. */
  review: GateContinuityReview | null;
}

const GATE_CONTINUITY_STATUSES = new Set<GateContinuityStatus>([
  "matched",
  "gate-not-approved",
  "digest-mismatch",
  "unverified",
  "ungated",
]);
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_TEXT = 512;

export function evaluateGateContinuity(
  history: GateReviewHistory,
  stagedDigest: string | null | undefined,
  /**
   * Whether the staged bytes were confirmed against npm's own record for the
   * stage. `matched` claims the tarball *npm holds* is the gated tarball, and
   * only this makes the downloaded bytes evidence of what npm holds.
   */
  stagedDigestBoundToRegistry = false,
): GateContinuity | null {
  const staged = normalizeSha256(stagedDigest);
  if (history.forVersion.length === 0) {
    if (!history.packageHasGateHistory) return null;
    // A gate scan of this version that has not completed is still a review a
    // maintainer can decide, so the stage did not skip the gate — the gate's
    // verdict is simply not in yet.
    if (history.versionHasIncompleteGateScan) {
      return { status: "unverified", algorithm: "sha256", stagedDigest: staged, review: null };
    }
    return { status: "ungated", algorithm: "sha256", stagedDigest: staged, review: null };
  }
  const reviews = history.forVersion.map(toReview);
  // A comparison needs two digests. A gate review that recorded none (a
  // multi-artifact provenance, a malformed blob, a scan that predates the
  // provenance block) cannot vouch for or accuse the stage.
  const comparable = reviews.filter((review) => review.sha256 !== null);
  if (!staged || comparable.length === 0) {
    return {
      status: "unverified",
      algorithm: "sha256",
      stagedDigest: staged,
      review: reviews[0] ?? null,
    };
  }
  // Reviews arrive newest first, and the gate's most recent decision on these
  // exact bytes wins: a maintainer who re-ran the gate and rejected what they
  // had approved earlier has changed their mind, and the stage must not hide
  // that behind the older approval.
  const latest = comparable.find((review) => review.sha256 === staged);
  if (latest) {
    if (latest.decision === "approved") {
      // The digests agree, but `matched` also asserts npm holds these bytes.
      // Without the registry binding the scan only knows what it downloaded,
      // which the stage-digest finding may already be disputing.
      if (!stagedDigestBoundToRegistry) {
        return { status: "unverified", algorithm: "sha256", stagedDigest: staged, review: latest };
      }
      return { status: "matched", algorithm: "sha256", stagedDigest: staged, review: latest };
    }
    // The gate saw exactly these bytes and did not let them through; they were
    // staged anyway. Stronger evidence of a bypass than a mismatch — unless the
    // gate row itself is gone, in which case the decision is unknown rather
    // than negative.
    return {
      status: latest.gateId !== null ? "gate-not-approved" : "unverified",
      algorithm: "sha256",
      stagedDigest: staged,
      review: latest,
    };
  }
  // Nothing in the window matched. If the window was truncated the approved
  // review may simply be outside it, and absence of evidence must not be
  // rendered as "something staged bytes the gate never saw".
  return {
    status: history.truncated ? "unverified" : "digest-mismatch",
    algorithm: "sha256",
    stagedDigest: staged,
    review: comparable[0] ?? null,
  };
}

/**
 * Re-validate a persisted record before it is exported or rendered. Persisted
 * blobs may predate the feature or be malformed; anything that does not parse
 * reads as "no record", never as a claim.
 */
export function normalizeGateContinuity(value: unknown): GateContinuity | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (typeof status !== "string" || !GATE_CONTINUITY_STATUSES.has(status as GateContinuityStatus)) {
    return null;
  }
  const review = normalizeReview(value.review);
  if (status !== "ungated" && !review) return null;
  const stagedDigest = normalizeSha256(value.stagedDigest);
  // `matched` is the one status that asserts an equality, so re-derive it here
  // rather than trust it: a truncated or hand-edited blob must not be able to
  // render the green badge with its digest rows blank.
  if (status === "matched" && (!stagedDigest || review?.sha256 !== stagedDigest)) {
    return null;
  }
  return {
    status: status as GateContinuityStatus,
    algorithm: "sha256",
    stagedDigest,
    review: status === "ungated" ? null : review,
  };
}

function toReview(row: GateReviewHistory["forVersion"][number]): GateContinuityReview {
  return {
    scanId: row.scanId,
    gateId: row.gate?.id ?? null,
    repository: row.gate?.repositoryFullName || null,
    environment: row.gate?.environment || null,
    runId: row.gate?.runId ?? null,
    status: row.gate?.status ?? null,
    decision: row.gate?.decision ?? null,
    decidedAt: row.gate?.decidedAt ? row.gate.decidedAt.toISOString() : null,
    sha256: gateTarballSha256(row.summaryJson),
  };
}

// The gate's provenance block lists the reviewed artifacts with the digests
// recomputed from their bytes. Only a single-artifact release can be bound to a
// single staged tarball; a multi-artifact provenance is not a match candidate.
function gateTarballSha256(summaryJson: unknown): string | null {
  if (!isRecord(summaryJson) || !isRecord(summaryJson.stagedPublish)) return null;
  const provenance = summaryJson.stagedPublish.provenance;
  if (!isRecord(provenance) || !Array.isArray(provenance.artifacts)) return null;
  if (provenance.artifacts.length !== 1) return null;
  const artifact = provenance.artifacts[0];
  return isRecord(artifact) ? normalizeSha256(artifact.sha256) : null;
}

function normalizeReview(value: unknown): GateContinuityReview | null {
  if (!isRecord(value) || typeof value.scanId !== "string" || !value.scanId) return null;
  return {
    scanId: value.scanId.slice(0, MAX_TEXT),
    gateId: optionalText(value.gateId),
    repository: optionalText(value.repository),
    environment: optionalText(value.environment),
    runId: typeof value.runId === "number" && Number.isFinite(value.runId) ? value.runId : null,
    status: optionalText(value.status),
    decision: optionalText(value.decision),
    decidedAt: optionalText(value.decidedAt),
    sha256: normalizeSha256(value.sha256),
  };
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value ? value.slice(0, MAX_TEXT) : null;
}

function normalizeSha256(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return SHA256_RE.test(lower) ? lower : null;
}
