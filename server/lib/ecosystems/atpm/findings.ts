import type { AtpmVersion } from "./record";
import { atpmPurl, type AtpmProvenance, type AtpmProvenanceState } from "./provenance";
import type { AtpmStagedVersion } from "./stage-record";
import { matchTrustedPublisher, type AtpmTrustPublisher } from "./trust-publisher";
import { evaluateStagedArtifactIntegrity } from "../artifact-integrity";
import {
  DETERMINISTIC_RULE_IDS,
  DETERMINISTIC_RULES_VERSION,
  type Finding,
  type PackageJsonSummary,
} from "../../review";
import { PublicDiffError } from "../../public-diff/error";

/**
 * Findings that only exist because of how atpm stores a release.
 *
 * On npm the registry both records the metadata and holds the tarball, so the
 * two agreeing is the registry's own invariant. On atpm they are separate
 * objects in the publisher's repository: `meta` is a manifest the publisher
 * wrote into the record, and the blob is the artifact `npm install` unpacks. An
 * installing client reads the former and runs the latter, so a disagreement is
 * exactly the gap an attacker would want — a record that advertises one package
 * while shipping the bytes of another.
 *
 * Nothing here re-checks the blob's own content address: the CID is the
 * identifier the bytes were fetched by, so a PDS cannot substitute them without
 * the request simply failing. What these findings check is the layer above that,
 * where the record makes claims the CID does not bind.
 */
export function atpmRecordFindings(args: {
  entry: AtpmVersion;
  manifest: PackageJsonSummary | null;
  /** SHA-1 the sandbox computed over the tarball's wire bytes, if it saw all of them. */
  archiveSha1: string | null;
  /** SHA-512 over the same bytes, which is the digest a Sigstore subject binds. */
  archiveSha512: string | null;
  /** The record key this version was resolved under — the unscoped package name. */
  recordName: string;
  /** The publisher's trusted-publishing declaration for this package, if any. */
  trustPublisher: AtpmTrustPublisher | null;
  /** The version being compared against, so a lost attestation is visible. */
  baseline: AtpmVersion | null;
}): Finding[] {
  return [
    ...digestFindings(args.entry, args.archiveSha1),
    ...manifestFindings(args),
    ...provenanceFindings(args),
  ];
}

/**
 * A baseline mismatch cannot be represented as a target finding: continuing
 * would label the left side with a version its tarball does not authenticate.
 */
export function assertAtpmBaselineMetadata(args: {
  entry: AtpmVersion;
  manifest: PackageJsonSummary | null;
  archiveSha1: string | null;
  recordName: string;
}): void {
  const integrity = evaluateStagedArtifactIntegrity(args.entry.declaredShasum, args.archiveSha1);
  if (integrity.status === "mismatch" || manifestMismatches(args).length) {
    throw new PublicDiffError("baseline package metadata does not match its tarball", 502);
  }
}

function digestFindings(entry: AtpmVersion, archiveSha1: string | null): Finding[] {
  // Fails to "unverified" on a missing digest on either side; only a genuine
  // two-sided disagreement produces a finding.
  const integrity = evaluateStagedArtifactIntegrity(entry.declaredShasum, archiveSha1);
  if (integrity.status !== "mismatch") return [];
  return [
    {
      severity: "critical",
      file: "package.json",
      evidence: `blob ${integrity.algorithm} ${integrity.computed} != dist.shasum ${integrity.declared} declared in the package record`,
      reason:
        "the tarball attached to this version does not hash to the digest the package record declares for it, so the bytes reviewed here are not the bytes the record describes: treat every file, diff entry, and finding in this report as describing a different artifact",
      ruleId: DETERMINISTIC_RULE_IDS.stageTarballDigestMismatch,
      ruleVersion: DETERMINISTIC_RULES_VERSION,
    },
  ];
}

function manifestFindings(args: {
  entry: AtpmVersion;
  manifest: PackageJsonSummary | null;
  recordName: string;
}): Finding[] {
  return metadataMismatchFinding(manifestMismatches(args));
}

