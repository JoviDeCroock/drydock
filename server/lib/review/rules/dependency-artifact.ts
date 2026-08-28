import type { DependencyEvidence, FileRecord, Finding, PackageJsonSummary } from "..";
import {
  dependencyDeclarationKey,
  MAX_RECORDED_DEPENDENCIES,
  type AddedDependencyDeclaration,
} from "../dependency-evidence";
import { deterministicFindings } from ".";
import { DETERMINISTIC_RULES_VERSION } from ".";
import { tag } from "./helpers";

export type DependencyArtifactForReview = DependencyEvidence & {
  files: FileRecord[];
  packageJson: PackageJsonSummary | null;
};

const AUTO_EXECUTION_RULES = new Set([
  "install-script.preinstall",
  "install-script.lifecycle",
  "install-script.implicit-node-gyp",
  "install-script.gyp-command-substitution",
]);

const CAPABILITY_RULES = new Set([
  "code.remote-shell",
  "code.network-access",
  "code.credential-access",
  "code.dynamic-evaluation",
]);

const DROPPED_RULES = new Set(["file.outside-files-list", "package-json.entrypoint-missing"]);

export function dependencyScanFindings(
  dependencies: AddedDependencyDeclaration[],
  artifacts: Record<string, DependencyArtifactForReview>,
  parent: { name: string | null; version: string | null },
  omittedCount = 0,
): Finding[] {
  const findings: Finding[] = [];
  for (const dependency of dependencies) {
    const evidence =
      artifacts[
        dependencyDeclarationKey(dependency.name, dependency.section, dependency.declaredSpec)
      ];
    if (!evidence || evidence.outcome !== "inspected" || !evidence.packageJson) {
      findings.push(unavailableFinding(dependency, evidence, parent));
      continue;
    }

    const raw = deterministicFindings(evidence.files, [], evidence.packageJson, {
      entrypointResolution: "npm",
    }).filter((finding) => !DROPPED_RULES.has(finding.ruleId ?? ""));
    const trigger = raw.find((finding) => AUTO_EXECUTION_RULES.has(finding.ruleId ?? ""));
    const capabilities = raw.filter(
      (finding) =>
        !finding.testScoped &&
        (CAPABILITY_RULES.has(finding.ruleId ?? "") ||
          (finding.ruleId === "code.process-execution" && finding.obfuscated)),
    );
    const version = evidence.resolution?.version ?? null;
    const path = evidence.path || dependencyPath(parent, dependency.name, version);

    findings.push(...raw.map((finding) => namespaceFinding(finding, dependency, version, path)));
    if (trigger && capabilities.length) {
      findings.push(installTimeCapabilityFinding(dependency, version, path, trigger, capabilities));
    }
  }
  if (omittedCount > 0) findings.push(omittedDependenciesFinding(omittedCount));
  return findings;
}

function namespaceFinding(
  finding: Finding,
  dependency: AddedDependencyDeclaration,
  version: string | null,
  path: string,
): Finding {
  const { name, section, declaredSpec } = dependency;
  return {
    ...finding,
    severity:
      finding.ruleId === "file.secret-content" || severityRank(finding.severity) <= 2
        ? finding.severity
        : "medium",
    file: `dependency/${name}@${version ?? "unresolved"}/${finding.file}`,
    dependency: { name, version, path, section, declaredSpec },
  };
}

function installTimeCapabilityFinding(
  dependency: AddedDependencyDeclaration,
  version: string | null,
  path: string,
  trigger: Finding,
  capabilities: Finding[],
): Finding {
  const { name, section, declaredSpec } = dependency;
  const ids = new Set(capabilities.map((finding) => finding.ruleId));
  const obfuscated = capabilities.some((finding) => finding.obfuscated);
  const critical =
    ids.has("code.remote-shell") ||
    (ids.has("code.credential-access") && ids.has("code.network-access")) ||
    obfuscated;
  const capability = capabilities[0];
  return {
    ...tag("dependencyInstallTimeCapability", {
      severity: critical ? "critical" : "high",
      file: `dependency/${name}@${version ?? "unresolved"}/package.json`,
      evidence: `${path} → ${trigger.file}${trigger.line ? `:${trigger.line}` : ""} → ${capability.ruleId} (${capability.evidence})`,
      reason:
        "this release adds a dependency whose automatic install path carries downloader, credential, process, or dynamic-evaluation behavior; every consumer install inherits that path",
      dependency: { name, version, path, section, declaredSpec },
    }),
    ruleVersion: DETERMINISTIC_RULES_VERSION,
  };
}

function unavailableFinding(
  dependency: AddedDependencyDeclaration,
  evidence: DependencyArtifactForReview | undefined,
  parent: { name: string | null; version: string | null },
): Finding {
  const version = evidence?.resolution?.version ?? null;
  const path = evidence?.path || dependencyPath(parent, dependency.name, version);
  const outcome = evidence?.outcome ?? "fetch-failed";
  const detail = evidence?.outcomeDetail || "the adapter returned no dependency evidence";
  return {
    ...tag("dependencyArtifactUnavailable", {
      severity: "medium",
      file: "package.json",
      evidence: `${path} — ${outcome}: ${detail}`,
      reason:
        "this release adds code whose artifact Drydock could not inspect, so the dependency remains unreviewed and requires manual verification",
      dependency: {
        name: dependency.name,
        version,
        path,
        section: dependency.section,
        declaredSpec: dependency.declaredSpec,
      },
    }),
    ruleVersion: DETERMINISTIC_RULES_VERSION,
  };
}

function omittedDependenciesFinding(omittedCount: number): Finding {
  return {
    ...tag("dependencyArtifactUnavailable", {
      severity: "medium",
      file: "package.json",
      evidence: `${omittedCount} additional direct ${omittedCount === 1 ? "dependency was" : "dependencies were"} omitted after the ${MAX_RECORDED_DEPENDENCIES}-record evidence limit`,
      reason:
        "this release adds more direct dependencies than one report records individually, so the omitted artifacts require manual verification",
    }),
    ruleVersion: DETERMINISTIC_RULES_VERSION,
  };
}

function dependencyPath(
  parent: { name: string | null; version: string | null },
  name: string,
  version: string | null,
): string {
  return `${parent.name ?? "parent"}@${parent.version ?? "unknown"} -> ${name}@${version ?? "unresolved"}`;
}

function severityRank(severity: Finding["severity"]): number {
  return { info: 0, low: 1, medium: 2, high: 3, critical: 4 }[severity];
}
