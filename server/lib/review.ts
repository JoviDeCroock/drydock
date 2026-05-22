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
export const DETERMINISTIC_RULES_VERSION = "1.0.0";

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
  diffCredentialFileAdded: "diff.credential-file-added",
  diffLargeNewFile: "diff.large-new-file",
} as const;

export interface PackageJsonSummary {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
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

export interface DiffEntry {
  path: string;
  status: "added" | "removed" | "modified" | "unchanged";
  previousSize?: number;
  stagedSize?: number;
  previousSha256?: string;
  stagedSha256?: string;
  flags: string[];
}

const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];
const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

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

export function deterministicFindings(files: FileRecord[], diff: DiffEntry[] = []): Finding[] {
  const findings: Finding[] = [];
  const diffByPath = new Map(diff.map((entry) => [entry.path, entry]));
  const tag = (
    rule: keyof typeof DETERMINISTIC_RULE_IDS,
    finding: Omit<Finding, "ruleId" | "ruleVersion">,
  ): Finding => ({
    ...finding,
    ruleId: DETERMINISTIC_RULE_IDS[rule],
    ruleVersion: DETERMINISTIC_RULES_VERSION,
  });

  for (const file of files) {
    const p = file.path.toLowerCase();
    const sample = file.textSample || "";
    const changed = diffByPath.get(file.path)?.status;
    const changedPrefix = changed && changed !== "unchanged" ? `new/changed ${changed} file: ` : "";

    if (
      p.endsWith("package.json") &&
      /"(preinstall|install|postinstall|prepare)"\s*:/.test(sample)
    ) {
      const pkg = safeJson(sample) as PackageJsonSummary | null;
      const scripts = pkg?.scripts || {};
      for (const script of LIFECYCLE_SCRIPTS) {
        if (scripts[script]) {
          findings.push(
            tag(script === "preinstall" ? "installScriptPreinstall" : "installScript", {
              severity: script === "preinstall" ? "critical" : "high",
              file: file.path,
              evidence: `${script}: ${scripts[script]}`,
              reason: "install lifecycle hooks execute on consumer machines",
            }),
          );
        }
      }
    }
    if (
      /\b(child_process|execSync|execFileSync|spawn\(|spawnSync\(|curl\s|wget\s|nc\s|bash\s+-c|powershell\s)/.test(
        sample,
      )
    ) {
      findings.push(
        tag("codeProcessExecution", {
          severity: "high",
          file: file.path,
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
) {
  const changedScripts = diffObject(previousPkg?.scripts || {}, stagedPkg?.scripts || {});
  const changedDependencies = diffObject(
    {
      ...previousPkg?.dependencies,
      ...previousPkg?.optionalDependencies,
      ...previousPkg?.peerDependencies,
    },
    {
      ...stagedPkg?.dependencies,
      ...stagedPkg?.optionalDependencies,
      ...stagedPkg?.peerDependencies,
    },
  );
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

export function computeRisk(findings: Finding[]): RiskLevel {
  if (findings.some((f) => f.severity === "critical")) return "critical";
  if (findings.some((f) => f.severity === "high")) return "high";
  if (findings.some((f) => f.severity === "medium")) return "medium";
  return "low";
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

function diffObject(before: Record<string, string>, after: Record<string, string>) {
  const out: Array<{
    key: string;
    status: "added" | "removed" | "modified";
    previous?: string;
    staged?: string;
  }> = [];
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (!(key in before)) out.push({ key, status: "added", staged: after[key] });
    else if (!(key in after)) out.push({ key, status: "removed", previous: before[key] });
    else if (before[key] !== after[key])
      out.push({ key, status: "modified", previous: before[key], staged: after[key] });
  }
  return out;
}

function safeJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
