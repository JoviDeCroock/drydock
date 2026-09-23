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
  | "stagedDeclaredSha1"
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
  "decision_history_unavailable",
  "review_digest_unavailable",
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

function sha1OrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digest = value.trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(digest) ? digest : null;
}

/**
 * The digests a record can vouch for. `reviewed` means Drydock hashed those
 * bytes itself while reviewing them (a gate's manifest digest, or the staged
 * tarball the sandbox parsed, unless npm's record of the stage contradicted
 * it); the rest are npm's own record of the stage (its shasum), which
 * identifies the owner's staged bytes while the review is in flight, failed,
 * or unverified, but never stands in for an approval.
 */
interface RecordDigest {
  algorithm: "sha1" | "sha256";
  digest: string;
  reviewed: boolean;
}

function recordDigests(scan: ReviewEvidence, name: string, version: string): RecordDigest[] {
  const details =
    isRecord(scan.summaryJson) && isRecord(scan.summaryJson.stagedPublish)
      ? scan.summaryJson.stagedPublish
      : null;
  if (scan.source === "workflow_gate") {
    if (scan.status !== "complete" || !details) return [];
    try {
      const manifest = parseNpmReleaseManifest(details.manifest);
      if (
        details.mode !== "workflow_gate" ||
        manifest.package !== name ||
        manifest.version !== version ||
        manifest.artifacts.length !== 1
      )
        return [];
      const artifact = manifest.artifacts[0]!;
      if (typeof details.digest !== "string" || details.digest.toLowerCase() !== artifact.sha256)
        return [];
      return [{ algorithm: "sha256", digest: artifact.sha256, reviewed: true }];
    } catch {
      return [];
    }
  }
  const digests: RecordDigest[] = [];
  const integrity = details ? parseStagedArtifactIntegrity(details.artifactIntegrity) : null;
  const computed = scan.status === "complete" ? sha1OrNull(integrity?.computed) : null;
  if (computed) {
    digests.push({
      algorithm: "sha1",
      digest: computed,
      reviewed: integrity?.status !== "mismatch",
    });
  }
  for (const declared of [scan.stagedDeclaredSha1, details?.shasum, integrity?.declared]) {
    const digest = sha1OrNull(declared);
    if (digest && !digests.some((entry) => entry.digest === digest)) {
      digests.push({ algorithm: "sha1", digest, reviewed: false });
    }
  }
  return digests;
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
 * The published bytes match no record of this version. That is never
 * `unknown`: an attacker who can stage can create records, so only a record of
 * the same bytes may soften a verdict. Any decision on the version, or a
 * restage that superseded one of its stages, makes it a mismatch (a
 * superseded approval with no approved replacement included); otherwise the
 * organization never approved anything and it was published without approval.
 */
function unmatchedVerdict(records: readonly ReviewEvidence[]): Verdict {
  const decided = records.filter((scan) => scan.decision !== null && scan.decidedAt !== null);
  if (decided.length === 0 && !records.some((scan) => scan.registryStatusSupersededAt)) {
    return { status: "published_without_approval", reason: null, scanId: null };
  }
  const evidence =
    newestDecision(decided.filter((scan) => scan.decision === "publish")) ??
    newestDecision(decided) ??
    records.find((scan) => !scan.registryStatusSupersededAt) ??
    records[0]!;
  return { status: "artifact_mismatch", reason: null, scanId: evidence.id };
}

/**
 * Compare one published release with the organization's Drydock records.
 *
 * `unknown` is earned only by a record of the same bytes npm now serves (by
 * digest): that is the owner's own staged release, still in review, failed,
 * or published before anyone decided. Only a release with no record at all is
 * `published_without_approval` without looking at bytes, so a tarball too
 * large or slow to hash cannot hide it. When the bytes cannot be hashed and
 * every record carries a SHA-1, npm's own `dist.shasum` is compared one-sidedly:
 * a difference raises the alert, a match stays `unknown` because the bytes
 * were not independently hashed.
 */
export function classifyPublication(
  name: string,
  version: string,
  publishedAt: Date | null,
  artifact: PublishedDigests | ArtifactUnavailableReason | null,
  reviews: readonly ReviewEvidence[],
  options: { registry?: string; declaredSha1?: unknown } = {},
): Verdict {
  if (!publishedAt) return unknown("publication_time_unavailable");
  const records = releaseRecords(name, version, reviews, options.registry);
  if (records.length === 0)
    return { status: "published_without_approval", reason: null, scanId: null };
  const vouched = records.map((scan) => ({ scan, digests: recordDigests(scan, name, version) }));

  if (artifact === null || typeof artifact === "string") {
    const reason = artifact ?? "artifact_unavailable";
    const declared = sha1OrNull(options.declaredSha1);
    const comparable = vouched.every(({ digests }) =>
      digests.some((entry) => entry.algorithm === "sha1"),
    );
    if (!declared || !comparable) return unknown(reason);
    return vouched.some(({ digests }) => digests.some((entry) => entry.digest === declared))
      ? unknown(reason)
      : unmatchedVerdict(records);
  }

  const matching = vouched.flatMap(({ scan, digests }) => {
    const hits = digests.filter((entry) => artifact[entry.algorithm] === entry.digest);
    return hits.length ? [{ scan, reviewed: hits.some((entry) => entry.reviewed) }] : [];
  });
  if (matching.length === 0) return unmatchedVerdict(records);

  const scansOfTheseBytes = matching.map(({ scan }) => scan);
  // Reconfirming a decision after publication overwrites its timestamp, so a
  // late decision on these bytes may hide a newer pre-publication decision
  // than any still visible: neither an approval nor a rejection is certain.
  const late = scansOfTheseBytes.find((scan) => decidedSince(scan, publishedAt));
  if (late) return unknown("decision_history_unavailable", late.id);
  // Identical bytes carry the same decision whichever stage delivered them,
  // so the newest decision on these bytes before publication is the answer.
  const decision = newestDecision(
    scansOfTheseBytes.filter((scan) => decidedBefore(scan, publishedAt)),
  );
  if (decision?.decision === "no_publish") {
    return { status: "published_despite_rejection", reason: null, scanId: decision.id };
  }
  if (decision) {
    // An approval counts only for bytes Drydock itself hashed while reviewing.
    return matching.some(({ scan, reviewed }) => scan === decision && reviewed)
      ? { status: "approved_match", reason: null, scanId: decision.id }
      : unknown("review_digest_unavailable", decision.id);
  }
  const owner =
    scansOfTheseBytes.find((scan) => !scan.registryStatusSupersededAt) ?? scansOfTheseBytes[0]!;
  if (owner.status === "pending" || owner.status === "running")
    return unknown("review_pending", owner.id);
  if (owner.status === "failed") return unknown("review_failed", owner.id);
  return unknown("reviewed_without_decision", owner.id);
}
