import type { PublicationObservation } from "../../../db/publication-watches";
import type { scans } from "../../../db/schema";
import { isRecord } from "../../platform/guards";
import { parseStagedArtifactIntegrity } from "../artifact-integrity";
import { parseNpmReleaseManifest } from "./manifest";

export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";

export type ReviewEvidence = Pick<
  typeof scans.$inferSelect,
  | "id"
  | "source"
  | "registryUrl"
  | "registryPackageName"
  | "registryVersion"
  | "registryStatusSupersededAt"
  | "packageName"
  | "stagedVersion"
  | "decision"
  | "decidedAt"
  | "summaryJson"
  | "status"
>;
export type Verdict = Pick<PublicationObservation, "status" | "reason" | "scanId">;
export interface PublishedDigests {
  sha1: string;
  sha256: string;
}
/** Why the published tarball could not be hashed. */
export type ArtifactUnavailableReason =
  | "artifact_unavailable"
  | "artifact_timeout"
  | "artifact_too_large"
  | "artifact_identity_invalid";

/**
 * Unknown causes another check cannot resolve by itself: a published version's
 * bytes are immutable and the review evidence is settled. They are re-evaluated
 * on a slow cadence, from stored digests and never a fresh download, so they
 * neither re-fetch tarballs nor crowd out new releases. An oversized tarball
 * stays unhashable, so it settles too; timeouts and outages are retried.
 */
const SETTLED_UNKNOWN_REASONS: ReadonlySet<string> = new Set([
  "reviewed_without_decision",
  "reviewed_other_artifact",
  "decision_history_unavailable",
  "review_digest_unavailable",
  "review_superseded",
  "review_history_limit",
  "artifact_too_large",
]);

export function isSettledUnknownReason(reason: string | null): boolean {
  return reason !== null && SETTLED_UNKNOWN_REASONS.has(reason);
}

function normalizedRegistry(url: string | null): string | undefined {
  return url?.replace(/\/$/, "");
}

/**
 * The organization's Drydock records of exactly this release: a workflow gate
 * for it, or a staged review bound to the monitored registry's coordinates.
 * Published-pair reviews happen after publication and are never evidence of
 * the release path, so they are not records here.
 */
export function releaseRecords(
  name: string,
  version: string,
  reviews: readonly ReviewEvidence[],
  registry = PUBLIC_NPM_REGISTRY,
): ReviewEvidence[] {
  return reviews.filter(
    (scan) =>
      scan.packageName === name &&
      scan.stagedVersion === version &&
      (scan.source === "workflow_gate" ||
        (scan.source !== "published" &&
          normalizedRegistry(scan.registryUrl) === registry &&
          scan.registryPackageName === name &&
          scan.registryVersion === version)),
  );
}

function reviewDigest(
  scan: ReviewEvidence,
  name: string,
  version: string,
): { algorithm: "sha1" | "sha256"; digest: string } | null {
  if (scan.status !== "complete") return null;
  if (!isRecord(scan.summaryJson) || !isRecord(scan.summaryJson.stagedPublish)) return null;
  const details = scan.summaryJson.stagedPublish;
  if (scan.source === "workflow_gate") {
    try {
      const manifest = parseNpmReleaseManifest(details.manifest);
      if (
        details.mode !== "workflow_gate" ||
        manifest.package !== name ||
        manifest.version !== version ||
        manifest.artifacts.length !== 1
      )
        return null;
      const artifact = manifest.artifacts[0]!;
      if (typeof details.digest !== "string" || details.digest.toLowerCase() !== artifact.sha256)
        return null;
      return { algorithm: "sha256", digest: artifact.sha256 };
    } catch {
      return null;
    }
  }
  const integrity = parseStagedArtifactIntegrity(details.artifactIntegrity);
  return integrity?.status === "verified" && integrity.computed
    ? { algorithm: "sha1", digest: integrity.computed }
    : null;
}

function decidedBefore(scan: ReviewEvidence, publishedAt: Date): boolean {
  return scan.decision !== null && scan.decidedAt !== null && scan.decidedAt < publishedAt;
}

