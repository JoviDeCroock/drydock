import { DETERMINISTIC_RULE_IDS, DETERMINISTIC_RULES_VERSION } from "./review/rules";
import type { Finding } from "./review";
import { RELEASE_PROCESS_FINDING_FILE } from "./release-fingerprint";

/**
 * Registry provenance continuity: compares what a registry says about how a
 * published baseline and a published candidate were built.
 *
 * A valid attestation says who built a release, not what is in it, so presence
 * alone proves little. A *change* between two releases of one package is the
 * signal: the stolen-token publish from a laptop drops provenance the package
 * always had, and a publish from an attacker-controlled repository names a new
 * one. Everything here is about the registry's served record; signatures are
 * not re-verified (see docs/provenance-continuity.md for that trust argument).
 *
 * The ecosystem readers (`ecosystems/npm/provenance.ts`,
 * `ecosystems/pypi/provenance.ts`) reduce hostile registry documents to this
 * shape. Anything they cannot read with certainty is `unknown`, and `unknown`
 * never produces a finding.
 */

export interface AttestedPublisher {
  /** Lowercase CI provider: `github`, `gitlab`. */
  provider: string;
  /** Host-qualified repository as attested, e.g. `github.com/owner/repo`. */
  repository: string;
  /** Provider's stable repository id when attested; survives renames and transfers. */
  repositoryId: string | null;
  /** Workflow as attested: a repository-relative path on npm, a bare file name on PyPI. */
  workflow: string | null;
}

export type RegistryProvenance =
  /**
   * The registry affirms provenance exists. `publishers` is empty when the
   * attested identity could not be read (unknown build type, failed fetch):
   * presence is still known, so a later drop is still a drop.
   */
  | { status: "present"; publishers: AttestedPublisher[] }
  /** The registry affirmatively reports no provenance for this release. */
  | { status: "absent" }
  /** Not determined: network failure, malformed record, unsupported registry. */
  | { status: "unknown" };

export const PROVENANCE_UNKNOWN: RegistryProvenance = Object.freeze({ status: "unknown" });

interface ProvenanceSide {
  version: string;
  provenance: RegistryProvenance;
}

export interface ProvenanceContinuityArgs {
  /** Registry display name for evidence text, e.g. `npm`, `PyPI`. */
  registry: string;
  baseline: ProvenanceSide;
  candidate: ProvenanceSide;
}

// Attested strings are publisher-influenced (a workflow path is whatever file
// the attacker's CI ran), so they are length-bounded and must be printable
// before they can reach evidence text or a comparison key.
const MAX_ATTESTED_FIELD_LENGTH = 256;

export function attestedField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ATTESTED_FIELD_LENGTH) return null;
  for (let i = 0; i < trimmed.length; i++) {
    if (isInvisibleOrControl(trimmed.charCodeAt(i))) return null;
  }
  return trimmed;
}

// C0/C1 controls plus zero-width and bidi formatting characters, which could
// make a publisher-chosen workflow name render as a different one in evidence.
function isInvisibleOrControl(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/** A stable numeric id (GitHub repository_id, GitLab project id) or null. */
export function attestedNumericId(value: unknown): string | null {
  const text = typeof value === "number" ? String(value) : attestedField(value);
  return text && /^\d{1,20}$/.test(text) ? text : null;
}

/**
 * `https://github.com/Owner/Repo`, `git+https://github.com/Owner/Repo@refs/x`
 * → `github.com/Owner/Repo`. Case is kept for display; comparison folds it.
 */
export function attestedRepositoryFromUrl(value: unknown): string | null {
  const raw = attestedField(value);
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.replace(/^git\+/, ""));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return null;
  }
  const path = url.pathname
    .split("@")[0]
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  if (!/^(\/[A-Za-z0-9._-]+){2,}$/.test(path)) return null;
  return `${url.host.toLowerCase()}${path}`;
}

/** Same attested identity, for de-duplicating publishers within one release. */
export function sameAttestedPublisher(a: AttestedPublisher, b: AttestedPublisher): boolean {
  return (
    a.provider === b.provider &&
    a.repository.toLowerCase() === b.repository.toLowerCase() &&
    a.repositoryId === b.repositoryId &&
    (a.workflow ?? "").toLowerCase() === (b.workflow ?? "").toLowerCase()
  );
}

