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
 * the gate reviewed and approved, and — for a package the organization still
 * gates — whether a stage appeared that never went through the gate at all.
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
  /** A gate review of this version exists, but the stage cannot be bound to it; `reason` says why. */
  | "unverified"
  /** A still-configured release target has gated this package, and this version never passed the gate. */
  | "ungated"
  /** The check could not run, so whether the stage went through the gate is not known; `reason` says why. */
  | "unknown";

export type GateContinuityReason =
  // `unverified`
  /** Only a gate scan of this version that has not completed (running or failed) exists. */
  | "gate-review-incomplete"
  /** The sandbox computed no SHA-256 for the staged tarball. */
  | "staged-digest-unavailable"
  /** No gate review of this version recorded a single-tarball npm digest. */
  | "gate-digest-unavailable"
  /** The gate reviewed these bytes, but its gate row is gone, so its decision is unknown. */
  | "gate-decision-unavailable"
  /** The digests agree with an approved review, but the download was not confirmed against npm's record. */
  | "stage-not-bound-to-registry"
  /** No review in the compared window matches, and older reviews of this version exist. */
  | "review-window-truncated"
  // `unknown`
  /** The organization's gate history could not be read. */
  | "history-unavailable"
  /** npm's own record for the stage was unavailable, so there was nothing safe to look up. */
  | "registry-record-unavailable";

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
  /** Why an `unverified` or `unknown` record binds nothing; null for every other status. */
  reason: GateContinuityReason | null;
  algorithm: "sha256";
  /** SHA-256 the sandbox computed from the staged bytes; null when unavailable. */
  stagedDigest: string | null;
  /** The gate review this stage was compared against; null when there was none to compare. */
  review: GateContinuityReview | null;
}

/**
 * The form `report.json` carries. That document is also what a public share
 * token serves, so it keeps the verdict and both digests — enough for anyone to
 * check the binding — and leaves the gate's identity (repository, environment,
 * run, internal ids, decision) to the authenticated receipt and scan page.
 */
interface GateContinuityExport {
  status: GateContinuityStatus;
  reason: GateContinuityReason | null;
  algorithm: "sha256";
  stagedDigest: string | null;
  gateDigest: string | null;
}

const REASONS: Readonly<Partial<Record<GateContinuityStatus, ReadonlySet<string>>>> = {
  unverified: new Set<GateContinuityReason>([
    "gate-review-incomplete",
    "staged-digest-unavailable",
    "gate-digest-unavailable",
    "gate-decision-unavailable",
    "stage-not-bound-to-registry",
    "review-window-truncated",
  ]),
  unknown: new Set<GateContinuityReason>(["history-unavailable", "registry-record-unavailable"]),
};
const GATE_CONTINUITY_STATUSES = new Set<GateContinuityStatus>([
  "matched",
  "gate-not-approved",
  "digest-mismatch",
  "unverified",
  "ungated",
  "unknown",
]);
/** Statuses that assert something about a specific gate review, and so need one. */
const COMPARED_STATUSES = new Set<GateContinuityStatus>([
  "matched",
  "gate-not-approved",
  "digest-mismatch",
]);
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_TEXT = 512;

function record(
  status: GateContinuityStatus,
  stagedDigest: string | null,
  review: GateContinuityReview | null,
  reason: GateContinuityReason | null = null,
): GateContinuity {
  return { status, reason, algorithm: "sha256", stagedDigest, review };
}

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
    // A gate scan of this version that has not completed is still a review a
    // maintainer can decide, so the stage did not skip the gate — the gate's
    // verdict is simply not in yet.
    if (history.versionHasIncompleteGateScan) {
      return record("unverified", staged, null, "gate-review-incomplete");
    }
    return history.packageHasLiveGate ? record("ungated", staged, null) : null;
  }
  const reviews = history.forVersion.map((row) => toReview(row, history.ecosystem));
  // A comparison needs two digests. A gate review that recorded none (a
  // multi-artifact provenance, a malformed blob, a scan that predates the
  // provenance block) cannot vouch for or accuse the stage.
  const comparable = reviews.filter((review) => review.sha256 !== null);
  if (!staged) return record("unverified", null, reviews[0] ?? null, "staged-digest-unavailable");
  if (comparable.length === 0) {
    return record("unverified", staged, reviews[0] ?? null, "gate-digest-unavailable");
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
      return stagedDigestBoundToRegistry
        ? record("matched", staged, latest)
        : record("unverified", staged, latest, "stage-not-bound-to-registry");
    }
    // The gate saw exactly these bytes and did not let them through; they were
    // staged anyway. Stronger evidence of a bypass than a mismatch — unless the
    // gate row itself is gone, in which case the decision is unknown rather
    // than negative.
    return latest.gateId !== null
      ? record("gate-not-approved", staged, latest)
      : record("unverified", staged, latest, "gate-decision-unavailable");
  }
  // Nothing in the window matched. If the window was truncated the approved
  // review may simply be outside it, and absence of evidence must not be
  // rendered as "something staged bytes the gate never saw".
  return history.truncated
    ? record("unverified", staged, comparable[0] ?? null, "review-window-truncated")
    : record("digest-mismatch", staged, comparable[0] ?? null);
}