function decidedSince(scan: ReviewEvidence, publishedAt: Date): boolean {
  return scan.decision !== null && scan.decidedAt !== null && scan.decidedAt >= publishedAt;
}

function newestDecision(candidates: readonly ReviewEvidence[]): ReviewEvidence | undefined {
  return [...candidates].sort((a, b) => b.decidedAt!.getTime() - a.decidedAt!.getTime())[0];
}

const unknown = (reason: string, scanId: string | null = null): Verdict => ({
  status: "unknown",
  reason,
  scanId,
});

/**
 * Compare one published release with the organization's Drydock records.
 *
 * Only a release with no Drydock record at all is `published_without_approval`,
 * and that verdict needs no bytes: a tarball too large or slow to hash cannot
 * hide it. Every other outcome compares the published digests with a review,
 * so an unhashable artifact leaves it `unknown` with the reason why.
 *
 * A record that has not examined the published bytes — a pending, running,
 * failed or undecided review — is the owner's own release path in flight, not
 * evidence of a bypass, so it yields `unknown` rather than an accusation. A
 * review superseded by a newer stage of the same version never produces a
 * mismatch on its own; whichever review examined the published bytes decides.
 */
export function classifyPublication(
  name: string,
  version: string,
  publishedAt: Date | null,
  artifact: PublishedDigests | ArtifactUnavailableReason | null,
  reviews: readonly ReviewEvidence[],
  registry = PUBLIC_NPM_REGISTRY,
): Verdict {
  if (!publishedAt) return unknown("publication_time_unavailable");
  const records = releaseRecords(name, version, reviews, registry);
  if (records.length === 0)
    return { status: "published_without_approval", reason: null, scanId: null };
  if (artifact === null) return unknown("artifact_unavailable");
  if (typeof artifact === "string") return unknown(artifact);

  const matching = records.filter((scan) => {
    const evidence = reviewDigest(scan, name, version);
    return evidence !== null && artifact[evidence.algorithm] === evidence.digest;
  });
  if (matching.length > 0) {
    // Identical bytes carry the same approval whichever stage delivered them,
    // so the newest decision on these bytes before publication is the answer.
    const decision = newestDecision(matching.filter((scan) => decidedBefore(scan, publishedAt)));
    if (decision) {
      return {
        status: decision.decision === "publish" ? "approved_match" : "published_despite_rejection",
        reason: null,
        scanId: decision.id,
      };
    }
    const late = matching.find((scan) => decidedSince(scan, publishedAt));
    if (late) return unknown("decision_history_unavailable", late.id);
    const current = matching.find((scan) => !scan.registryStatusSupersededAt) ?? matching[0]!;
    return unknown("reviewed_without_decision", current.id);
  }

  // No review examined these bytes. Reconfirming a decision after publication
  // overwrites its timestamp, so a late decision hides what was decided before.
  const late = records.find((scan) => decidedSince(scan, publishedAt));
  if (late) return unknown("decision_history_unavailable", late.id);
  const current = records.filter((scan) => !scan.registryStatusSupersededAt);
  const inFlight = current.find((scan) => scan.status === "pending" || scan.status === "running");
  if (inFlight) return unknown("review_pending", inFlight.id);
  const failed = current.find((scan) => scan.status === "failed");
  if (failed) return unknown("review_failed", failed.id);
  const unbound = current.find((scan) => !reviewDigest(scan, name, version));
  if (unbound) return unknown("review_digest_unavailable", unbound.id);
  const undecided = current.find((scan) => scan.decision === null);
  if (undecided) return unknown("reviewed_other_artifact", undecided.id);
  const approval = newestDecision(
    current.filter((scan) => scan.decision === "publish" && decidedBefore(scan, publishedAt)),
  );
  if (approval) return { status: "artifact_mismatch", reason: null, scanId: approval.id };
  if (current.length === 0) return unknown("review_superseded");
  // Every current review rejected other bytes before this publication.
  return { status: "published_without_approval", reason: null, scanId: null };
}