export function provenanceContinuityFindings(args: ProvenanceContinuityArgs): Finding[] {
  const { baseline, candidate } = args;
  if (baseline.provenance.status !== "present") return [];

  if (candidate.provenance.status === "absent") {
    const from = describePublishers(baseline.provenance.publishers);
    return [
      {
        severity: "medium",
        file: RELEASE_PROCESS_FINDING_FILE,
        evidence: `${args.registry} reports build provenance for ${baseline.version}${from ? ` (${from})` : ""} and none for the checked files of ${candidate.version}`,
        reason:
          "the previous release was published from an attested CI build and this one carries no provenance; a release published around CI with a stolen token has exactly this shape, but so does a maintainer publishing from their own machine or moving to CI that does not attest — confirm how this release was published",
        ruleId: DETERMINISTIC_RULE_IDS.releaseProvenanceDropped,
        ruleVersion: DETERMINISTIC_RULES_VERSION,
      },
    ];
  }

  if (candidate.provenance.status !== "present") return [];
  const before = baseline.provenance.publishers;
  const after = candidate.provenance.publishers;
  // Identity unreadable on either side: presence continued, nothing to compare.
  if (!before.length || !after.length) return [];

  const newRepository = after.filter((p) => !before.some((b) => sameRepository(b, p)));
  if (newRepository.length) {
    return [
      publisherChanged(
        "medium",
        `${args.registry} provenance for ${baseline.version} names ${describePublishers(before)}; ${candidate.version} names ${describePublishers(newRepository)}${repositoryIdNote(before, newRepository)}`,
        "this release was built in a different source repository than the previous one; an attacker who cannot push to the real repository can still attest a build from one they control, so a repository change between releases is worth confirming with the maintainer before trusting this release",
      ),
    ];
  }

  // Same repository throughout. A workflow change is low: release workflows
  // get renamed and split routinely, so it is context, not release risk.
  const newWorkflow = after.filter((p) => {
    const workflow = p.workflow;
    if (workflow === null) return false;
    return !before.some(
      (b) => sameRepository(b, p) && (b.workflow === null || sameText(b.workflow, workflow)),
    );
  });
  if (!newWorkflow.length) return [];
  return [
    publisherChanged(
      "low",
      `${args.registry} provenance for ${baseline.version} names ${describePublishers(before)}; ${candidate.version} names ${describePublishers(newWorkflow)}`,
      "this release was built by a different workflow in the same repository than the previous one; usually a renamed or reorganized release pipeline, but a workflow that was never part of the release process is also how a repository compromise publishes",
    ),
  ];
}

function publisherChanged(severity: "medium" | "low", evidence: string, reason: string): Finding {
  return {
    severity,
    file: RELEASE_PROCESS_FINDING_FILE,
    evidence,
    reason,
    ruleId: DETERMINISTIC_RULE_IDS.releaseProvenancePublisherChanged,
    ruleVersion: DETERMINISTIC_RULES_VERSION,
  };
}

// A stable id on both sides is authoritative: equal ids with different names
// are a rename or transfer, and different ids behind one name are a repository
// that was deleted and re-registered (repo-jacking).
function sameRepository(a: AttestedPublisher, b: AttestedPublisher): boolean {
  if (!sameText(a.provider, b.provider)) return false;
  if (a.repositoryId && b.repositoryId) return a.repositoryId === b.repositoryId;
  return sameText(a.repository, b.repository);
}

function sameText(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function repositoryIdNote(before: AttestedPublisher[], after: AttestedPublisher[]): string {
  const reused = after.some((p) =>
    before.some(
      (b) =>
        sameText(b.repository, p.repository) &&
        b.repositoryId !== null &&
        p.repositoryId !== null &&
        b.repositoryId !== p.repositoryId,
    ),
  );
  return reused ? " (same repository name, different repository id)" : "";
}

function describePublishers(publishers: AttestedPublisher[]): string {
  return publishers
    .slice(0, 3)
    .map((p) => (p.workflow ? `${p.repository} ${p.workflow}` : p.repository))
    .join(", ");
}
