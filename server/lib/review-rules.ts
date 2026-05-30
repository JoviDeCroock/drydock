import { hasImplicitNodeGypInstall, isRootGypPath, normalizeStringRecord } from "./tar-parser.js";
import { isOutsidePackageFilesAllowlist } from "./review-package-files";
import { firstMatchingLine } from "./text-utils";
import type { CodePatternSet, DiffEntry, FileRecord, Finding, PackageJsonSummary } from "./review";

// Bump when deterministic rule semantics, severities, or coverage change in a
// way that should invalidate cached scan reports. Stored alongside each
// finding so historical reports can be traced back to the ruleset that
// produced them.
export const DETERMINISTIC_RULES_VERSION = "1.6.0";

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
  fileOutsideFilesList: "file.outside-files-list",
  installScriptImplicitNodeGyp: "install-script.implicit-node-gyp",
  packageJsonParseFailed: "package-json.parse-failed",
  diffCredentialFileAdded: "diff.credential-file-added",
  diffLargeNewFile: "diff.large-new-file",
  dependencyUnusualSpec: "dependency.unusual-spec",
  dependencyOptionalAdded: "dependency.optional-added",
  stageMetadataMismatch: "stage.metadata-mismatch",
  tarSuspiciousEntry: "tar.suspicious-entry",
} as const;

export interface DeterministicFindingOptions {
  codePatternSet?: CodePatternSet;
}

