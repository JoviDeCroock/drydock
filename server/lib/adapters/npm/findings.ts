import {
  DETERMINISTIC_RULE_IDS,
  DETERMINISTIC_RULES_VERSION,
  deterministicFindings,
  packageJsonDiffFindings,
  type Finding,
  type PackageJsonDiff,
  type PackageJsonSummary,
} from "../../review";
import type { StagedPublishDetails } from "../../staged-publishes";
import type { AcquiredArtifact } from "../types";

export function buildNpmFindings(args: {
  staged: AcquiredArtifact;
  details: StagedPublishDetails | null;
  manifestDiff: PackageJsonDiff;
  stagedManifestText: string | null;
}): Finding[] {
  return [
    ...deterministicFindings(args.staged.files, [], args.staged.manifest),
    ...packageJsonDiffFindings(args.manifestDiff, args.stagedManifestText),
    ...createStagedMetadataFindings(args.details, args.staged.manifest),
  ];
}

export function createStagedMetadataFindings(
  details: StagedPublishDetails | null,
  pkg: PackageJsonSummary | null,
): Finding[] {
  if (!details || !pkg) return [];
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
