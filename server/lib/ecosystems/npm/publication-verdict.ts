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
  | "riskSummaryJson"
  | "aiJson"
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
  "decision_history_unavailable",
  "review_digest_unavailable",
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
      const digests: RecordDigest[] = [
        { algorithm: "sha256", digest: artifact.sha256, reviewed: true },
      ];
      // Gate reviews recorded since the gate began hashing SHA-1 too carry it,
      // so npm's one-sided shasum can be compared when the published tarball
      // cannot be hashed. Older gate records have only SHA-256.
      const sha1 = sha1OrNull(details.sha1);
      if (sha1) digests.push({ algorithm: "sha1", digest: sha1, reviewed: true });
      return digests;
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
 * When only the newest records were read, the alert says so.
 */
function unmatchedVerdict(records: readonly ReviewEvidence[], historyLimited: boolean): Verdict {
  const reason = historyLimited ? "review_history_limit" : null;
  const decided = records.filter((scan) => scan.decision !== null && scan.decidedAt !== null);
  if (decided.length === 0 && !records.some((scan) => scan.registryStatusSupersededAt)) {
    return { status: "published_without_approval", reason, scanId: null };
  }
  const evidence =
    newestDecision(decided.filter((scan) => scan.decision === "publish")) ??
    newestDecision(decided) ??
    records.find((scan) => !scan.registryStatusSupersededAt) ??
    records[0]!;
  return { status: "artifact_mismatch", reason, scanId: evidence.id };
}

/**
 * What a completed review nobody decided says about the release it reviewed:
 *
 * - `ai_flagged`: the AI reviewer judged it `suspicious` or `blocked`.
 * - `risky`: anything that keeps it from reading low. Release risk (not
 *   artifact or context risk: those describe the package, not this release)
 *   above low or unreadable, no published baseline compared (so release risk
 *   graded nothing), or an AI review that asked for a look
 *   (`review_recommended`, manual review) or was attempted and did not finish.
 * - `low_risk`: release risk low and the AI reviewer raised nothing, or no AI
 *   review ran.
 *
 * AI review is advisory and only escalates: a clean AI review never lowers a
 * deterministic grade, since the release risk it is checked against already
 * carries the deterministic score. With the organization's `ai-review`
 * killswitch off (`aiReview: false`) the AI result is not read at all, so
 * nothing is `ai_flagged` and the tier rests on the persisted grades alone
 * (which keep any escalation the AI added while the review ran).
 */
export type UndecidedReviewTier = "low_risk" | "risky" | "ai_flagged";

type AiSignal = "none" | "clean" | "concern" | "flagged";

function aiSignal(aiJson: unknown): AiSignal {
  if (!isRecord(aiJson)) return "none";
  const attempted = aiJson.model !== null && aiJson.model !== undefined;
  if (aiJson.status !== "complete" || aiJson.releaseAssessment === "not_assessed") {
    // The disabled placeholder records no model: no reviewer ran. An attempt
    // that did not finish must not read as clean, as in release scoring.
    return attempted || (aiJson.status !== "unavailable" && aiJson.status !== "invalid")
      ? "concern"
      : "none";
  }
  if (aiJson.releaseAssessment === "suspicious" || aiJson.releaseAssessment === "blocked") {
    return "flagged";
  }
  return aiJson.releaseAssessment === "nothing_unusual" && aiJson.requiresManualReview === false
    ? "clean"
    : "concern";
}

export function undecidedReviewTier(
  scan: Pick<ReviewEvidence, "status" | "riskSummaryJson" | "aiJson" | "summaryJson">,
  options: { aiReview: boolean },
): UndecidedReviewTier {
  const ai = options.aiReview ? aiSignal(scan.aiJson) : "none";
  if (ai === "flagged") return "ai_flagged";
  if (scan.status !== "complete" || ai === "concern") return "risky";
  const releaseRisk = isRecord(scan.riskSummaryJson) ? scan.riskSummaryJson.releaseRisk : null;
  if (releaseRisk !== "low") return "risky";
  const baseline =
    isRecord(scan.summaryJson) && isRecord(scan.summaryJson.baseline)
      ? scan.summaryJson.baseline
      : null;
  if (baseline?.comparisonSkipped != null) return "risky";
  return "low_risk";
}

