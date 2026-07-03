import {
  type FileRecord,
  type Finding,
  RUBY_EXECUTION_CAPABILITY_PATTERNS,
  tarSuspiciousEntryFindings,
} from "../../review";
import { firstMatchingLine } from "../../text-utils";
import { normalizeRubygemsGemName } from "./manifest";
import {
  RUBYGEMS_RULE_IDS,
  RUBYGEMS_RULES_VERSION,
  type RubygemsArtifactKind,
  type RubygemsArtifactSummary,
  type RubygemsPreparedArtifact,
  type RubygemsReleaseManifest,
} from "./types";

export const GEM_METADATA_PATH = "metadata.gz";

// Extension build/config entry points `gem install` executes on the consumer
// machine when a gem declares extensions (extconf.rb, mkrf, rake-based, cargo).
const EXTENSION_BUILD_FILE_RE = /(^|\/)(extconf\.rb|mkrf_conf[^/]*\.rb|Rakefile|Cargo\.toml)$/;

// Precompiled or shell content inside ext/ — an extension directory should hold
// build scripts and C/Rust sources, not shipped binaries or shell scripts.
const SUSPICIOUS_EXT_FILE_RE = /\.(sh|bash|so|o|a|dll|dylib|bundle|exe|bin)$/i;

const NATIVE_ARTIFACT_RE = /\.(so|dylib|dll|exe|bundle|node)$/i;

// Git/path dependency escapes in gemspec metadata. RubyGems.org rejects git
// sources in published gems, so their presence in metadata is itself anomalous.
const GIT_DEPENDENCY_RE = /!ruby\/object:Gem::Dependency[\s\S]{0,400}?\bgit:/;

