import { type Finding, RUBY_EXECUTION_CAPABILITY_PATTERNS } from "../../review";
import { firstMatchingLine } from "../../text-utils";
import { normalizeGemName } from "./manifest";
import {
  RUBYGEMS_RULE_IDS,
  RUBYGEMS_RULES_VERSION,
  type RubyGemsPreparedArtifact,
  type RubyGemsReleaseManifest,
} from "./types";

// `gem push` honours a gemspec's `allowed_push_host`; for a gate that exists to
// review rubygems.org releases, any other host is worth surfacing.
const EXPECTED_PUSH_HOST = "https://rubygems.org";

export function rubyGemsReleaseFindings(
  manifest: RubyGemsReleaseManifest,
  artifacts: RubyGemsPreparedArtifact[],
): Finding[] {
  const findings: Finding[] = [];
  const manifestName = normalizeGemName(manifest.package);

  for (const artifact of artifacts) {
    const { summary } = artifact;
    const specEvidence = `${artifact.path} (gemspec)`;

    if (!summary.hasGemspec || !summary.name || !summary.version) {
      findings.push(
        tag("metadataMissing", {
          severity: "medium",
          file: specEvidence,
          evidence: `${artifact.path} does not expose a complete Gem::Specification (name/version)`,
          reason:
            "release gates need the gem name and version from metadata.gz to prove the artifact matches the reviewed manifest",
        }),
      );
    } else {
      if (normalizeGemName(summary.name) !== manifestName) {
        findings.push(
          tag("metadataMismatch", {
            severity: "critical",
            file: specEvidence,
            evidence: `${artifact.path} gemspec name ${summary.name} != manifest package ${manifest.package}`,
            reason: "the release artifact gem name does not match the reviewed manifest",
          }),
        );
      }
      if (summary.version !== manifest.version) {
        findings.push(
          tag("metadataMismatch", {
            severity: "critical",
            file: specEvidence,
            evidence: `${artifact.path} gemspec version ${summary.version} != manifest version ${manifest.version}`,
            reason: "the release artifact gem version does not match the reviewed manifest",
          }),
        );
      }
    }

    if (summary.extensions.length) {
      findings.push(
        tag("nativeExtension", {
          severity: "medium",
          file: namespacedPath(artifact.path, summary.extensions[0]),
          evidence: `gemspec declares native extensions: ${summary.extensions.join(", ")}`,
          reason:
            "a gem with native extensions runs its build scripts (extconf.rb/Rakefile/Makefile) during `gem install`, executing code on the consumer machine",
        }),
      );
    }

    // RubyGems executes every path declared in `extensions`; most gems use an
    // `ext/` extconf.rb, but configure scripts and root-level build files are
    // equally install-time code when the gemspec lists them.
    const extensionPaths = new Set(summary.extensions.map(normalizeExtensionPath));
    for (const file of artifact.files) {
      if (!extensionPaths.has(normalizeExtensionPath(file.path))) continue;
      const sample = file.textSample ?? "";
      if (RUBY_EXECUTION_CAPABILITY_PATTERNS.some((pattern) => pattern.test(sample))) {
        findings.push(
          tag("extensionBuildHook", {
            severity: "high",
            file: namespacedPath(artifact.path, file.path),
            line: firstMatchingLine(sample, RUBY_EXECUTION_CAPABILITY_PATTERNS),
            evidence: `${file.path.split("/").at(-1)} runs process/network/eval code at gem-install time`,
            reason:
              "`gem install` runs a native extension's build script, so process, network, or dynamic-eval code there executes on the consumer machine",
          }),
        );
      }
    }

    const pushHost = summary.metadata.allowed_push_host;
    if (pushHost && pushHost !== EXPECTED_PUSH_HOST) {
      findings.push(
        tag("unexpectedPushHost", {
          severity: "low",
          file: specEvidence,
          evidence: `gemspec metadata.allowed_push_host is ${pushHost}`,
          reason:
            "the gem restricts pushes to a host other than rubygems.org; confirm the release is meant for this registry",
        }),
      );
    }
  }

  return findings;
}

export function namespacedPath(artifactPath: string, filePath: string): string {
  return `${artifactPath.replace(/\/+$/, "")}/${filePath.replace(/^\/+/, "")}`;
}

function normalizeExtensionPath(path: string): string {
  return path.replace(/^\.\//, "").replace(/^\/+/, "");
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