function manifestMismatches(args: {
  entry: AtpmVersion;
  manifest: PackageJsonSummary | null;
  recordName: string;
}): string[] {
  const { entry, manifest } = args;
  const mismatches: string[] = [];
  if (!manifest) {
    mismatches.push("tarball has no readable package.json");
    return mismatches;
  }

  // `PackageJsonSummary` describes values produced by our parser, but cached or
  // adversarial runtime data can still violate that TypeScript-only boundary.
  // Narrow before comparing or using string methods.
  const rawManifest = manifest as Record<string, unknown>;
  const manifestName =
    typeof rawManifest.name === "string" && rawManifest.name ? rawManifest.name : null;
  const manifestVersion =
    typeof rawManifest.version === "string" && rawManifest.version ? rawManifest.version : null;
  if (!manifestName) mismatches.push("tarball package.json has no readable name");
  if (!manifestVersion) mismatches.push("tarball package.json has no readable version");

  if (entry.declaredName && manifestName && entry.declaredName !== manifestName) {
    mismatches.push(`record meta.name ${entry.declaredName} != package.json name ${manifestName}`);
  }
  // `entry.version` is the key a client resolves a release by; `meta.version` is
  // what that same client is handed as the manifest. Both must agree with the
  // tarball or the version a lockfile pins is not the version that installs.
  for (const [label, declared] of [
    ["version", entry.version],
    ["meta.version", entry.declaredVersion],
  ] as const) {
    if (declared && manifestVersion && declared !== manifestVersion) {
      mismatches.push(`record ${label} ${declared} != package.json version ${manifestVersion}`);
    }
  }
  // A handle is mutable, so the current verified handle cannot authenticate the
  // scope stored in a historical release. The DID and record key are stable:
  // bind both package-name claims to that key while still requiring the claims
  // to agree exactly with each other above.
  for (const [label, packageName] of [
    ["record meta.name", entry.declaredName],
    ["package.json name", manifestName],
  ] as const) {
    if (packageName && !isHistoricalAtpmNameForRecord(packageName, args.recordName)) {
      mismatches.push(
        `${label} ${packageName} is not published under record key "${args.recordName}"`,
      );
    }
  }
  return mismatches;
}

/**
 * Historical metadata keeps the handle that was current when it was published,
 * so it must not be checked against today's resolved handle or public-host
 * policy. It must still be a syntactically scoped atpm package name whose only
 * path segment is the stable record key.
 */
function isHistoricalAtpmNameForRecord(packageName: string, recordName: string): boolean {
  if (!packageName.startsWith("@") || packageName.length > 512) return false;
  const slash = packageName.indexOf("/");
  if (slash <= 1 || slash !== packageName.lastIndexOf("/")) return false;
  if (packageName.slice(slash + 1) !== recordName) return false;

  const handle = packageName.slice(1, slash);
  if (handle.length < 3 || handle.length > 253 || handle !== handle.toLowerCase()) return false;
  const labels = handle.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    return false;
  }
  return /^[a-z]/.test(labels[labels.length - 1]);
}

function metadataMismatchFinding(mismatches: string[]): Finding[] {
  if (!mismatches.length) return [];
  return [
    {
      severity: "critical",
      file: "package.json",
      evidence: mismatches.join("; "),
      reason:
        "the metadata in this version's atpm record does not match the manifest inside its tarball, so what a client is told it is installing is not what would be installed",
      ruleId: DETERMINISTIC_RULE_IDS.stageMetadataMismatch,
      ruleVersion: DETERMINISTIC_RULES_VERSION,
    },
  ];
}

/**
 * Findings about how a release was built, rather than what is in it.
 *
 * Provenance is the one part of an atpm record that is not the publisher's word
 * for something: a Sigstore bundle is signed by an ephemeral key that Fulcio
 * issued to one GitHub Actions run, so it survives being copied into a record
 * the publisher controls. `./provenance.ts` has already checked each bundle
 * against the pinned Sigstore root; what is left is to bind that verified claim
 * to the bytes under review, to the publisher's own declaration of who may build
 * this package, and to what the previous release did.
 */