export function rubygemsReleaseFindings(
  manifest: RubygemsReleaseManifest,
  artifacts: RubygemsPreparedArtifact[],
  baselineFiles?: FileRecord[] | null,
): Finding[] {
  const findings: Finding[] = [];
  const manifestName = normalizeRubygemsGemName(manifest.package);
  const baselines = baselineSummariesByPlatform(baselineFiles ?? []);

  for (const artifact of artifacts) {
    const { summary } = artifact;
    // Surface tar-parser evidence (oversized content-skipped bodies, non-regular
    // entries, duplicates, confusable paths) the sandbox recorded for this
    // artifact so the gate never drops evidence and passes an uninspected gem.
    for (const finding of tarSuspiciousEntryFindings(artifact.suspiciousEntries)) {
      findings.push({ ...finding, file: namespacedPath(artifact.path, finding.file) });
    }
    const metadataEvidencePath = namespacedPath(
      artifact.path,
      summary.metadataPath ?? GEM_METADATA_PATH,
    );
    if (!summary.metadataPath || !summary.name || !summary.version) {
      findings.push(
        tag("metadataMissing", {
          severity: "medium",
          file: metadataEvidencePath,
          evidence: `${artifact.path} does not expose a complete gemspec (name/version)`,
          reason:
            "release gates need gem name and version metadata to prove the artifact matches the reviewed manifest",
        }),
      );
    } else if (normalizeRubygemsGemName(summary.name) !== manifestName) {
      findings.push(
        tag("metadataMismatch", {
          severity: "critical",
          file: metadataEvidencePath,
          evidence: `${artifact.path} gemspec name ${summary.name} != manifest package ${manifest.package}`,
          reason: "the release artifact gem name does not match the reviewed RubyGems manifest",
        }),
      );
    }
    if (summary.version && summary.version !== manifest.version) {
      findings.push(
        tag("metadataMismatch", {
          severity: "critical",
          file: metadataEvidencePath,
          evidence: `${artifact.path} gemspec version ${summary.version} != manifest version ${manifest.version}`,
          reason: "the release artifact version does not match the reviewed RubyGems manifest",
        }),
      );
    }

    const baseline = baselines.get(diffPlatform(summary.platform));
    if (summary.extensions.length) {
      const baselineHadExtensions = Boolean(baseline?.extensions.length);
      findings.push(
        tag(baseline && !baselineHadExtensions ? "extensionAdded" : "extensionBuild", {
          severity: "high",
          file: metadataEvidencePath,
          evidence:
            baseline && !baselineHadExtensions
              ? `gemspec newly declares extensions: ${summary.extensions.join(", ")}`
              : `gemspec declares extensions: ${summary.extensions.join(", ")}`,
          reason:
            "gem install compiles declared extensions on the consumer machine, running the extension's build code at install time",
        }),
      );
    }
    if (baseline) {
      const previousExecutables = new Set(baseline.executables);
      const added = summary.executables.filter((name) => !previousExecutables.has(name));
      if (added.length) {
        findings.push(
          tag("executableAdded", {
            severity: "medium",
            file: metadataEvidencePath,
            evidence: `gemspec adds executables not in the previous release: ${added.join(", ")}`,
            reason:
              "new gem executables land on consumer PATHs and are a common vehicle for injected malicious entry points",
          }),
        );
      }
    }

    const metadataFile = artifact.files.find((file) => file.path === summary.metadataPath);
    if (metadataFile?.textSample && GIT_DEPENDENCY_RE.test(metadataFile.textSample)) {
      findings.push(
        tag("gitDependency", {
          severity: "high",
          file: metadataEvidencePath,
          evidence: "gemspec dependency declares a git source",
          reason:
            "git-sourced dependencies bypass the RubyGems registry and pull unreviewed code from an arbitrary location",
        }),
      );
    }
  }

  for (const artifact of artifacts) {
    const declaredExtensions = new Set(artifact.summary.extensions);
    for (const file of artifact.files) {
      const filePath = namespacedPath(artifact.path, file.path);
      const inExtDir = file.path.startsWith("ext/");
      if (
        (inExtDir || declaredExtensions.has(file.path)) &&
        EXTENSION_BUILD_FILE_RE.test(file.path)
      ) {
        const text = file.textSample ?? "";
        const matched = RUBY_EXECUTION_CAPABILITY_PATTERNS.some((pattern) => pattern.test(text));
        if (matched) {
          findings.push(
            tag("extensionInstallCode", {
              severity: "high",
              file: filePath,
              line: firstMatchingLine(text, RUBY_EXECUTION_CAPABILITY_PATTERNS),
              evidence: `${file.path} executes code during extension build`,
              reason:
                "gem install runs extension build files, so process, network, or dynamic-eval code there runs on the consumer machine",
            }),
          );
        }
      }
      if (inExtDir && SUSPICIOUS_EXT_FILE_RE.test(file.path)) {
        findings.push(
          tag("suspiciousExtensionFile", {
            severity: "high",
            file: filePath,
            evidence: `${file.path} is a shell script or precompiled binary inside ext/`,
            reason:
              "extension directories should carry build scripts and sources; shipped binaries or shell scripts there evade source-level review",
          }),
        );
      } else if (NATIVE_ARTIFACT_RE.test(file.path)) {
        findings.push(
          tag("nativeArtifact", {
            severity: "high",
            file: filePath,
            evidence: "packaged native binary artifact",
            reason:
              "native binaries are hard to audit and execute outside source-level policy checks",
          }),
        );
      }
    }
  }

  return findings;
}

export function summarizeRubygemsArtifact(
  artifactPath: string,
  kind: RubygemsArtifactKind,
  files: FileRecord[],
): RubygemsArtifactSummary {
  const metadataFile = files.find((file) => file.path === GEM_METADATA_PATH);
  const spec = metadataFile?.textSample ? parseGemspecYaml(metadataFile.textSample) : null;
  return {
    path: artifactPath,
    kind,
    metadataPath: metadataFile?.path ?? null,
    name: spec?.name ?? null,
    version: spec?.version ?? null,
    platform: spec?.platform ?? null,
    executables: spec?.executables ?? [],
    extensions: spec?.extensions ?? [],
    dependencies: spec?.dependencies ?? [],
  };
}

