import { DETERMINISTIC_RULES_VERSION } from "./review/rules";
import { tag } from "./review/rules/helpers";
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

export type ProvenanceStatus = RegistryProvenance["status"];

interface ProvenanceSide {
  version: string;
  provenance: RegistryProvenance;
}

export interface ProvenanceContinuityArgs {
  /** Registry display name for evidence text, e.g. `npm`, `PyPI`. */
  registry: string;
  baseline: ProvenanceSide;
  candidate: ProvenanceSide;
  /**
   * Provenance of the releases before the baseline in the candidate's channel,
   * newest first (`provenanceLineage().prior`). A drop is medium only after
   * `ESTABLISHED_PROVENANCE_RELEASES` attested releases in a row.
   */
  prior: ProvenanceStatus[];
  /**
   * What an absent candidate was read from. PyPI reads the files the diff
   * selected, so its absence is about those files, not the whole release.
   */
  absenceScope?: "release" | "checked-files";
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

/**
 * Attested releases in a row, the baseline included, before a drop is medium.
 * Projects adopting provenance commonly ship one or two attested releases and
 * then publish from a laptop again while CI settles; three matches
 * `release.source-drift`'s history bar and is what an established attested
 * release habit looks like.
 */
const ESTABLISHED_PROVENANCE_RELEASES = 3;

/**
 * The releases a candidate's provenance is judged against: the baseline it is
 * compared with, and the releases before that baseline, newest first, up to
 * the history the drop rule reads.
 */
export interface ProvenanceLineage {
  baseline: string;
  prior: string[];
}

export interface ProvenanceVersionScheme<P> {
  parse(version: string): P | null;
  compare(a: P, b: P): number;
  isPrerelease(version: P): boolean;
  /** Publish time in epoch ms, or null when the registry did not say. */
  publishedAt(version: string): number | null;
}

/**
 * Choose the provenance baseline and history for a candidate: earlier releases
 * in its channel that were already published when it was.
 *
 * A stable release is judged against earlier stable releases: comparing it
 * with its own CI-built prerelease would report a hand-published stable as a
 * drop. A prerelease may follow a release of either channel. Publish time
 * matters as much as version order: a maintenance line that adopted provenance
 * after the next major shipped (4.22.3 published after 5.0.0) is not something
 * 5.0.0 could have dropped. When the requested baseline fails either test, the
 * highest qualifying release stands in. Returns null for a pair that is not
 * forward or has no qualifying baseline.
 */
export function provenanceLineage<P>(
  scheme: ProvenanceVersionScheme<P>,
  versions: Iterable<string>,
  baseline: string,
  candidate: string,
): ProvenanceLineage | null {
  const candidateParsed = scheme.parse(candidate);
  const baselineParsed = scheme.parse(baseline);
  if (!candidateParsed || !baselineParsed) return null;
  if (scheme.compare(candidateParsed, baselineParsed) <= 0) return null;
  const stableOnly = !scheme.isPrerelease(candidateParsed);
  const candidateTime = scheme.publishedAt(candidate);
  const qualifies = (version: string, parsed: P) => {
    if (scheme.compare(parsed, candidateParsed) >= 0) return false;
    if (stableOnly && scheme.isPrerelease(parsed)) return false;
    const time = scheme.publishedAt(version);
    return candidateTime === null || time === null || time < candidateTime;
  };
  const channel: Array<{ version: string; parsed: P }> = [];
  for (const version of new Set(versions)) {
    const parsed = scheme.parse(version);
    if (parsed && qualifies(version, parsed)) channel.push({ version, parsed });
  }
  channel.sort((a, b) => scheme.compare(b.parsed, a.parsed));
  const effective = qualifies(baseline, baselineParsed)
    ? { version: baseline, parsed: baselineParsed }
    : channel[0];
  if (!effective) return null;
  return {
    baseline: effective.version,
    prior: channel
      .filter((entry) => scheme.compare(entry.parsed, effective.parsed) < 0)
      .slice(0, ESTABLISHED_PROVENANCE_RELEASES - 1)
      .map((entry) => entry.version),
  };
}

export interface ProvenanceContinuityOutcome {
  findings: Finding[];
  /**
   * A read on either side or in the history was undetermined. A cached review
   * must not let a transient registry failure stand in for the registry's
   * answer for long.
   */
  unsettled: boolean;
}

export const PROVENANCE_NOT_EVALUATED: ProvenanceContinuityOutcome = Object.freeze({
  findings: [],
  unsettled: false,
});

export function evaluateProvenanceContinuity(
  args: ProvenanceContinuityArgs,
): ProvenanceContinuityOutcome {
  return {
    findings: provenanceContinuityFindings(args),
    unsettled:
      args.baseline.provenance.status === "unknown" ||
      args.candidate.provenance.status === "unknown" ||
      args.prior.includes("unknown"),
  };
}

export function provenanceContinuityFindings(args: ProvenanceContinuityArgs): Finding[] {
  const { baseline, candidate } = args;
  if (baseline.provenance.status !== "present") return [];

  if (candidate.provenance.status === "absent") {
    const from = describePublishers(baseline.provenance.publishers);
    const established = isEstablished(args.prior);
    const scope =
      args.absenceScope === "checked-files"
        ? `for the checked files of ${candidate.version}`
        : `for ${candidate.version}`;
    return [
      stamp(
        tag("releaseProvenanceDropped", {
          severity: established ? "medium" : "low",
          file: RELEASE_PROCESS_FINDING_FILE,
          evidence: `${args.registry} reports build provenance for ${baseline.version}${from ? ` (${from})` : ""}${established ? ` and the ${ESTABLISHED_PROVENANCE_RELEASES - 1} releases before it` : ""}, and none ${scope}`,
          reason: established
            ? "the previous releases were published from attested CI builds and this one carries no provenance; a release published around CI with a stolen token has exactly this shape, but so does a maintainer publishing from their own machine or moving to CI that does not attest — confirm how this release was published"
            : `the previous release carried build provenance and this one does not, but provenance was not yet attested for ${ESTABLISHED_PROVENANCE_RELEASES} releases in a row, which is how a project still settling its release pipeline looks; context, not release risk`,
        }),
      ),
    ];
  }

  if (candidate.provenance.status !== "present") return [];
  const before = baseline.provenance.publishers;
  const after = candidate.provenance.publishers;
  // Identity unreadable on either side: presence continued, nothing to compare.
  if (!before.length || !after.length) return [];

  const newRepository = after.filter((p) => !before.some((b) => sameRepository(b, p)));
  if (newRepository.length) {
    const evidence = `${args.registry} provenance for ${baseline.version} names ${describePublishers(before)}; ${candidate.version} names ${describePublishers(newRepository)}${repositoryIdNote(before, newRepository)}`;
    // Without a stable id on both sides a rename cannot be told from a new
    // repository by name alone (PyPI records none). The owner is the boundary
    // an outside attacker cannot create repositories under.
    if (newRepository.every((p) => before.some((b) => sameOwnerWithoutIds(b, p)))) {
      return [
        publisherChanged(
          "low",
          `${evidence} (same owner; no repository id recorded to tell a rename from a new repository)`,
          "this release was built in a differently named repository under the same owner as the previous one; the registry records no stable repository id here, so this is usually a renamed repository or a moved release pipeline within the owner's account",
        ),
      ];
    }
    return [
      publisherChanged(
        "medium",
        evidence,
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

function isEstablished(prior: ProvenanceStatus[]): boolean {
  const needed = ESTABLISHED_PROVENANCE_RELEASES - 1;
  return prior.length >= needed && prior.slice(0, needed).every((status) => status === "present");
}

// These findings are composed outside `deterministicFindings`, so the version
// stamp it applies is applied here.
function stamp(finding: Finding): Finding {
  return { ...finding, ruleVersion: DETERMINISTIC_RULES_VERSION };
}

function publisherChanged(severity: "medium" | "low", evidence: string, reason: string): Finding {
  return stamp(
    tag("releaseProvenancePublisherChanged", {
      severity,
      file: RELEASE_PROCESS_FINDING_FILE,
      evidence,
      reason,
    }),
  );
}

function sameOwnerWithoutIds(a: AttestedPublisher, b: AttestedPublisher): boolean {
  if (!sameText(a.provider, b.provider) || (a.repositoryId && b.repositoryId)) return false;
  const owner = (p: AttestedPublisher) => p.repository.split("/").slice(0, 2).join("/");
  return sameText(owner(a), owner(b));
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
