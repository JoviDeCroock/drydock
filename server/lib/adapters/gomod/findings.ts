import { type FileRecord, type Finding, tarSuspiciousEntryFindings } from "../../review";
import { firstMatchingLine } from "../../text-utils";
import { parseGoModFile } from "./manifest";
import {
  GO_RULE_IDS,
  GO_RULES_VERSION,
  type GoArtifactSummary,
  type GoPreparedArtifact,
  type GoReleaseManifest,
} from "./types";

const GO_GENERATE_RE = /^\/\/go:generate\s/m;
const CGO_IMPORT_RE = /^\s*import\s+"C"|^\s*"C"$/m;
const UNSAFE_IMPORT_RE = /(?:^\s*import\s+(?:\w+\s+)?"unsafe"|^\s*(?:\w+\s+)?"unsafe"\s*$)/m;
const SYSCALL_IMPORT_RE =
  /(?:^\s*import\s+(?:\w+\s+)?"(?:syscall|golang\.org\/x\/sys\/[\w/]+)"|^\s*(?:\w+\s+)?"(?:syscall|golang\.org\/x\/sys\/[\w/]+)"\s*$)/m;

export function summarizeGoArtifact(
  artifactPath: string,
  files: FileRecord[],
  root: { modulePath: string; version: string } | null,
): GoArtifactSummary {
  const goModFile = files.find((file) => file.path === "go.mod");
  const parsed = goModFile?.textSample
    ? parseGoModFile(goModFile.textSample)
    : { modulePath: null, replaceDirectives: [] };
  return {
    path: artifactPath,
    kind: "module",
    goModPath: goModFile?.path ?? null,
    module: {
      modulePath: parsed.modulePath,
      rootModulePath: root?.modulePath ?? null,
      rootVersion: root?.version ?? null,
      replaceDirectives: parsed.replaceDirectives,
    },
  };
}

export function goReleaseFindings(
  manifest: GoReleaseManifest,
  artifacts: GoPreparedArtifact[],
  baselineFiles: FileRecord[] | null,
): Finding[] {
  const findings: Finding[] = [];

  for (const artifact of artifacts) {
    const { summary } = artifact;
    findings.push(...tarSuspiciousEntryFindings(artifact.suspiciousEntries));

    const goModEvidencePath = summary.goModPath ?? "go.mod";
    const identityPath = summary.module.modulePath ?? summary.module.rootModulePath;
    if (!identityPath || !summary.module.rootVersion) {
      findings.push(
        tag("metadataMissing", {
          severity: "medium",
          file: goModEvidencePath,
          evidence: `${artifact.path} does not expose a Go module path/version`,
          reason:
            "release gates need module path and version metadata to prove the artifact matches the reviewed manifest",
        }),
      );
    } else {
      if (identityPath !== manifest.package) {
        findings.push(
          tag("metadataMismatch", {
            severity: "critical",
            file: goModEvidencePath,
            evidence: `${artifact.path} module path ${identityPath} != manifest package ${manifest.package}`,
            reason: "the release artifact module path does not match the reviewed manifest",
          }),
        );
      }
      if (summary.module.rootVersion !== manifest.version) {
        findings.push(
          tag("metadataMismatch", {
            severity: "critical",
            file: goModEvidencePath,
            evidence: `${artifact.path} zip version ${summary.module.rootVersion} != manifest version ${manifest.version}`,
            reason: "the release artifact version does not match the reviewed manifest",
          }),
        );
      }
      if (
        summary.module.modulePath &&
        summary.module.rootModulePath &&
        summary.module.modulePath !== summary.module.rootModulePath
      ) {
        findings.push(
          tag("metadataMismatch", {
            severity: "critical",
            file: goModEvidencePath,
            evidence: `go.mod module ${summary.module.modulePath} != zip root ${summary.module.rootModulePath}`,
            reason: "the module zip root and its go.mod disagree on the module identity",
          }),
        );
      }
    }

    for (const directive of summary.module.replaceDirectives) {
      findings.push(
        tag("replaceDirective", {
          severity: "medium",
          file: goModEvidencePath,
          line: firstMatchingLine(
            artifact.files.find((file) => file.path === summary.goModPath)?.textSample,
            [/^\s*replace\b/],
          ),
          evidence: `go.mod replace directive: ${directive}`,
          reason:
            "replace directives redirect dependency resolution away from the module proxy; in a published module they signal untracked or local dependency sources",
        }),
      );
    }

    findings.push(...capabilityDeltaFindings(artifact, baselineFiles));
  }

  return findings;
}

interface CapabilityRule {
  rule: keyof typeof GO_RULE_IDS;
  pattern: RegExp;
  severity: Finding["severity"];
  evidence: string;
  reason: string;
  fileFilter: (path: string) => boolean;
}

const CAPABILITY_RULES: CapabilityRule[] = [
  {
    rule: "goGenerateAdded",
    pattern: GO_GENERATE_RE,
    severity: "medium",
    evidence: "//go:generate directive added",
    reason:
      "go:generate directives run arbitrary commands on developer machines that invoke go generate",
    fileFilter: isGoSourcePath,
  },
  {
    rule: "cgoIntroduced",
    pattern: CGO_IMPORT_RE,
    severity: "high",
    evidence: 'import "C" (cgo) added',
    reason:
      "cgo introduces native code compiled and linked into consumer builds, a hard-to-audit execution surface",
    fileFilter: isGoSourcePath,
  },
  {
    rule: "unsafeUsageAdded",
    pattern: UNSAFE_IMPORT_RE,
    severity: "medium",
    evidence: 'import "unsafe" added',
    reason:
      "unsafe breaks Go memory safety and is a common building block for hiding malicious behavior",
    fileFilter: isGoSourcePath,
  },
  {
    rule: "syscallUsageAdded",
    pattern: SYSCALL_IMPORT_RE,
    severity: "medium",
    evidence: "syscall import added",
    reason:
      "direct syscall access sidesteps the standard library and can perform low-level process/host operations",
    fileFilter: isGoSourcePath,
  },
];

/**
 * Capability deltas: flag files that newly carry a capability relative to the
 * baseline release. With no baseline every carrying file is flagged, so a first
 * release still surfaces the capability inventory.
 */
function capabilityDeltaFindings(
  artifact: GoPreparedArtifact,
  baselineFiles: FileRecord[] | null,
): Finding[] {
  const findings: Finding[] = [];
  const baselineByPath = new Map((baselineFiles ?? []).map((file) => [file.path, file]));
  for (const capability of CAPABILITY_RULES) {
    for (const file of artifact.files) {
      if (!capability.fileFilter(file.path)) continue;
      const sample = file.textSample ?? "";
      if (!capability.pattern.test(sample)) continue;
      const baselineFile = baselineByPath.get(file.path);
      if (baselineFile && capability.pattern.test(baselineFile.textSample ?? "")) continue;
      findings.push(
        tag(capability.rule, {
          severity: capability.severity,
          file: file.path,
          line: firstMatchingLine(sample, [capability.pattern]),
          evidence: capability.evidence,
          reason: capability.reason,
        }),
      );
    }
  }
  return findings;
}

function isGoSourcePath(path: string): boolean {
  return /\.go$/i.test(path);
}

function tag(
  rule: keyof typeof GO_RULE_IDS,
  finding: Omit<Finding, "ruleId" | "ruleVersion">,
): Finding {
  return {
    ...finding,
    ruleId: GO_RULE_IDS[rule],
    ruleVersion: GO_RULES_VERSION,
  };
}
