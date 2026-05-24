import { diffLines } from "diff";
import { hasImplicitNodeGypInstall, isRootGypPath, normalizeStringRecord } from "./tar-parser.js";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface FileRecord {
  path: string;
  size: number;
  sha256: string;
  textSample?: string;
  flags: string[];
}

export interface Finding {
  severity: "info" | "low" | "medium" | "high" | "critical";
  file: string;
  evidence: string;
  reason: string;
  line?: number;
  ruleId?: string;
  ruleVersion?: string;
}

// Bump when deterministic rule semantics, severities, or coverage change in a
// way that should invalidate cached scan reports. Stored alongside each
// finding so historical reports can be traced back to the ruleset that
// produced them.
export const DETERMINISTIC_RULES_VERSION = "1.3.0";

export const DETERMINISTIC_RULE_IDS = {
  installScriptPreinstall: "install-script.preinstall",
  installScript: "install-script.lifecycle",
  codeProcessExecution: "code.process-execution",
  codeNetworkAccess: "code.network-access",
  codeDynamicEvaluation: "code.dynamic-evaluation",
  codeCredentialAccess: "code.credential-access",
  fileSecretContent: "file.secret-content",
  fileLargeBinary: "file.large-binary",
  fileNativeArtifact: "file.native-artifact",
  installScriptImplicitNodeGyp: "install-script.implicit-node-gyp",
  packageJsonParseFailed: "package-json.parse-failed",
  diffCredentialFileAdded: "diff.credential-file-added",
  diffLargeNewFile: "diff.large-new-file",
  dependencyUnusualSpec: "dependency.unusual-spec",
  dependencyOptionalAdded: "dependency.optional-added",
  stageMetadataMismatch: "stage.metadata-mismatch",
} as const;

export interface PackageJsonSummary {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  implicitScripts?: Record<string, string>;
  gypfile?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
  main?: string;
  module?: string;
  types?: string;
  exports?: unknown;
}

export type DependencySection = "dependencies" | "optionalDependencies" | "peerDependencies";

export interface PackageJsonDiffEntry {
  key: string;
  status: "added" | "removed" | "modified";
  previous?: string;
  staged?: string;
  section?: DependencySection;
}

export interface PackageJsonDiff {
  name: string | null;
  previousVersion: string | null;
  stagedVersion: string | null;
  scripts: PackageJsonDiffEntry[];
  dependencies: PackageJsonDiffEntry[];
  entrypointsChanged: boolean;
}

export interface DiffEntry {
  path: string;
  status: "added" | "removed" | "modified" | "unchanged";
  previousSize?: number;
  stagedSize?: number;
  previousSha256?: string;
  stagedSha256?: string;
  flags: string[];
}

export type FindingDiffStatus = DiffEntry["status"] | "unknown";

export interface FindingDiffAnnotation {
  diffStatus: FindingDiffStatus;
  releaseDelta: boolean;
}

export interface FindingAnnotationOptions {
  previousFiles?: Array<Pick<FileRecord, "path" | "textSample" | "flags">>;
  stagedFiles?: Array<Pick<FileRecord, "path" | "textSample" | "flags">>;
  persistedAnnotations?: Map<string, FindingDiffAnnotation>;
}