const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];
const JS_PROCESS_EXECUTION_PATTERNS = [
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
const PYTHON_PROCESS_EXECUTION_PATTERNS = [
  /\bsubprocess\b/,
  /\bos\.system\s*\(/,
  /\bos\.popen\s*\(/,
  /\bPopen\s*\(/,
  /\bpty\.spawn\s*\(/,
  /\bcommands\.getoutput\s*\(/,
];
const JS_NETWORK_ACCESS_PATTERNS = [
  /\brequire\(["'](?:node:)?(?:http|https|net|dns)["']\)/,
  /\bfrom\s+["'](?:node:)?(?:http|https|net|dns)["']/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\baxios\s*\./,
];
const PYTHON_NETWORK_ACCESS_PATTERNS = [
  /\burllib\.request\b/,
  /\brequests\.(?:get|post|put|patch|delete|request)\b/,
  /\bhttp\.client\b/,
  /\bhttplib\b/,
  /\bsocket\.socket\s*\(/,
  /\bftplib\b/,
  /\bsmtplib\b/,
  /\burlopen\s*\(/,
];
const JS_DYNAMIC_EVALUATION_PATTERNS = [
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\bWebAssembly\.compile\s*\(/,
  /\batob\s*\(/,
  /\bBuffer\.from\s*\([^,]+,\s*["']base64["']\s*\)/,
];
const PYTHON_DYNAMIC_EVALUATION_PATTERNS = [
  /(?<!\.)\bexec\s*\(/,
  /\b__import__\s*\(/,
  /\bimportlib\.import_module\s*\(/,
  /\bmarshal\.loads\s*\(/,
  /(?<!\.)\bcompile\s*\(/,
  /\bbase64\.b(?:64|32|16)decode\s*\(/,
  /\bzlib\.decompress\s*\(/,
  /\blzma\.decompress\s*\(/,
  /\bcodecs\.decode\s*\(/,
  /\bbytes\.fromhex\s*\(/,
];
const JS_CREDENTIAL_ACCESS_PATTERNS = [
  /\bprocess\.env\b/,
  /\bnpm_config_/,
  /\bNPM_TOKEN\b/,
  /\bGITHUB_TOKEN\b/,
  /\bAWS_SECRET\b/,
  /\bPRIVATE_KEY\b/,
];
const PYTHON_CREDENTIAL_ACCESS_PATTERNS = [
  /\bos\.environ\b/,
  /\bos\.getenv\s*\(/,
  /\bgetpass\b/,
  /\bkeyring\b/,
  /\.aws\/credentials/,
  /\.ssh\/id_/,
  /\.netrc/,
];

export const JS_PATTERN_SET = {
  processExecution: JS_PROCESS_EXECUTION_PATTERNS,
  networkAccess: JS_NETWORK_ACCESS_PATTERNS,
  dynamicEvaluation: JS_DYNAMIC_EVALUATION_PATTERNS,
  credentialAccess: JS_CREDENTIAL_ACCESS_PATTERNS,
};
export const PYTHON_PATTERN_SET = {
  processExecution: PYTHON_PROCESS_EXECUTION_PATTERNS,
  networkAccess: PYTHON_NETWORK_ACCESS_PATTERNS,
  dynamicEvaluation: PYTHON_DYNAMIC_EVALUATION_PATTERNS,
  credentialAccess: PYTHON_CREDENTIAL_ACCESS_PATTERNS,
};

// Python process-execution, network, and dynamic-evaluation capability in one set.
// Reused by ecosystem adapters that need to know whether a file executes code
// (e.g. a PyPI sdist's setup.py, which pip runs at install time).
export const PYTHON_EXECUTION_CAPABILITY_PATTERNS = [
  ...PYTHON_PROCESS_EXECUTION_PATTERNS,
  ...PYTHON_NETWORK_ACCESS_PATTERNS,
  ...PYTHON_DYNAMIC_EVALUATION_PATTERNS,
];

export const SECRET_PATTERNS: Array<[RegExp, string]> = [
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
  options: DeterministicFindingOptions = {},
): Finding[] {
  const findings: Finding[] = [];
  const patterns = codePatternsFor(options.codePatternSet);
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

    if (patterns.processExecution.some((pattern) => pattern.test(sample))) {
      findings.push(
        tag("codeProcessExecution", {
          severity: "high",
          file: file.path,
          line: firstMatchingLine(sample, patterns.processExecution),
          evidence: `${changedPrefix}process or shell execution`,
          reason: "package may execute arbitrary commands",
        }),
      );
    }
    if (patterns.networkAccess.some((pattern) => pattern.test(sample))) {
      findings.push(
        tag("codeNetworkAccess", {
          severity: changed === "added" ? "high" : "medium",
          file: file.path,
          line: firstMatchingLine(sample, patterns.networkAccess),
          evidence: `${changedPrefix}network-capable code path`,
          reason:
            "unexpected network access in package code can be used for exfiltration or staged payload retrieval",
        }),
      );
    }
    if (patterns.dynamicEvaluation.some((pattern) => pattern.test(sample))) {
      findings.push(
        tag("codeDynamicEvaluation", {
          severity: changed === "added" ? "high" : "medium",
          file: file.path,
          line: firstMatchingLine(sample, patterns.dynamicEvaluation),
          evidence: `${changedPrefix}dynamic code or obfuscation primitive`,
          reason: "common malware and obfuscation technique",
        }),
      );
    }
    if (patterns.credentialAccess.some((pattern) => pattern.test(sample))) {
      findings.push(
        tag("codeCredentialAccess", {
          severity: changed === "added" ? "high" : "medium",
          file: file.path,
          line: firstMatchingLine(sample, patterns.credentialAccess),
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
    if (isOutsidePackageFilesAllowlist(file.path, packageJson) && changed !== "removed") {
      findings.push(
        tag("fileOutsideFilesList", {
          severity: changed === "added" ? "high" : "medium",
          file: file.path,
          evidence: `${changedPrefix}file is not matched by package.json files allowlist`,
          reason:
            "unexpected files outside the declared package files list can indicate tarball tampering or generated payloads that are not visible in the source/package manifest review",
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

export function codePatternsFor(codePatternSet: CodePatternSet | undefined): typeof JS_PATTERN_SET {
  return codePatternSet === "python" ? PYTHON_PATTERN_SET : JS_PATTERN_SET;
}

function containsSecretLikeText(text: string): boolean {
  return SECRET_PATTERNS.some(([pattern]) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function firstSecretLine(text: string | undefined | null): number | undefined {
  if (!text) return undefined;
  return firstMatchingLine(
    text,
    SECRET_PATTERNS.map(([pattern]) => pattern),
  );
}

export function firstJsonPropertyLine(
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function safeJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
