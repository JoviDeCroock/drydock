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
 * the gate reviewed, and — for a package the organization gates — whether a
 * stage appeared that never went through the gate at all.
 *
 * Advisory and additive: it never moves risk, findings, or a decision. Every
 * lookup failure degrades to "no record", because the artifact review stands on
 * its own and a missing link must not fail a scan.
 */

import type { AppDb } from "../../db/client";
import { loadGateReviewHistory, type GateReviewHistory } from "../../db/scans";
import { isRecord } from "../platform/guards";
import { describeOperationalError, emitOperationalEvent } from "../platform/observability";
import type { PipelineIdentity } from "./pipeline-phases";

type GateContinuityStatus =
  /** The staged bytes hash to a tarball the gate reviewed for this version. */
  | "matched"
  /** The gate reviewed this version, but different bytes were staged. */
  | "digest-mismatch"
  /** The gate reviewed this version; the staged digest could not be computed. */
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
  "digest-mismatch",
  "unverified",
  "ungated",
]);
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_TEXT = 512;

/** Sources whose scans can be bound to a gate review: registry stages only. */
const STAGED_SOURCES = new Set(["manual", "auto_discovery"]);

export function evaluateGateContinuity(
  history: GateReviewHistory,
  stagedDigest: string | null | undefined,
): GateContinuity | null {
  const staged = normalizeSha256(stagedDigest);
  if (history.forVersion.length === 0) {
    if (!history.packageHasGateHistory) return null;
    return { status: "ungated", algorithm: "sha256", stagedDigest: staged, review: null };
  }
  const reviews = history.forVersion.map(toReview);
  const matched = staged ? reviews.find((review) => review.sha256 === staged) : undefined;
  if (matched)
    return { status: "matched", algorithm: "sha256", stagedDigest: staged, review: matched };
  return {
    status: staged ? "digest-mismatch" : "unverified",
    algorithm: "sha256",
    stagedDigest: staged,
    review: reviews[0] ?? null,
  };
}

export async function resolveGateContinuity(args: {
  db: AppDb;
  identity: PipelineIdentity;
  source: string | undefined;
  packageName: string | null;
  version: string | null;
  stagedDigest: string | null;
}): Promise<GateContinuity | null> {
  if (!STAGED_SOURCES.has(args.source ?? "manual")) return null;
  if (!args.packageName || !args.version) return null;
  try {
    const history = await loadGateReviewHistory(args.db, {
      organizationId: args.identity.organizationId,
      packageName: args.packageName,
      version: args.version,
    });
    const continuity = evaluateGateContinuity(history, args.stagedDigest);
    if (continuity && continuity.status !== "matched") {
      // A stage the gate never saw, or one whose bytes drifted from the gated
      // review, is the out-of-band signal this record exists to surface.
      emitOperationalEvent("warn", "scan.gate_continuity.broken", {
        scanId: args.identity.scanId,
        organizationId: args.identity.organizationId,
        packageName: args.packageName,
        version: args.version,
        status: continuity.status,
        gateScanId: continuity.review?.scanId ?? null,
      });
    }
    return continuity;
  } catch (err) {
    emitOperationalEvent("warn", "scan.gate_continuity.lookup_failed", {
      scanId: args.identity.scanId,
      organizationId: args.identity.organizationId,
      packageName: args.packageName,
      error: describeOperationalError(err),
    });
    return null;
  }
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
  return {
    status: status as GateContinuityStatus,
    algorithm: "sha256",
    stagedDigest: normalizeSha256(value.stagedDigest),
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