/**
 * The record for a stage the resolver could not check at all. Distinct from
 * "no record": a missing record means the organization does not gate the
 * package, and a failed check must not be allowed to read as that.
 */
export function unknownGateContinuity(
  reason: "history-unavailable" | "registry-record-unavailable",
  stagedDigest: string | null | undefined,
): GateContinuity {
  return record("unknown", normalizeSha256(stagedDigest), null, reason);
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
  const parsedStatus = status as GateContinuityStatus;
  const review =
    parsedStatus === "ungated" || parsedStatus === "unknown" ? null : normalizeReview(value.review);
  // A status that names a comparison needs the review it compared against.
  // `unverified` may carry none — a gate scan of this version that has not
  // completed — and dropping it would render nothing, which is more
  // reassuring than the evidence it stands for.
  if (COMPARED_STATUSES.has(parsedStatus) && !review) return null;
  const stagedDigest = normalizeSha256(value.stagedDigest);
  // `matched` is the one status that asserts an equality, so re-derive it here
  // rather than trust it: a truncated or hand-edited blob must not be able to
  // render the green badge with its digest rows blank.
  if (parsedStatus === "matched" && (!stagedDigest || review?.sha256 !== stagedDigest)) {
    return null;
  }
  const reason =
    typeof value.reason === "string" && REASONS[parsedStatus]?.has(value.reason)
      ? (value.reason as GateContinuityReason)
      : null;
  return record(parsedStatus, stagedDigest, review, reason);
}

export function exportGateContinuity(
  continuity: GateContinuity | null,
): GateContinuityExport | null {
  if (!continuity) return null;
  return {
    status: continuity.status,
    reason: continuity.reason,
    algorithm: continuity.algorithm,
    stagedDigest: continuity.stagedDigest,
    gateDigest: continuity.review?.sha256 ?? null,
  };
}

function toReview(
  row: GateReviewHistory["forVersion"][number],
  ecosystem: string,
): GateContinuityReview {
  return {
    scanId: row.scanId,
    gateId: row.gate?.id ?? null,
    repository: row.gate?.repositoryFullName || null,
    environment: row.gate?.environment || null,
    runId: row.gate?.runId ?? null,
    status: row.gate?.status ?? null,
    decision: row.gate?.decision ?? null,
    decidedAt: row.gate?.decidedAt ? row.gate.decidedAt.toISOString() : null,
    sha256: gateTarballSha256(row.summaryJson, ecosystem),
  };
}

// The gate's provenance block lists the reviewed artifacts with the digests
// recomputed from their bytes. Only a single-artifact release of the staged
// review's own ecosystem can be bound to the staged artifact: another
// ecosystem's artifact with the same name and version is a different package,
// and a multi-artifact provenance is not a match candidate.
function gateTarballSha256(summaryJson: unknown, ecosystem: string): string | null {
  if (!isRecord(summaryJson) || !isRecord(summaryJson.stagedPublish)) return null;
  const provenance = summaryJson.stagedPublish.provenance;
  if (!isRecord(provenance) || provenance.ecosystem !== ecosystem) return null;
  if (!Array.isArray(provenance.artifacts) || provenance.artifacts.length !== 1) return null;
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