function provenanceFindings(args: {
  entry: AtpmVersion;
  archiveSha512: string | null;
  trustPublisher: AtpmTrustPublisher | null;
  baseline: AtpmVersion | null;
}): Finding[] {
  const { entry, trustPublisher, baseline } = args;
  const state = entry.provenance;
  const findings: Finding[] = [];

  if (state.status === "invalid") {
    findings.push({
      severity: "high",
      file: "package.json",
      evidence: `attestation on version ${entry.version} did not verify: ${state.reason}`,
      reason:
        "this version carries a build attestation that does not verify against Sigstore's root, so it proves nothing about where the release came from: a release that ships an unverifiable attestation is claiming provenance it cannot support",
      ruleId: DETERMINISTIC_RULE_IDS.atpmProvenanceInvalid,
      ruleVersion: DETERMINISTIC_RULES_VERSION,
    });
  }

  if (state.status === "verified") {
    findings.push(...subjectBindingFindings(entry, state.provenance, args.archiveSha512));
    findings.push(...publisherMatchFindings(entry, state.provenance, trustPublisher));
  } else if (trustPublisher?.github && state.status === "absent") {
    findings.push({
      severity: "low",
      file: "package.json",
      evidence: `no attestation on version ${entry.version}; the package declares trusted publishing from ${trustPublisher.github.username}/${trustPublisher.github.repository}`,
      reason:
        "this package declares a trusted publishing workflow, but this version carries no build attestation, so it cannot be shown to have come from that workflow rather than from someone's machine",
      ruleId: DETERMINISTIC_RULE_IDS.atpmProvenanceMissing,
      ruleVersion: DETERMINISTIC_RULES_VERSION,
    });
  }

  const lost = lostProvenanceEvidence(state, baseline);
  if (lost) {
    findings.push({
      severity: "medium",
      file: "package.json",
      evidence: lost,
      reason:
        "the previous release proved which repository built it and this one does not prove the same thing, so a property this package's consumers could previously rely on is no longer available for this version",
      ruleId: DETERMINISTIC_RULE_IDS.atpmTrustedPublishingLost,
      ruleVersion: DETERMINISTIC_RULES_VERSION,
    });
  }

  return findings;
}

/**
 * Bind a verified attestation to the artifact actually reviewed.
 *
 * A bundle is valid on its own terms no matter which record it is pasted into,
 * so this is what stops one package's real attestation from being presented as
 * another's. The digest half fails to silence rather than to "mismatch" when the
 * sandbox did not see every byte, matching how `dist.shasum` is handled above.
 */
function subjectBindingFindings(
  entry: AtpmVersion,
  provenance: AtpmProvenance,
  archiveSha512: string | null,
): Finding[] {
  const mismatches: string[] = [];
  if (entry.declaredName) {
    const expected = atpmPurl(entry.declaredName, entry.version);
    if (provenance.subjectName !== expected) {
      mismatches.push(`attested subject ${provenance.subjectName} != ${expected}`);
    }
  }
  if (archiveSha512 && provenance.subjectSha512 !== archiveSha512.toLowerCase()) {
    mismatches.push(
      `attested sha512 ${provenance.subjectSha512} != tarball sha512 ${archiveSha512.toLowerCase()}`,
    );
  }
  if (!mismatches.length) return [];
  return [
    {
      severity: "critical",
      file: "package.json",
      evidence: mismatches.join("; "),
      reason:
        "the build attestation on this version is valid but describes a different artifact, so it was copied here rather than produced for these bytes: the provenance shown for this release does not belong to it",
      ruleId: DETERMINISTIC_RULE_IDS.atpmProvenanceSubjectMismatch,
      ruleVersion: DETERMINISTIC_RULES_VERSION,
    },
  ];
}

function publisherMatchFindings(
  entry: AtpmVersion,
  provenance: AtpmProvenance,
  trustPublisher: AtpmTrustPublisher | null,
): Finding[] {
  if (!trustPublisher) return [];
  const match = matchTrustedPublisher(provenance, trustPublisher);
  // A declaration naming a provider this deployment cannot evaluate is not a
  // disagreement; reporting one would be inventing evidence.
  if (match.status === "match" || match.status === "unknown-provider") return [];
  const subject = match.status === "repository-mismatch" ? "repository" : "workflow";
  return [
    {
      severity: "high",
      file: "package.json",
      evidence: `version ${entry.version} was built by ${subject} ${match.actual}; the package's trusted publisher declares ${match.expected}`,
      reason:
        "this release was built somewhere other than the workflow its own publisher declared as trusted, so either the declaration is stale or the release did not come from the pipeline consumers were told to expect",
      ruleId: DETERMINISTIC_RULE_IDS.atpmProvenancePublisherMismatch,
      ruleVersion: DETERMINISTIC_RULES_VERSION,
    },
  ];
}

/**
 * Describe provenance the baseline had and the target does not, or null when
 * nothing was lost.
 *
 * `not-evaluated` on either side is silence, not a loss: it means the per-record
 * verification budget was spent elsewhere, and reporting that as a regression
 * would turn an internal limit into a finding about the package.
 */
