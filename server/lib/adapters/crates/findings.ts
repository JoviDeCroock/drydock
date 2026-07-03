import { type FileRecord, type Finding, tarSuspiciousEntryFindings } from "../../review";
import { parseCargoManifest } from "./manifest";
import {
  CRATES_RULE_IDS,
  CRATES_RULES_VERSION,
  type CratesArtifactSummary,
  type CratesManifestSummary,
  type CratesPreparedArtifact,
  type CratesReleaseManifest,
} from "./types";

export function summarizeCratesArtifact(
  artifactPath: string,
  files: FileRecord[],
): CratesArtifactSummary {
  const manifestFile = files.find((file) => file.path === "Cargo.toml");
  const manifest: CratesManifestSummary = manifestFile?.textSample
    ? parseCargoManifest(manifestFile.textSample)
    : {
        name: null,
        version: null,
        links: null,
        buildValue: null,
        procMacro: false,
        nonRegistryDependencies: [],
      };
  return {
    path: artifactPath,
    kind: "crate",
    manifestPath: manifestFile?.path ?? null,
    manifest,
    buildScriptPath: effectiveBuildScriptPath(manifest, files),
  };
}

/**
 * The build script cargo would compile and run at consumer build time:
 * `build = false` disables it, a string names a custom path, and otherwise the
 * conventional root `build.rs` applies when present.
 */
export function effectiveBuildScriptPath(
  manifest: CratesManifestSummary,
  files: FileRecord[],
): string | null {
  if (manifest.buildValue === false) return null;
  if (typeof manifest.buildValue === "string") {
    return manifest.buildValue.replace(/^\.\//, "");
  }
  return files.some((file) => file.path === "build.rs") ? "build.rs" : null;
}

export function cratesReleaseFindings(
  manifest: CratesReleaseManifest,
  artifacts: CratesPreparedArtifact[],
  baselineFiles: FileRecord[] | null,
): Finding[] {
  const findings: Finding[] = [];
  const baselineSummary = baselineFiles ? summarizeCratesArtifact("baseline", baselineFiles) : null;

  for (const artifact of artifacts) {
    const { summary } = artifact;
    // Surface tar-parser evidence (oversized content-skipped bodies, non-regular
    // entries, duplicates, confusable paths) the sandbox recorded for this
    // artifact, so a crate whose oversized file was never inspected fails the
    // review instead of passing silently.
    findings.push(...tarSuspiciousEntryFindings(artifact.suspiciousEntries));

    const manifestEvidencePath = summary.manifestPath ?? "Cargo.toml";
    if (!summary.manifestPath || !summary.manifest.name || !summary.manifest.version) {
      findings.push(
        tag("metadataMissing", {
          severity: "medium",
          file: manifestEvidencePath,
          evidence: `${artifact.path} does not expose a complete Cargo.toml name/version`,
          reason:
            "release gates need crate name and version metadata to prove the artifact matches the reviewed manifest",
        }),
      );
    } else {
      if (summary.manifest.name !== manifest.package) {
        findings.push(
          tag("metadataMismatch", {
            severity: "critical",
            file: manifestEvidencePath,
            evidence: `${artifact.path} Cargo.toml name ${summary.manifest.name} != manifest package ${manifest.package}`,
            reason: "the release artifact crate name does not match the reviewed manifest",
          }),
        );
      }
      if (summary.manifest.version !== manifest.version) {
        findings.push(
          tag("metadataMismatch", {
            severity: "critical",
            file: manifestEvidencePath,
            evidence: `${artifact.path} Cargo.toml version ${summary.manifest.version} != manifest version ${manifest.version}`,
            reason: "the release artifact version does not match the reviewed manifest",
          }),
        );
      }
    }

    findings.push(...buildScriptFindings(artifact, baselineSummary, baselineFiles));

    if (summary.manifest.procMacro && !baselineSummary?.manifest.procMacro) {
      findings.push(
        tag("procMacroIntroduced", {
          severity: "high",
          file: manifestEvidencePath,
          evidence: baselineSummary
            ? "crate became a proc-macro (`[lib] proc-macro = true`) in this release"
            : "crate is a proc-macro (`[lib] proc-macro = true`)",
          reason:
            "proc-macro crates execute inside the compiler on every consumer build, a powerful code-execution surface",
        }),
      );
    }

    const links = summary.manifest.links;
    const baselineLinks = baselineSummary?.manifest.links ?? null;
    if (links !== baselineLinks && (links || baselineLinks) && baselineSummary) {
      findings.push(
        tag("linksChanged", {
          severity: "high",
          file: manifestEvidencePath,
          evidence: `Cargo.toml links changed: ${baselineLinks ?? "(none)"} -> ${links ?? "(none)"}`,
          reason:
            "the `links` key changes native-library linkage and build-script coordination for every consumer build",
        }),
      );
    }

    for (const dep of summary.manifest.nonRegistryDependencies) {
      const wasPresent = baselineSummary?.manifest.nonRegistryDependencies.some(
        (baselineDep) =>
          baselineDep.name === dep.name &&
          baselineDep.source === dep.source &&
          baselineDep.section === dep.section,
      );
      if (wasPresent) continue;
      findings.push(
        tag("nonRegistryDependency", {
          severity: "high",
          file: manifestEvidencePath,
          evidence: `[${dep.section}] ${dep.name} uses a ${dep.source} source`,
          reason:
            "git/path dependencies bypass the crates.io registry and pull unreviewed code from an arbitrary location",
        }),
      );
    }
  }

  return findings;
}

function buildScriptFindings(
  artifact: CratesPreparedArtifact,
  baselineSummary: CratesArtifactSummary | null,
  baselineFiles: FileRecord[] | null,
): Finding[] {
  const buildScriptPath = artifact.summary.buildScriptPath;
  if (!buildScriptPath) return [];

  if (!baselineSummary || !baselineSummary.buildScriptPath) {
    return [
      tag("buildScriptAdded", {
        severity: baselineSummary ? "high" : "medium",
        file: buildScriptPath,
        evidence: baselineSummary
          ? `${buildScriptPath} is new in this release`
          : `${buildScriptPath} runs at consumer build time`,
        reason:
          "cargo compiles and executes the build script on every consumer build, so it runs arbitrary code on consumer machines",
      }),
    ];
  }

  const staged = artifact.files.find((file) => file.path === buildScriptPath);
  const baseline = baselineFiles?.find((file) => file.path === baselineSummary.buildScriptPath);
  if (
    baselineSummary.buildScriptPath !== buildScriptPath ||
    (staged && baseline && staged.sha256 !== baseline.sha256)
  ) {
    return [
      tag("buildScriptChanged", {
        severity: "high",
        file: buildScriptPath,
        evidence:
          baselineSummary.buildScriptPath !== buildScriptPath
            ? `build script moved: ${baselineSummary.buildScriptPath} -> ${buildScriptPath}`
            : `${buildScriptPath} changed since the previous release`,
        reason:
          "build-script changes alter code that executes on every consumer build and are a common crates.io attack vector",
      }),
    ];
  }
  return [];
}

function tag(
  rule: keyof typeof CRATES_RULE_IDS,
  finding: Omit<Finding, "ruleId" | "ruleVersion">,
): Finding {
  return {
    ...finding,
    ruleId: CRATES_RULE_IDS[rule],
    ruleVersion: CRATES_RULES_VERSION,
  };
}