const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];
const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const PROCESS_EXECUTION_PATTERNS = [
  /\bchild_process\b/,
  /\bexecSync\b/,
  /\bexecFileSync\b/,
  /\bspawn\(/,
  /\bspawnSync\(/,
  /\bcurl\s/,
  /\bwget\s/,
  /\bnc\s/,
  /\bbash\s+-c/,
  /\bpowershell\s/,
];
const NETWORK_ACCESS_PATTERNS = [
  /\brequire\(["'](?:node:)?(?:http|https|net|dns)["']\)/,
  /\bfrom\s+["'](?:node:)?(?:http|https|net|dns)["']/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\baxios\s*\./,
];
const DYNAMIC_EVALUATION_PATTERNS = [
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\bWebAssembly\.compile\s*\(/,
  /\batob\s*\(/,
  /\bBuffer\.from\s*\([^,]+,\s*["']base64["']\s*\)/,
];
const CREDENTIAL_ACCESS_PATTERNS = [
  /\bprocess\.env\b/,
  /\bnpm_config_/,
  /\bNPM_TOKEN\b/,
  /\bGITHUB_TOKEN\b/,
  /\bAWS_SECRET\b/,
  /\bPRIVATE_KEY\b/,
];

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/npm_[A-Za-z0-9]{20,}/g, "[REDACTED_NPM_TOKEN]"],
  [/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_ACCESS_KEY]"],
  [/ASIA[0-9A-Z]{16}/g, "[REDACTED_AWS_SESSION_KEY]"],
  [/AIza[0-9A-Za-z\-_]{35}/g, "[REDACTED_GOOGLE_API_KEY]"],
  [/ya29\.[0-9A-Za-z\-_]{20,}/g, "[REDACTED_GOOGLE_OAUTH_TOKEN]"],
  [/sk_(?:live|test)_[0-9a-zA-Z]{16,}/g, "[REDACTED_STRIPE_KEY]"],
  [/rk_(?:live|test)_[0-9a-zA-Z]{16,}/g, "[REDACTED_STRIPE_KEY]"],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK_TOKEN]"],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, "[REDACTED_SLACK_WEBHOOK]"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"],
  [/\b(?:[A-Za-z]+:\/\/)[^\s/@:]+:[^\s/@]+@[^\s'"\\]+/g, "[REDACTED_URL_WITH_CREDENTIALS]"],
  [
    /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
  [/(authorization\s*[:=]\s*)['"]?Bearer\s+[A-Za-z0-9._\-+/=]{16,}/gi, "$1[REDACTED_BEARER]"],
  [
    /((?:secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*)['"]?[^'"\s]{12,}/gi,
    "$1[REDACTED_SECRET]",
  ],
];

export function deterministicFindings(
  files: FileRecord[],
  diff: DiffEntry[] = [],
  packageJsonSummary?: PackageJsonSummary | null,
): Finding[] {
  const findings: Finding[] = [];
  const diffByPath = new Map(diff.map((entry) => [entry.path, entry]));
  const packageJsonFile = files.find((file) => file.path === "package.json" && file.textSample);
  const rawPackageJson = packageJsonFile?.textSample
    ? (safeJson(packageJsonFile.textSample) as PackageJsonSummary | null)
    : null;
  const packageJsonParseFailed = Boolean(packageJsonFile?.textSample) && rawPackageJson === null;
  const packageJson = packageJsonSummary ?? rawPackageJson;
  const scripts = normalizeStringRecord(packageJson?.scripts);
  const implicitScripts = normalizeStringRecord(packageJson?.implicitScripts);
  const rootGypFile = files.find((file) => isRootGypPath(file.path));
  const tag = (
    rule: keyof typeof DETERMINISTIC_RULE_IDS,
    finding: Omit<Finding, "ruleId" | "ruleVersion">,
  ): Finding => ({
    ...finding,
    ruleId: DETERMINISTIC_RULE_IDS[rule],
    ruleVersion: DETERMINISTIC_RULES_VERSION,
  });

  if (packageJsonParseFailed) {
    findings.push(
      tag("packageJsonParseFailed", {
        severity: "medium",
        file: packageJsonFile?.path ?? "package.json",
        line: 1,
        evidence: packageJsonFile?.flags.includes("truncated")
          ? "package.json parse failed; captured sample was truncated"
          : "package.json parse failed",
        reason:
          "the package manifest could not be parsed, so lifecycle script and dependency review from the tarball manifest may be incomplete",
      }),
    );
  }

  const implicitNodeGyp =
    implicitScripts.install === "node-gyp rebuild" || hasImplicitNodeGypInstall(files, packageJson);
  if (implicitNodeGyp) {
    findings.push(
      tag("installScriptImplicitNodeGyp", {
        severity: "high",
        file: rootGypFile?.path ?? packageJsonFile?.path ?? "package.json",
        line: rootGypFile ? 1 : firstJsonPropertyLine(packageJsonFile?.textSample, "gypfile"),
        evidence: "implicit install: node-gyp rebuild",
        reason: rootGypFile
          ? "npm defaults install to node-gyp rebuild when a root *.gyp file exists and no install/preinstall script or gypfile=false is declared"
          : "npm staged metadata reports the default node-gyp install hook; the source root had a *.gyp file even if that file is not present in the packed tarball",
      }),
    );
  }

  for (const script of LIFECYCLE_SCRIPTS) {
    if (!scripts[script] || implicitScripts[script] === scripts[script]) continue;
    findings.push(
      tag(script === "preinstall" ? "installScriptPreinstall" : "installScript", {
        severity: script === "preinstall" ? "critical" : "high",
        file: packageJsonFile?.path ?? "package.json",
        line: firstJsonPropertyLine(packageJsonFile?.textSample, script, scripts[script]),
        evidence: `${script}: ${scripts[script]}`,
        reason: "install lifecycle hooks execute on consumer machines",
      }),
    );
  }

  for (const file of files) {
    const sample = file.textSample || "";
    const changed = diffByPath.get(file.path)?.status;
    const changedPrefix = changed && changed !== "unchanged" ? `new/changed ${changed} file: ` : "";

    if (
      /\b(child_process|execSync|execFileSync|spawn\(|spawnSync\(|curl\s|wget\s|nc\s|bash\s+-c|powershell\s)/.test(
        sample,
      )
    ) {
      findings.push(
        tag("codeProcessExecution", {
          severity: "high",
          file: file.path,
          line: firstMatchingLine(sample, PROCESS_EXECUTION_PATTERNS),
          evidence: `${changedPrefix}process or shell execution`,
          reason: "package may execute arbitrary commands",
        }),
      );
    }
    if (
      /\b(require\(["'](?:node:)?(?:http|https|net|dns)["']\)|from\s+["'](?:node:)?(?:http|https|net|dns)["']|fetch\s*\(|XMLHttpRequest|axios\s*\.)/.test(
        sample,
      )
    ) {
      findings.push(
        tag("codeNetworkAccess", {
          severity: changed === "added" ? "high" : "medium",
          file: file.path,
          line: firstMatchingLine(sample, NETWORK_ACCESS_PATTERNS),
          evidence: `${changedPrefix}network-capable code path`,
          reason:
            "unexpected network access in package code can be used for exfiltration or staged payload retrieval",
        }),
      );
    }
    if (
      /\beval\s*\(/.test(sample) ||
      /\bnew\s+Function\s*\(/.test(sample) ||
      /\bWebAssembly\.compile\s*\(/.test(sample) ||
      /\batob\s*\(/.test(sample) ||
      /\bBuffer\.from\s*\([^,]+,\s*["']base64["']\s*\)/.test(sample)
    ) {
      findings.push(
        tag("codeDynamicEvaluation", {
          severity: changed === "added" ? "high" : "medium",
          file: file.path,
          line: firstMatchingLine(sample, DYNAMIC_EVALUATION_PATTERNS),
          evidence: `${changedPrefix}dynamic code or obfuscation primitive`,
          reason: "common malware and obfuscation technique",
        }),
      );
    }
    if (
      /\b(process\.env|npm_config_|NPM_TOKEN|GITHUB_TOKEN|AWS_SECRET|PRIVATE_KEY)\b/.test(sample)
    ) {
      findings.push(
        tag("codeCredentialAccess", {
          severity: changed === "added" ? "high" : "medium",
          file: file.path,
          line: firstMatchingLine(sample, CREDENTIAL_ACCESS_PATTERNS),
          evidence: `${changedPrefix}secret/environment access`,
          reason: "package may read credentials from the install environment",
        }),
      );
    }
    if (/\.npmrc|\.env|id_rsa|id_ed25519/i.test(file.path) || containsSecretLikeText(sample)) {
      findings.push(
        tag("fileSecretContent", {
          severity: changed === "added" ? "critical" : "high",
          file: file.path,
          line: firstSecretLine(sample),
          evidence: `${changedPrefix}secret-looking file or content`,
          reason: "published artifacts should not include credentials or private material",
        }),
      );
    }
    if (file.flags.includes("binary") && file.size > 1024 * 1024) {
      findings.push(
        tag("fileLargeBinary", {
          severity: changed === "added" ? "high" : "info",
          file: file.path,
          evidence: `${file.size} byte binary`,
          reason: "large binary should be reviewed manually",
        }),
      );
    }
    if (/\.(node|dll|so|dylib|exe|wasm)$/i.test(file.path)) {
      findings.push(
        tag("fileNativeArtifact", {
          severity: "high",
          file: file.path,
          evidence: "native, wasm, or executable artifact",
          reason:
            "native binaries are hard to audit and can execute outside JavaScript policy checks",
        }),
      );
    }
  }

  for (const entry of diff) {
    if (entry.status === "added" && /(^|\/)(\.npmrc|\.env|id_rsa|id_ed25519)$/i.test(entry.path)) {
      findings.push(
        tag("diffCredentialFileAdded", {
          severity: "critical",
          file: entry.path,
          line: 1,
          evidence: "credential-looking file added",
          reason: "package artifact includes a file name commonly associated with secrets",
        }),
      );
    }
    if (entry.status === "added" && entry.stagedSize && entry.stagedSize > 2 * 1024 * 1024) {
      findings.push(
        tag("diffLargeNewFile", {
          severity: "medium",
          file: entry.path,
          evidence: `${entry.stagedSize} byte new file`,
          reason: "large new package artifact should be reviewed",
        }),
      );
    }
  }

  return findings;
}

export function createPackageDiff(
  previousFiles: FileRecord[],
  stagedFiles: FileRecord[],
): DiffEntry[] {
  const previous = new Map(previousFiles.map((file) => [file.path, file]));
  const staged = new Map(stagedFiles.map((file) => [file.path, file]));
  const paths = [...new Set([...previous.keys(), ...staged.keys()])].sort();

  return paths.map((path) => {
    const before = previous.get(path);
    const after = staged.get(path);
    if (!before && after)
      return {
        path,
        status: "added",
        stagedSize: after.size,
        stagedSha256: after.sha256,
        flags: after.flags,
      };
    if (before && !after)
      return {
        path,
        status: "removed",
        previousSize: before.size,
        previousSha256: before.sha256,
        flags: before.flags,
      };
    if (before && after && before.sha256 !== after.sha256) {
      return {
        path,
        status: "modified",
        previousSize: before.size,
        stagedSize: after.size,
        previousSha256: before.sha256,
        stagedSha256: after.sha256,
        flags: [...new Set([...before.flags, ...after.flags])],
      };
    }
    return {
      path,
      status: "unchanged",
      previousSize: before?.size,
      stagedSize: after?.size,
      previousSha256: before?.sha256,
      stagedSha256: after?.sha256,
      flags: [...new Set([...(before?.flags || []), ...(after?.flags || [])])],
    };
  });
}

export function summarizePackageJsonDiff(
  previousPkg: PackageJsonSummary | null | undefined,
  stagedPkg: PackageJsonSummary | null | undefined,
): PackageJsonDiff {
  const changedScripts = diffObject(previousPkg?.scripts || {}, stagedPkg?.scripts || {});
  const changedDependencies = diffDependencySections(previousPkg, stagedPkg);
  return {
    name: stagedPkg?.name || previousPkg?.name || null,
    previousVersion: previousPkg?.version || null,
    stagedVersion: stagedPkg?.version || null,
    scripts: changedScripts,
    dependencies: changedDependencies,
    entrypointsChanged:
      JSON.stringify([
        previousPkg?.bin,
        previousPkg?.main,
        previousPkg?.module,
        previousPkg?.types,
        previousPkg?.exports,
      ]) !==
      JSON.stringify([
        stagedPkg?.bin,
        stagedPkg?.main,
        stagedPkg?.module,
        stagedPkg?.types,
        stagedPkg?.exports,
      ]),
  };
}

export function packageJsonDiffFindings(
  packageJsonDiff: PackageJsonDiff,
  stagedPackageJsonText?: string | null,
): Finding[] {
  const findings: Finding[] = [];
  for (const entry of packageJsonDiff.dependencies) {
    if (entry.status !== "added" && entry.status !== "modified") continue;
    if (entry.section === "optionalDependencies" && entry.status === "added") {
      findings.push({
        severity: "high",
        file: "package.json",
        line: firstJsonPropertyLine(stagedPackageJsonText, entry.key, entry.staged),
        evidence: `${entry.key}: ${entry.staged}`,
        reason:
          "optional dependencies can execute install lifecycle hooks while failing softly on unsupported platforms, so newly added optional dependencies require manual review",
        ruleId: DETERMINISTIC_RULE_IDS.dependencyOptionalAdded,
        ruleVersion: DETERMINISTIC_RULES_VERSION,
      });
    }
    if (!entry.staged) continue;
    const kind = unusualDependencySpecKind(entry.staged);
    if (!kind) continue;
    findings.push({
      severity: "high",
      file: "package.json",
      line: firstJsonPropertyLine(stagedPackageJsonText, entry.key, entry.staged),
      evidence: `${entry.key}: ${entry.staged}`,
      reason: `${kind} dependency specs resolve code outside normal npm semver ranges and can introduce unreviewed install-time behavior`,
      ruleId: DETERMINISTIC_RULE_IDS.dependencyUnusualSpec,
      ruleVersion: DETERMINISTIC_RULES_VERSION,
    });
  }
  return findings;
}

export function computeRisk(findings: Array<{ severity?: string | null }>): RiskLevel {
  if (findings.some((f) => f.severity === "critical")) return "critical";
  if (findings.some((f) => f.severity === "high")) return "high";
  if (findings.some((f) => f.severity === "medium")) return "medium";
  return "low";
}

export function annotateFindingsWithDiffStatus<
  T extends { id?: string; file: string; line?: number | null; ruleId?: string | null },
>(
  findings: T[],
  diff: Array<{ path: string; status?: unknown }>,
  options: FindingAnnotationOptions = {},
): Array<T & FindingDiffAnnotation> {
  const diffByPath = new Map(
    diff.map((entry) => [entry.path, normalizeFindingDiffStatus(entry.status)]),
  );
  const previousByPath = new Map((options.previousFiles ?? []).map((file) => [file.path, file]));
  const stagedByPath = new Map((options.stagedFiles ?? []).map((file) => [file.path, file]));
  const changedLineCache = new Map<string, Set<number> | null>();
  return findings.map((finding) => {
    const persisted = finding.id ? options.persistedAnnotations?.get(finding.id) : null;
    if (persisted) return { ...finding, ...persisted };

    const diffStatus = diffByPath.get(finding.file) ?? "unknown";
    return {
      ...finding,
      diffStatus,
      releaseDelta:
        isReleaseScopedFinding(finding) ||
        isFindingOnReleaseDelta(
          finding,
          diffStatus,
          previousByPath,
          stagedByPath,
          changedLineCache,
        ),
    };
  });
}

function isReleaseScopedFinding(finding: { ruleId?: string | null }): boolean {
  return Boolean(
    finding.ruleId?.startsWith("stage.") ||
    finding.ruleId === DETERMINISTIC_RULE_IDS.dependencyUnusualSpec ||
    finding.ruleId === DETERMINISTIC_RULE_IDS.dependencyOptionalAdded ||
    finding.ruleId === DETERMINISTIC_RULE_IDS.diffCredentialFileAdded ||
    finding.ruleId === DETERMINISTIC_RULE_IDS.diffLargeNewFile,
  );
}

function isFindingOnReleaseDelta(
  finding: { file: string; line?: number | null; ruleId?: string | null },
  diffStatus: FindingDiffStatus,
  previousByPath: Map<string, Pick<FileRecord, "path" | "textSample" | "flags">>,
  stagedByPath: Map<string, Pick<FileRecord, "path" | "textSample" | "flags">>,
  changedLineCache: Map<string, Set<number> | null>,
): boolean {
  if (diffStatus === "added") return true;
  if (diffStatus !== "modified") return false;
  if (!finding.line) return true;

  const changedLines = changedStagedLinesForPath(
    finding.file,
    previousByPath,
    stagedByPath,
    changedLineCache,
  );
  if (!changedLines) return true;
  if (changedLines.has(finding.line)) return true;
  return findingPatternMatchesChangedLine(
    finding,
    stagedByPath.get(finding.file)?.textSample,
    changedLines,
  );
}

function changedStagedLinesForPath(
  path: string,
  previousByPath: Map<string, Pick<FileRecord, "path" | "textSample" | "flags">>,
  stagedByPath: Map<string, Pick<FileRecord, "path" | "textSample" | "flags">>,
  cache: Map<string, Set<number> | null>,
): Set<number> | null {
  if (cache.has(path)) return cache.get(path) ?? null;
  const previous = previousByPath.get(path);
  const staged = stagedByPath.get(path);
  if (!previous?.textSample || !staged?.textSample) {
    cache.set(path, null);
    return null;
  }
  if (previous.flags.includes("binary") || staged.flags.includes("binary")) {
    cache.set(path, null);
    return null;
  }
  const lines = changedStagedLines(previous.textSample, staged.textSample);
  cache.set(path, lines);
  return lines;
}

function changedStagedLines(previous: string, staged: string): Set<number> {
  const changed = new Set<number>();
  let stagedLine = 0;
  for (const part of diffLines(previous, staged)) {
    const lines = splitComparableLines(part.value);
    if (part.added) {
      for (const _line of lines) {
        stagedLine += 1;
        changed.add(stagedLine);
      }
    } else if (!part.removed) {
      stagedLine += lines.length;
    }
  }
  return changed;
}

function splitComparableLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function findingPatternMatchesChangedLine(
  finding: { ruleId?: string | null },
  stagedText: string | undefined,
  changedLines: Set<number>,
): boolean {
  if (!stagedText) return false;
  const patterns = patternsForFinding(finding);
  if (!patterns.length) return false;
  const lines = splitComparableLines(stagedText);
  for (const lineNumber of changedLines) {
    const line = lines[lineNumber - 1];
    if (line === undefined) continue;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) return true;
    }
  }
  return false;
}

function patternsForFinding(finding: { ruleId?: string | null }): RegExp[] {
  switch (finding.ruleId) {
    case DETERMINISTIC_RULE_IDS.codeProcessExecution:
      return PROCESS_EXECUTION_PATTERNS;
    case DETERMINISTIC_RULE_IDS.codeNetworkAccess:
      return NETWORK_ACCESS_PATTERNS;
    case DETERMINISTIC_RULE_IDS.codeDynamicEvaluation:
      return DYNAMIC_EVALUATION_PATTERNS;
    case DETERMINISTIC_RULE_IDS.codeCredentialAccess:
      return CREDENTIAL_ACCESS_PATTERNS;
    case DETERMINISTIC_RULE_IDS.fileSecretContent:
      return SECRET_PATTERNS.map(([pattern]) => pattern);
    default:
      return [];
  }
}

export function isReleaseDeltaStatus(status: FindingDiffStatus): boolean {
  return status === "added" || status === "modified";
}

export function normalizeFindingDiffStatus(value: unknown): FindingDiffStatus {
  switch (value) {
    case "added":
    case "removed":
    case "modified":
    case "unchanged":
      return value;
    default:
      return "unknown";
  }
}

export function combineRisk(...risks: Array<RiskLevel | null | undefined>): RiskLevel {
  return risks.reduce<RiskLevel>((highest, risk) => {
    if (!risk) return highest;
    return RISK_RANK[risk] > RISK_RANK[highest] ? risk : highest;
  }, "low");
}

export function normalizeRisk(value: unknown): RiskLevel {
  return value === "critical" || value === "high" || value === "medium" || value === "low"
    ? value
    : "medium";
}

export function redactText(text: string): string {
  return SECRET_PATTERNS.reduce(
    (out, [pattern, replacement]) => out.replace(pattern, replacement),
    text,
  );
}

function containsSecretLikeText(text: string): boolean {
  return SECRET_PATTERNS.some(([pattern]) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function firstMatchingLine(
  text: string | undefined | null,
  patterns: RegExp[],
): number | undefined {
  if (!text) return undefined;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[index])) return index + 1;
    }
  }
  return undefined;
}

function firstSecretLine(text: string | undefined | null): number | undefined {
  if (!text) return undefined;
  return firstMatchingLine(
    text,
    SECRET_PATTERNS.map(([pattern]) => pattern),
  );
}

function firstJsonPropertyLine(
  text: string | undefined | null,
  key: string,
  value?: string,
): number | undefined {
  if (!text) return undefined;
  const escapedKey = escapeRegExp(key);
  const keyPattern = new RegExp(`["']${escapedKey}["']\\s*:`);
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (keyPattern.test(lines[index])) return index + 1;
  }
  if (value) {
    const escapedValue = escapeRegExp(value);
    const valuePattern = new RegExp(escapedValue);
    for (let index = 0; index < lines.length; index += 1) {
      if (valuePattern.test(lines[index])) return index + 1;
    }
  }
  return undefined;
}

export function redactFileRecords(files: FileRecord[]): FileRecord[] {
  return files.map((file) => ({
    ...file,
    textSample: file.textSample ? redactText(file.textSample) : file.textSample,
  }));
}

export function redactFindings(findings: Finding[]): Finding[] {
  return findings.map((finding) => ({
    ...finding,
    evidence: redactText(finding.evidence),
    reason: redactText(finding.reason),
  }));
}

export function redactJson<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactJson(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        redactJson(nested),
      ]),
    ) as T;
  }
  return value;
}

function diffDependencySections(
  previousPkg: PackageJsonSummary | null | undefined,
  stagedPkg: PackageJsonSummary | null | undefined,
): PackageJsonDiffEntry[] {
  const sectionEntries = (section: DependencySection) =>
    diffObject(previousPkg?.[section] || {}, stagedPkg?.[section] || {}).map((entry) => ({
      ...entry,
      section,
    }));

  return [
    ...sectionEntries("dependencies"),
    ...sectionEntries("optionalDependencies"),
    ...sectionEntries("peerDependencies"),
  ].sort((a, b) => a.key.localeCompare(b.key) || a.section.localeCompare(b.section));
}

function unusualDependencySpecKind(spec: string): string | null {
  const normalized = spec.trim().toLowerCase();
  if (/^(?:github|gitlab|bitbucket):/.test(normalized)) return "git-hosted";
  if (/^(?:git\+ssh|git\+https|git\+http|git|ssh):/.test(normalized)) return "git";
  if (/^https?:/.test(normalized))
    return normalized.endsWith(".tgz") ? "remote tarball" : "remote URL";
  if (normalized.startsWith("file:")) return "local file";
  if (normalized.startsWith("npm:")) return "npm alias";
  return null;
}

function diffObject(
  before: Record<string, string>,
  after: Record<string, string>,
): PackageJsonDiffEntry[] {
  const out: PackageJsonDiffEntry[] = [];
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (!(key in before)) out.push({ key, status: "added", staged: after[key] });
    else if (!(key in after)) out.push({ key, status: "removed", previous: before[key] });
    else if (before[key] !== after[key])
      out.push({ key, status: "modified", previous: before[key], staged: after[key] });
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