/**
 * The published bytes match only records nobody decided. npm reports a
 * version as published the same way whether it was promoted from a stage
 * (which needs the maintainer's 2FA) or published directly, so such a record
 * cannot tell the owner's release from a bypass: an attacker who can stage can
 * create one for the very bytes they then publish. A review in flight or
 * failed stays an alert. A completed review is tiered by what it found: one
 * that graded the release low risk is recorded without an alert, accepting
 * that a bypass of bytes Drydock graded low risk goes unannounced, because
 * owners who approve on npm and never decide here made that alert mostly
 * noise. Quiet needs every matching record to read low, both sides hashed by
 * Drydock (the published tarball here, the reviewed one in the sandbox), and
 * every record of the version compared.
 */
function undecidedVerdict(
  matching: readonly { scan: ReviewEvidence; reviewed: boolean }[],
  unhashed: ArtifactUnavailableReason | null,
  options: { aiReview: boolean; historyLimited: boolean },
): Verdict {
  const scans = matching.map(({ scan }) => scan);
  const owner = scans.find((scan) => !scan.registryStatusSupersededAt) ?? scans[0]!;
  if (owner.status === "pending" || owner.status === "running") {
    return { status: "published_without_approval", reason: "review_pending", scanId: owner.id };
  }
  if (owner.status === "failed") {
    return { status: "published_without_approval", reason: "review_failed", scanId: owner.id };
  }
  const tiers = matching.map(({ scan, reviewed }) => ({
    scan,
    reviewed,
    tier: undecidedReviewTier(scan, options),
  }));
  const flagged = tiers.find(({ tier }) => tier === "ai_flagged");
  if (flagged) {
    return {
      status: "published_without_approval",
      reason: "ai_flagged_without_decision",
      scanId: flagged.scan.id,
    };
  }
  const quiet =
    !unhashed &&
    !options.historyLimited &&
    tiers.every(({ tier, reviewed }) => tier === "low_risk" && reviewed);
  return quiet
    ? { status: "undecided_low_risk", reason: null, scanId: owner.id }
    : {
        status: "published_without_approval",
        reason: "reviewed_risk_without_decision",
        scanId: owner.id,
      };
}

/**
 * The published bytes match these records. Only a decision someone in the
 * organization made can settle the verdict: a record alone proves nothing
 * (see `undecidedVerdict`).
 *
 * `unhashed` is set when the match rests on npm's own shasum because the
 * tarball could not be hashed here: an approval then stays `unknown`.
 */
function matchedVerdict(
  matching: readonly { scan: ReviewEvidence; reviewed: boolean }[],
  publishedAt: Date,
  unhashed: ArtifactUnavailableReason | null,
  options: { aiReview: boolean; historyLimited: boolean },
): Verdict {
  const scansOfTheseBytes = matching.map(({ scan }) => scan);
  const decided = scansOfTheseBytes.filter(
    (scan) => scan.decision !== null && scan.decidedAt !== null,
  );
  if (decided.length === 0) return undecidedVerdict(matching, unhashed, options);
  const before = decided.filter((scan) => scan.decidedAt! < publishedAt);
  const late = decided.filter((scan) => scan.decidedAt! >= publishedAt);
  // A rejection of these exact bytes with no approval of them anywhere alerts,
  // whether it was recorded before or after publication.
  if (decided.every((scan) => scan.decision === "no_publish")) {
    const rejectedBefore = newestDecision(before);
    return rejectedBefore
      ? { status: "published_despite_rejection", reason: null, scanId: rejectedBefore.id }
      : {
          status: "published_despite_rejection",
          reason: "rejected_after_publication",
          scanId: newestDecision(late)!.id,
        };
  }
  // Some approval of these bytes exists. Resting on npm's declared shasum, it
  // stays unknown for the reason the bytes were not hashed, so the release is
  // retried or reported as a coverage gap rather than settled.
  if (unhashed) return unknown(unhashed, newestDecision(decided)!.id);
  // Reconfirming a decision after publication overwrites its timestamp, so a
  // late decision beside an approval of these bytes may hide a newer
  // pre-publication decision than any still visible, in either direction.
  if (late.length) return unknown("decision_history_unavailable", newestDecision(late)!.id);
  // Identical bytes carry the same decision whichever stage delivered them,
  // so the newest decision on these bytes before publication is the answer.
  const decision = newestDecision(before)!;
  if (decision.decision === "no_publish") {
    return { status: "published_despite_rejection", reason: null, scanId: decision.id };
  }
  // An approval counts only for bytes Drydock itself hashed while reviewing.
  return matching.some(({ scan, reviewed }) => scan === decision && reviewed)
    ? { status: "approved_match", reason: null, scanId: decision.id }
    : unknown("review_digest_unavailable", decision.id);
}