function lostProvenanceEvidence(
  state: AtpmProvenanceState,
  baseline: AtpmVersion | null,
): string | null {
  const previous = baseline?.provenance;
  if (previous?.status !== "verified") return null;
  const from = previous.provenance.sourceRepository;
  if (state.status === "absent") {
    return `previous version was built by ${from}; this version carries no attestation`;
  }
  if (state.status === "invalid") {
    return `previous version was built by ${from}; this version's attestation does not verify`;
  }
  if (state.status === "verified" && state.provenance.sourceRepository !== from) {
    return `previous version was built by ${from}; this version was built by ${state.provenance.sourceRepository}`;
  }
  return null;
}

/**
 * Findings for a staged candidate — a release that has been uploaded to the
 * publisher's repository but not yet approved into the package record.
 *
 * The checks are the published ones asked one step earlier, which is the point
 * of reviewing here at all: a candidate whose record and tarball already
 * disagree would publish that disagreement unchanged, and a candidate whose
 * attestation does not verify would carry the same unverifiable claim into the
 * release. There is no baseline provenance comparison, because nothing has been
 * replaced yet.
 *
 * One check exists only in this direction. atpm requires a candidate's scope to
 * be the publishing account's *current* handle, so unlike a historical release
 * the scope can and must be compared against the handle this resolution proved.
 */
export function atpmStagedFindings(args: {
  staged: Pick<AtpmStagedVersion, "declaredName" | "version" | "declaredVersion" | "provenance"> & {
    shasum?: string | null;
  };
  manifest: PackageJsonSummary | null;
  archiveSha1: string | null;
  archiveSha512: string | null;
  trustPublisher: AtpmTrustPublisher | null;
  /** The handle this resolution proved in both directions, or null. */
  verifiedHandle: string | null;
}): Finding[] {
  const { staged } = args;
  const entry: AtpmVersion = {
    version: staged.version,
    cid: "",
    size: null,
    mimeType: null,
    createdAt: null,
    declaredName: staged.declaredName,
    declaredVersion: staged.declaredVersion,
    declaredShasum: staged.shasum ?? null,
    declaredTarball: null,
    declaredIntegrity: null,
    provenance: staged.provenance,
  };

  return [
    ...digestFindings(entry, args.archiveSha1),
    ...metadataMismatchFinding(stagedMismatches(args)),
    ...provenanceFindings({
      entry,
      archiveSha512: args.archiveSha512,
      trustPublisher: args.trustPublisher,
      baseline: null,
    }),
  ];
}

function stagedMismatches(args: {
  staged: Pick<AtpmStagedVersion, "declaredName" | "version" | "declaredVersion">;
  manifest: PackageJsonSummary | null;
  verifiedHandle: string | null;
}): string[] {
  const { staged, manifest } = args;
  const mismatches: string[] = [];
  if (!manifest) return ["tarball has no readable package.json"];

  const rawManifest = manifest as Record<string, unknown>;
  const manifestName =
    typeof rawManifest.name === "string" && rawManifest.name ? rawManifest.name : null;
  const manifestVersion =
    typeof rawManifest.version === "string" && rawManifest.version ? rawManifest.version : null;
  if (!manifestName) mismatches.push("tarball package.json has no readable name");
  if (!manifestVersion) mismatches.push("tarball package.json has no readable version");

  if (manifestName && staged.declaredName !== manifestName) {
    mismatches.push(`staged name ${staged.declaredName} != package.json name ${manifestName}`);
  }
  for (const [label, declared] of [
    ["version", staged.version],
    ["meta.version", staged.declaredVersion],
  ] as const) {
    if (declared && manifestVersion && declared !== manifestVersion) {
      mismatches.push(`staged ${label} ${declared} != package.json version ${manifestVersion}`);
    }
  }

  const scope = scopeOf(staged.declaredName);
  if (!scope) {
    mismatches.push(`staged name ${staged.declaredName} is not a scoped atpm package name`);
  } else if (args.verifiedHandle && scope !== args.verifiedHandle) {
    // atpm's own stage endpoint rejects a scope that is not the publishing
    // account's handle, so a candidate that carries someone else's scope could
    // not have been staged through it.
    mismatches.push(`staged scope @${scope} is not the publisher's handle @${args.verifiedHandle}`);
  }
  return mismatches;
}

function scopeOf(packageName: string): string | null {
  if (!packageName.startsWith("@")) return null;
  const slash = packageName.indexOf("/");
  if (slash <= 1 || slash !== packageName.lastIndexOf("/")) return null;
  return packageName.slice(1, slash);
}
