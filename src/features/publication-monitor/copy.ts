// Publication-monitor wording shared by the dashboard card and the package
// page, so the same watch or observation never reads two different ways.
import { formatDateTime, pluralize } from "../../lib/format";
import type { PublicationObservation, PublicationWatch } from "../../models/publication-watches";

export const observationStatusLabels: Record<PublicationObservation["status"], string> = {
  approved_match: "Approved bytes published",
  published_without_approval: "Published with no approval in this organization",
  published_despite_rejection: "Published despite a rejection in this organization",
  artifact_mismatch: "Published bytes differ from what this organization reviewed",
  unknown: "Evidence unknown",
};

// Why a release is `unknown`: the monitor records one specific reason. A
// decision recorded only after publication is the organization's own act, so
// it must read as such, not as a problem.
const unknownReasonLabels: Record<string, string> = {
  publication_time_unavailable: "npm reports no publication time",
  review_pending: "a Drydock review of this version is still running",
  review_failed: "the Drydock review of this version failed",
  reviewed_without_decision: "reviewed these bytes, no decision recorded before publication",
  decision_history_unavailable: "decided only after publication",
  review_digest_unavailable: "npm's record matches, but the review could not confirm these bytes",
  review_history_limit: "too many reviews of this version to compare",
  artifact_too_large: "the tarball exceeds the 256 MiB hashing limit",
  artifact_timeout: "the tarball did not download in time",
  artifact_unavailable: "the tarball could not be downloaded",
  artifact_identity_invalid: "npm metadata names no valid tarball",
};

// What refines an alert. An undecided review of the published bytes is most
// often the owner's own release promoted before anyone decided, so it asks for
// the decision first and never accuses whoever published it.
const alertReasonLabels: Record<string, string> = {
  review_pending:
    "a Drydock review of these exact bytes is still undecided: decide it, or investigate if nobody here published it",
  review_failed:
    "the Drydock review of these exact bytes failed and nothing approved them: investigate if nobody here published it",
  reviewed_without_decision:
    "a Drydock review of these exact bytes is undecided: decide it, or investigate if nobody here published it",
  rejected_after_publication: "these exact bytes were rejected after they were published",
  review_history_limit: "matches none of the latest 100 Drydock records of this version",
};

function unknownReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return unknownReasonLabels[reason] ?? "evidence could not establish an outcome";
}

/** The recorded reason behind an observation, worded for its status. */
export function observationReasonLabel(
  observation: Pick<PublicationObservation, "status" | "reason">,
): string | null {
  if (observation.status === "unknown") return unknownReasonLabel(observation.reason);
  if (observation.status === "approved_match" || !observation.reason) return null;
  return alertReasonLabels[observation.reason] ?? null;
}

export function observationTone(status: PublicationObservation["status"]) {
  if (status === "approved_match") return "ok";
  if (status === "unknown") return "neutral";
  return "critical";
}

export function isPublicationAlert(status: PublicationObservation["status"]): boolean {
  return (
    status === "published_without_approval" ||
    status === "published_despite_rejection" ||
    status === "artifact_mismatch"
  );
}

const watchProblems: Record<string, string> = {
  registry_evidence_unavailable:
    "Drydock could not read this package from npm, so new releases are unknown until a check succeeds.",
  pending_release_backlog:
    "More releases are waiting to be checked. The next check continues where this one stopped.",
  invalid_version_metadata:
    "npm lists some versions with invalid metadata, so those versions could not be checked.",
  registry_metadata_too_large:
    "npm's document for this package is larger than Drydock reads (64 MiB), so its releases cannot be checked. This does not resolve by itself.",
  publication_history_limit:
    "This package has more versions than Drydock compares (10,000), so its releases cannot be checked. This does not resolve by itself.",
  artifact_too_large:
    "A published tarball exceeds the 256 MiB hashing limit, so that release may not be comparable with its reviews.",
  artifact_timeout:
    "A published tarball did not download in time. It is retried on the next check.",
  artifact_unavailable:
    "A published tarball could not be downloaded. It is retried on the next check.",
  artifact_identity_invalid:
    "A release's registry metadata does not name a valid tarball on npm, so its bytes cannot be compared.",
  monitoring_disabled: "Publication monitoring is switched off for this organization.",
  check_failed:
    "The latest check failed, so new releases are unknown. Drydock retries on the next automatic check.",
};

