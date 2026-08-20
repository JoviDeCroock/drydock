import type { AtpmVersion } from "./record";
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
  /** The record key this version was resolved under — the unscoped package name. */
  recordName: string;
}): Finding[] {
  return [...digestFindings(args.entry, args.archiveSha1), ...manifestFindings(args)];
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