/**
 * Compare one published release with the organization's Drydock records.
 *
 * Only a release with no record at all is `published_without_approval`
 * without looking at bytes, so a tarball too large or slow to hash cannot hide
 * it. Otherwise the verdict turns on the records of the same bytes (by digest).
 * When the bytes cannot be hashed and every record that carries a digest
 * carries a SHA-1, npm's own `dist.shasum` identifies them one-sidedly: it can
 * raise an alert but never establish an approval. `historyLimited` says the
 * records are only the newest of more than were read. `aiReview` is the
 * organization's `ai-review` killswitch: off (the default), the AI result of
 * an undecided review is not read.
 */
export function classifyPublication(
  name: string,
  version: string,
  publishedAt: Date | null,
  artifact: PublishedDigests | ArtifactUnavailableReason | null,
  reviews: readonly ReviewEvidence[],
  options: {
    registry?: string;
    declaredSha1?: unknown;
    historyLimited?: boolean;
    aiReview?: boolean;
  } = {},
): Verdict {
  if (!publishedAt) return unknown("publication_time_unavailable");
  const historyLimited = options.historyLimited ?? false;
  const tiering = { aiReview: options.aiReview ?? false, historyLimited };
  const records = releaseRecords(name, version, reviews, options.registry);
  if (records.length === 0)
    return {
      status: "published_without_approval",
      reason: historyLimited ? "review_history_limit" : null,
      scanId: null,
    };
  const vouched = records.map((scan) => ({ scan, digests: recordDigests(scan, name, version) }));

  if (artifact === null || typeof artifact === "string") {
    const reason = artifact ?? "artifact_unavailable";
    const declared = sha1OrNull(options.declaredSha1);
    // A record with no digest can match no bytes, so only records that carry
    // one must be comparable by SHA-1 (a legacy gate record carries SHA-256 only).
    const comparable = vouched.every(
      ({ digests }) => digests.length === 0 || digests.some((entry) => entry.algorithm === "sha1"),
    );
    if (!declared || !comparable) return unknown(reason);
    const matching = vouched.flatMap(({ scan, digests }) => {
      const hits = digests.filter(
        (entry) => entry.algorithm === "sha1" && entry.digest === declared,
      );
      return hits.length ? [{ scan, reviewed: false }] : [];
    });
    return matching.length
      ? matchedVerdict(matching, publishedAt, reason, tiering)
      : unmatchedVerdict(records, historyLimited);
  }

  const matching = vouched.flatMap(({ scan, digests }) => {
    // A record that carries SHA-256 is matched by SHA-256 alone: its SHA-1 is
    // there only for when the bytes cannot be hashed, and must never let a
    // SHA-1 collision stand in for bytes whose SHA-256 differs.
    const strongest = digests.some((entry) => entry.algorithm === "sha256")
      ? digests.filter((entry) => entry.algorithm === "sha256")
      : digests;
    const hits = strongest.filter((entry) => artifact[entry.algorithm] === entry.digest);
    return hits.length ? [{ scan, reviewed: hits.some((entry) => entry.reviewed) }] : [];
  });
  return matching.length
    ? matchedVerdict(matching, publishedAt, null, tiering)
    : unmatchedVerdict(records, historyLimited);
}