export function watchProblemMessage(lastError: string): string {
  return (
    watchProblems[lastError] ??
    "The latest check did not finish, so new releases are unknown until a check succeeds."
  );
}

// `staged_discovery` covers both the discovery sweep and a stage someone
// submitted by hand; "a staged review" is true of both.
const sourceLabels: Record<PublicationWatch["source"], string> = {
  manual: "added by hand",
  staged_discovery: "added from a staged review",
  published_history: "added from your past reviews",
};

/**
 * What an empty release list means. "No new releases" is claimed only after a
 * check that finished with no problem: any problem, even a backlog or one
 * unreadable version, can leave a new release unexamined and so unrecorded.
 */
export function emptyObservationsMessage(
  watch: Pick<PublicationWatch, "createdAt" | "lastCheckedAt" | "lastError">,
): string {
  if (!watch.lastCheckedAt) {
    return "Not checked yet. Drydock checks it automatically, or choose Check now.";
  }
  // The watch's problem, shown above the list, says what is unknown.
  if (watch.lastError) return "No releases recorded yet.";
  return `No new releases since you started watching on ${formatDateTime(watch.createdAt)}. Earlier releases are not checked.`;
}

// Mirrors the server's gap threshold: a shorter problem is only the watch's
// latest problem, shown above.
const COVERAGE_GAP_AFTER_MS = 60 * 60 * 1000;

const coverageGapReasons: Record<string, string> = {
  registry_metadata_too_large: "npm's document for it is larger than Drydock reads",
  publication_history_limit: "it has more versions than Drydock compares",
  registry_evidence_unavailable: "npm's document for it has not been readable for over an hour",
  invalid_version_metadata: "npm lists a version of it that Drydock cannot read as a version",
};

/**
 * What the watch cannot verify, worded as a coverage gap rather than a
 * discrepancy: nothing was found wrong, the comparison could not be made.
 * Null when every release is covered.
 */
export function coverageGapMessage(
  watch: Pick<
    PublicationWatch,
    "packageName" | "coverageGap" | "coverageGapSince" | "unverifiedReleaseCount"
  >,
  now = Date.now(),
): string | null {
  if (
    watch.coverageGap &&
    watch.coverageGapSince &&
    now - Date.parse(watch.coverageGapSince) >= COVERAGE_GAP_AFTER_MS
  ) {
    const reason = coverageGapReasons[watch.coverageGap] ?? "its releases cannot be compared";
    return `Drydock could not verify releases of ${watch.packageName} against this organization's reviews: ${reason}.`;
  }
  if (watch.unverifiedReleaseCount > 0) {
    const count = watch.unverifiedReleaseCount;
    return `Drydock could not verify ${count} ${pluralize("release", count)} of ${watch.packageName} against this organization's reviews. ${count === 1 ? "It is" : "They are"} marked "not verified" in the releases.`;
  }
  return null;
}

// What the latest check found, so a check that turns up nothing still reads
// as an answer rather than as a button that did nothing.
function releaseSummary(watch: PublicationWatch): string {
  if (!watch.lastCheckedAt) return "not checked yet";
  const checked = `checked ${formatDateTime(watch.lastCheckedAt)}`;
  if (watch.releaseCount > 0) {
    return `${checked} · ${watch.releaseCount} new ${pluralize("release", watch.releaseCount)}`;
  }
  return watch.lastError ? checked : `${checked} · no new releases`;
}

export function watchMetaLine(watch: PublicationWatch): string {
  return `watching since ${formatDateTime(watch.createdAt)} · ${releaseSummary(watch)} · ${sourceLabels[watch.source]}`;
}
