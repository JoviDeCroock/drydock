import {
  DETERMINISTIC_RULE_IDS,
  DETERMINISTIC_RULES_VERSION,
  deterministicFindings,
  packageJsonDiffFindings,
  tarSuspiciousEntryFindings,
  type DiffEntry,
  type Finding,
  type PackageJsonDiff,
  type PackageJsonSummary,
} from "../../review";
import type { NpmStagedDetails } from "./staged-publishes";
import type { AcquiredArtifact } from "../package-adapter";

export function buildNpmFindings(args: {
  staged: AcquiredArtifact;
  details: NpmStagedDetails | null;
  fileDiff: DiffEntry[];
  manifestDiff: PackageJsonDiff;
  stagedManifestText: string | null;
}): Finding[] {
  return [
    ...deterministicFindings(args.staged.files, args.fileDiff, args.staged.manifest, {
      entrypointResolution: "npm",
    }),
    ...packageJsonDiffFindings(args.manifestDiff, args.stagedManifestText),
    ...createStagedMetadataFindings(args.details, args.staged.manifest),
    ...tarSuspiciousEntryFindings(args.staged.suspiciousTarEntries, {
      fileDiff: args.fileDiff,
    }),
  ];
}

function createStagedMetadataFindings(
  details: NpmStagedDetails | null,
  pkg: PackageJsonSummary | null,
): Finding[] {
  if (!details) return [];
  return [...artifactDigestFindings(details), ...manifestMismatchFindings(details, pkg)];
}

// The staged tarball's bytes did not hash to the digest npm recorded for the
// stage. Everything downstream — the file list, the diff, every file-scoped
// finding — describes bytes that are not the staged release, so this is a
// review-integrity failure rather than a package-content finding. Only a
// two-sided comparison reaches here; an unverifiable digest stays silent and
// is disclosed through the report's staged-publish block instead.
function artifactDigestFindings(details: NpmStagedDetails): Finding[] {
  const integrity = details.artifactIntegrity;
  if (integrity?.status !== "mismatch") return [];
  return [
    {
      severity: "critical",
      file: "package.json",
      evidence: `staged tarball ${integrity.algorithm} ${integrity.computed} != npm-recorded shasum ${integrity.declared}`,
      reason:
        "the staged tarball Drydock downloaded does not hash to the digest npm recorded for this stage, so the reviewed bytes are not the staged release: treat every file, diff entry, and finding in this report as describing a different artifact and re-run the scan before deciding",
      ruleId: DETERMINISTIC_RULE_IDS.stageTarballDigestMismatch,
      ruleVersion: DETERMINISTIC_RULES_VERSION,
    },
  ];
}

function manifestMismatchFindings(
  details: NpmStagedDetails,
  pkg: PackageJsonSummary | null,
): Finding[] {
  if (!pkg) return [];
  const mismatches: string[] = [];
  if (details.packageName && pkg.name && details.packageName !== pkg.name) {
    mismatches.push(`packageName ${details.packageName} != package.json name ${pkg.name}`);
  }
  if (details.version && pkg.version && details.version !== pkg.version) {
    mismatches.push(`version ${details.version} != package.json version ${pkg.version}`);
  }
  if (!mismatches.length) return [];
  return [
    {
      severity: "critical",
      file: "package.json",
      evidence: mismatches.join("; "),
      reason:
        "npm staged metadata does not match the staged tarball package.json, so the release target cannot be trusted",
      ruleId: DETERMINISTIC_RULE_IDS.stageMetadataMismatch,
      ruleVersion: DETERMINISTIC_RULES_VERSION,
    },
  ];
}

export function mergeStagedPackageJson(
  tarballPackageJson: PackageJsonSummary | null,
  stagedMetadataPackageJson: PackageJsonSummary | null,
): PackageJsonSummary | null {
  if (!tarballPackageJson && !stagedMetadataPackageJson) return null;
  const scripts = mergeRecord(tarballPackageJson?.scripts, stagedMetadataPackageJson?.scripts);
  const implicitScripts = mergeRecord(
    tarballPackageJson?.implicitScripts,
    stagedMetadataPackageJson?.implicitScripts,
  );
  const peerDependenciesMeta = {
    ...tarballPackageJson?.peerDependenciesMeta,
    ...stagedMetadataPackageJson?.peerDependenciesMeta,
  };
  if (
    stagedMetadataPackageJson?.scripts?.install === "node-gyp rebuild" &&
    stagedMetadataPackageJson.gypfile === true &&
    !tarballPackageJson?.scripts?.install &&
    !tarballPackageJson?.scripts?.preinstall
  ) {
    implicitScripts.install = "node-gyp rebuild";
  }

  return {
    name: tarballPackageJson?.name ?? stagedMetadataPackageJson?.name,
    version: tarballPackageJson?.version ?? stagedMetadataPackageJson?.version,
    ...(Object.keys(scripts).length ? { scripts } : {}),
    ...(Object.keys(implicitScripts).length ? { implicitScripts } : {}),
    ...(typeof (stagedMetadataPackageJson?.gypfile ?? tarballPackageJson?.gypfile) === "boolean"
      ? { gypfile: stagedMetadataPackageJson?.gypfile ?? tarballPackageJson?.gypfile }
      : {}),
    ...optionalRecord(
      "dependencies",
      mergeRecord(tarballPackageJson?.dependencies, stagedMetadataPackageJson?.dependencies),
    ),
    ...optionalRecord(
      "devDependencies",
      mergeRecord(tarballPackageJson?.devDependencies, stagedMetadataPackageJson?.devDependencies),
    ),
    ...optionalRecord(
      "peerDependencies",
      mergeRecord(
        tarballPackageJson?.peerDependencies,
        stagedMetadataPackageJson?.peerDependencies,
      ),
    ),
    ...(Object.keys(peerDependenciesMeta).length ? { peerDependenciesMeta } : {}),
    ...optionalRecord(
      "optionalDependencies",
      mergeRecord(
        tarballPackageJson?.optionalDependencies,
        stagedMetadataPackageJson?.optionalDependencies,
      ),
    ),
    files: stagedMetadataPackageJson?.files ?? tarballPackageJson?.files,
    bin: stagedMetadataPackageJson?.bin ?? tarballPackageJson?.bin,
    main: stagedMetadataPackageJson?.main ?? tarballPackageJson?.main,
    module: stagedMetadataPackageJson?.module ?? tarballPackageJson?.module,
    types: stagedMetadataPackageJson?.types ?? tarballPackageJson?.types,
    browser: stagedMetadataPackageJson?.browser ?? tarballPackageJson?.browser,
    exports: stagedMetadataPackageJson?.exports ?? tarballPackageJson?.exports,
  };
}

function mergeRecord(
  before: Record<string, string> | undefined,
  after: Record<string, string> | undefined,
): Record<string, string> {
  return { ...before, ...after };
}

function optionalRecord(key: string, value: Record<string, string>): Record<string, unknown> {
  return Object.keys(value).length ? { [key]: value } : {};
}
