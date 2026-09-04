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
import {
  isTrustedAutomationActor,
  normalizeRepository,
  PUBLISHER_FINDING_FILE,
  type NpmStagePublisher,
  type NpmTrustConfig,
} from "./publisher-identity";

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
  return [
    ...artifactDigestFindings(details),
    ...manifestMismatchFindings(details, pkg),
    ...npmPublisherFindings(details.publisher),
  ];
}

/**
 * Config-hygiene and publishing-path findings over the stage's publisher
 * block. Every rule needs positive evidence on both sides of its comparison:
 * an unknown actor type, an unreadable config list, or a previous version
 * without provenance is absence of evidence and raises nothing. Never above
 * medium — these describe how the release arrived, not what it contains.
 */
export function npmPublisherFindings(publisher: NpmStagePublisher | null | undefined): Finding[] {
  if (!publisher) return [];
  const configs = publisher.trustConfigsState === "checked" ? (publisher.trustConfigs ?? []) : [];
  const findings: Finding[] = [];
  const previousRepository = normalizeRepository(publisher.previousBuild?.repository ?? null);

  for (const config of configs) {
    const label = describeTrustConfig(config);
    if (config.directPublish) {
      findings.push(
        publisherFinding("publisherDirectPublishAllowed", "low", label, {
          reason:
            "this trusted-publisher config may run `npm publish` directly (createPackage), so the workflow it names can make a release public without staging it for review; npm creates configs stage-only by default and direct publish is a per-config opt-in",
        }),
      );
    }
    if (!config.environment && (config.provider === "github" || config.provider === "gitlab")) {
      findings.push(
        publisherFinding("publisherNoEnvironment", "low", label, {
          reason:
            "this trusted-publisher config pins no CI environment, so any job running the named workflow file can exchange its OIDC token for a publish credential without an environment's protection rules or reviewers",
        }),
      );
    }
    const configRepository = normalizeRepository(config.repository);
    if (previousRepository && configRepository && configRepository !== previousRepository) {
      findings.push(
        publisherFinding("publisherConfigOutsideProvenance", "low", label, {
          reason: `the previous version's provenance was built from ${previousRepository}, so this config grants a publishing path from a repository that did not build the last release`,
        }),
      );
    }
  }

  const actorType = publisher.actorType;
  const actorKnown = typeof actorType === "string" && actorType.length > 0;
  const actorLabel = `${publisher.actor ?? "unknown actor"} (${actorType ?? "unknown actor type"})`;
  if (configs.length > 0 && actorKnown && !isTrustedAutomationActor(actorType)) {
    findings.push(
      publisherFinding(
        "publisherActorNotTrusted",
        "medium",
        `staged by ${actorLabel}; ${configs.length} trusted-publisher config${configs.length === 1 ? "" : "s"}: ${configs.map(describeTrustConfig).join("; ")}`,
        {
          reason:
            "the package has trusted publishing configured but this stage was not created through it: the bytes came from an account or token rather than the pinned CI workflow, which is the shape of a stolen-credential publish",
        },
      ),
    );
  }

  if (publisher.previousBuild && actorKnown && !isTrustedAutomationActor(actorType)) {
    const previous = publisher.previousBuild;
    const built = [previous.repository, previous.workflowPath].filter(Boolean).join(" ");
    findings.push(
      publisherFinding(
        "publisherProvenancePathChanged",
        "medium",
        `previous version built by ${built || previous.builderId || "an attested workflow"}; this stage was created by ${actorLabel}`,
        {
          reason:
            "the previous version carried build provenance from CI, but this stage was created by a non-trusted-automation actor, so the release left its attested publishing path; confirm with the maintainer before approving",
        },
      ),
    );
  }

  return findings;
}

function describeTrustConfig(config: NpmTrustConfig): string {
  const parts = [config.provider ?? "unknown provider", config.repository ?? "unknown repository"];
  if (config.workflowFile) parts.push(config.workflowFile);
  parts.push(config.environment ? `environment ${config.environment}` : "no environment");
  parts.push(
    config.directPublish && config.stagePublish
      ? "publish + stage"
      : config.directPublish
        ? "publish"
        : config.stagePublish
          ? "stage-only"
          : "no permissions",
  );
  return parts.join(" · ");
}

function publisherFinding(
  rule:
    | "publisherDirectPublishAllowed"
    | "publisherNoEnvironment"
    | "publisherActorNotTrusted"
    | "publisherConfigOutsideProvenance"
    | "publisherProvenancePathChanged",
  severity: "low" | "medium",
  evidence: string,
  detail: { reason: string },
): Finding {
  return {
    severity,
    file: PUBLISHER_FINDING_FILE,
    evidence,
    reason: detail.reason,
    ruleId: DETERMINISTIC_RULE_IDS[rule],
    ruleVersion: DETERMINISTIC_RULES_VERSION,
  };
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
