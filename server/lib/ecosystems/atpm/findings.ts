import type { AtpmVersion } from "./record";
import { evaluateStagedArtifactIntegrity } from "../artifact-integrity";
import {
  DETERMINISTIC_RULE_IDS,
  DETERMINISTIC_RULES_VERSION,
  type Finding,
  type PackageJsonSummary,
} from "../../review";

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
  /** Full package name proven by handle verification, when one is available. */
  expectedPackageName: string | null;
}): Finding[] {
  return [...digestFindings(args.entry, args.archiveSha1), ...manifestFindings(args)];
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
  expectedPackageName: string | null;
}): Finding[] {
  const { entry, manifest } = args;
  if (!manifest) return [];
  const mismatches: string[] = [];
  if (entry.declaredName && manifest.name && entry.declaredName !== manifest.name) {
    mismatches.push(`record meta.name ${entry.declaredName} != package.json name ${manifest.name}`);
  }
  if (args.expectedPackageName) {
    if (entry.declaredName && entry.declaredName !== args.expectedPackageName) {
      mismatches.push(
        `record meta.name ${entry.declaredName} is not published as ${args.expectedPackageName}`,
      );
    }
    if (manifest.name && manifest.name !== args.expectedPackageName) {
      mismatches.push(
        `package.json name ${manifest.name} is not published as ${args.expectedPackageName}`,
      );
    }
  }
  // `entry.version` is the key a client resolves a release by; `meta.version` is
  // what that same client is handed as the manifest. Both must agree with the
  // tarball or the version a lockfile pins is not the version that installs.
  for (const [label, declared] of [
    ["version", entry.version],
    ["meta.version", entry.declaredVersion],
  ] as const) {
    if (declared && manifest.version && declared !== manifest.version) {
      mismatches.push(`record ${label} ${declared} != package.json version ${manifest.version}`);
    }
  }
  // A DID-only lookup has no verified handle to supply the full npm scope. It
  // can still bind the unscoped half to the record key. Handle-addressed and
  // reverse-verified lookups take the stronger full-name branch above.
  if (!args.expectedPackageName) {
    const unscoped = manifest.name?.includes("/")
      ? manifest.name.slice(manifest.name.lastIndexOf("/") + 1)
      : manifest.name;
    if (unscoped && unscoped !== args.recordName) {
      mismatches.push(
        `package.json name ${manifest.name} is not published as "${args.recordName}"`,
      );
    }
  }
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