export interface GemspecSummary {
  name: string | null;
  version: string | null;
  platform: string | null;
  executables: string[];
  extensions: string[];
  dependencies: string[];
}

/**
 * Extract identity and risk-relevant fields from the gemspec YAML that
 * `gem build` serializes into `metadata.gz`.
 *
 * This is deliberately not a YAML engine: the document is treated as hostile
 * text and only the well-known scalar keys (`name`, `platform`), the nested
 * `version.version` scalar, and the string lists (`executables`, `extensions`)
 * plus dependency `name:` entries are read line-by-line. Anchors, aliases, and
 * arbitrary tags are never resolved, so a crafted document cannot trigger
 * expansion — at worst a field parses as absent and the gate fail-closes on the
 * missing-metadata finding.
 */
export function parseGemspecYaml(text: string): GemspecSummary {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const summary: GemspecSummary = {
    name: null,
    version: null,
    platform: null,
    executables: [],
    extensions: [],
    dependencies: [],
  };
  let section: "version" | "executables" | "extensions" | "dependencies" | null = null;

  for (const line of lines) {
    if (line.startsWith("---")) continue;
    const topLevel = /^(\w+):\s*(.*)$/.exec(line);
    if (topLevel) {
      const [, key, rawValue] = topLevel;
      const value = parseScalar(rawValue);
      section = null;
      if (key === "name" && value) summary.name = value;
      else if (key === "platform" && value) summary.platform = value;
      else if (key === "version") {
        if (value && !rawValue.startsWith("!")) summary.version = value;
        else section = "version";
      } else if (key === "executables") section = "executables";
      else if (key === "extensions") section = "extensions";
      else if (key === "dependencies") section = "dependencies";
      continue;
    }
    if (!section) continue;
    if (section === "version") {
      const nested = /^\s+version:\s*(.+)$/.exec(line);
      if (nested) {
        summary.version = parseScalar(nested[1]);
        section = null;
      }
      continue;
    }
    if (section === "dependencies") {
      const depName = /^\s+name:\s*(.+)$/.exec(line);
      const value = depName ? parseScalar(depName[1]) : null;
      if (value) summary.dependencies.push(value);
      continue;
    }
    const item = /^-\s+(.+)$/.exec(line);
    const value = item ? parseScalar(item[1]) : null;
    if (value) summary[section].push(value);
  }
  return summary;
}

function parseScalar(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("!") || trimmed.startsWith("&") || trimmed.startsWith("*")) {
    return null;
  }
  const quoted = /^(['"])(.*)\1$/.exec(trimmed);
  return quoted ? quoted[2] : trimmed;
}

export function namespacedPath(artifactPath: string, filePath: string): string {
  return `${artifactPath.replace(/\/+$/, "")}/${filePath.replace(/^\/+/, "")}`;
}

export function diffPlatform(platform: string | null): string {
  return (platform || "ruby").replace(/[^A-Za-z0-9._-]+/g, "_");
}

export function rubygemsDiffNamespace(platform: string | null): string {
  return `gem/${diffPlatform(platform)}`;
}

// Re-derive per-platform gemspec summaries from flattened (namespaced) baseline
// files so gemspec-drift rules can compare against the previous release without
// carrying baseline details through the shared pipeline.
function baselineSummariesByPlatform(files: FileRecord[]): Map<string, GemspecSummary> {
  const summaries = new Map<string, GemspecSummary>();
  for (const file of files) {
    const match = /^gem\/([^/]+)\/metadata\.gz$/.exec(file.path);
    if (!match || !file.textSample) continue;
    summaries.set(match[1], parseGemspecYaml(file.textSample));
  }
  return summaries;
}

function tag(
  rule: keyof typeof RUBYGEMS_RULE_IDS,
  finding: Omit<Finding, "ruleId" | "ruleVersion">,
): Finding {
  return {
    ...finding,
    ruleId: RUBYGEMS_RULE_IDS[rule],
    ruleVersion: RUBYGEMS_RULES_VERSION,
  };
}
