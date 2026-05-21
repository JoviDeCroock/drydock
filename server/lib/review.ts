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
}

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

export function deterministicFindings(files: FileRecord[], diff: DiffEntry[] = []): Finding[] {
  const findings: Finding[] = [];
  const diffByPath = new Map(diff.map((entry) => [entry.path, entry]));

  for (const file of files) {
    const p = file.path.toLowerCase();
    const sample = file.textSample || "";
    const changed = diffByPath.get(file.path)?.status;
    const changedPrefix = changed && changed !== "unchanged" ? `new/changed ${changed} file: ` : "";

    if (p.endsWith("package.json") && /"(preinstall|install|postinstall|prepare)"\s*:/.test(sample)) {
      const pkg = safeJson(sample) as PackageJsonSummary | null;
      const scripts = pkg?.scripts || {};
      for (const script of LIFECYCLE_SCRIPTS) {
        if (scripts[script]) {
          findings.push({
            severity: script === "preinstall" ? "critical" : "high",
            file: file.path,
            evidence: `${script}: ${scripts[script]}`,
            reason: "install lifecycle hooks execute on consumer machines",
          });
        }
      }
    }
    if (/\b(child_process|execSync|spawn\(|curl\s|wget\s|nc\s|bash\s+-c)\b/.test(sample)) {
      findings.push({
        severity: "high",
        file: file.path,
        evidence: `${changedPrefix}process or shell execution`,
        reason: "package may execute arbitrary commands",
      });
    }
    if (
      /\beval\s*\(/.test(sample) ||
      /\bnew\s+Function\s*\(/.test(sample) ||
      /\bWebAssembly\.compile\s*\(/.test(sample) ||
      /\batob\s*\(/.test(sample) ||
      /\bBuffer\.from\s*\([^,]+,\s*["']base64["']\s*\)/.test(sample)
    ) {
      findings.push({
        severity: changed === "added" ? "high" : "medium",
        file: file.path,
        evidence: `${changedPrefix}dynamic code or obfuscation primitive`,
        reason: "common malware and obfuscation technique",
      });
    }
    if (/\b(process\.env|npm_config_|NPM_TOKEN|GITHUB_TOKEN|AWS_SECRET|PRIVATE_KEY)\b/.test(sample)) {
      findings.push({
        severity: changed === "added" ? "high" : "medium",
        file: file.path,
        evidence: `${changedPrefix}secret/environment access`,
        reason: "package may read credentials from the install environment",
      });
    }
    if (file.flags.includes("binary") && file.size > 1024 * 1024) {
      findings.push({
        severity: changed === "added" ? "high" : "info",
        file: file.path,
        evidence: `${file.size} byte binary`,
        reason: "large binary should be reviewed manually",
      });
    }
    if (/\.(node|dll|so|dylib|exe)$/i.test(file.path)) {
      findings.push({
        severity: "high",
        file: file.path,
        evidence: "native or executable artifact",
        reason: "native binaries are hard to audit and can execute outside JavaScript policy checks",
      });
    }
  }

  for (const entry of diff) {
    if (entry.status === "added" && /(^|\/)(\.npmrc|\.env|id_rsa|id_ed25519)$/i.test(entry.path)) {
      findings.push({
        severity: "critical",
        file: entry.path,
        evidence: "credential-looking file added",
        reason: "package artifact includes a file name commonly associated with secrets",
      });
    }
    if (entry.status === "added" && entry.stagedSize && entry.stagedSize > 2 * 1024 * 1024) {
      findings.push({
        severity: "medium",
        file: entry.path,
        evidence: `${entry.stagedSize} byte new file`,
        reason: "large new package artifact should be reviewed",
      });
    }
  }

  return findings;
}

export function createPackageDiff(previousFiles: FileRecord[], stagedFiles: FileRecord[]): DiffEntry[] {
  const previous = new Map(previousFiles.map((file) => [file.path, file]));
  const staged = new Map(stagedFiles.map((file) => [file.path, file]));
  const paths = [...new Set([...previous.keys(), ...staged.keys()])].sort();

  return paths.map((path) => {
    const before = previous.get(path);
    const after = staged.get(path);
    if (!before && after) return { path, status: "added", stagedSize: after.size, stagedSha256: after.sha256, flags: after.flags };
    if (before && !after) return { path, status: "removed", previousSize: before.size, previousSha256: before.sha256, flags: before.flags };
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
    { ...(previousPkg?.dependencies || {}), ...(previousPkg?.optionalDependencies || {}), ...(previousPkg?.peerDependencies || {}) },
    { ...(stagedPkg?.dependencies || {}), ...(stagedPkg?.optionalDependencies || {}), ...(stagedPkg?.peerDependencies || {}) },
  );
  return {
    name: stagedPkg?.name || previousPkg?.name || null,
    previousVersion: previousPkg?.version || null,
    stagedVersion: stagedPkg?.version || null,
    scripts: changedScripts,
    dependencies: changedDependencies,
    entrypointsChanged:
      JSON.stringify([previousPkg?.bin, previousPkg?.main, previousPkg?.module, previousPkg?.types, previousPkg?.exports]) !==
      JSON.stringify([stagedPkg?.bin, stagedPkg?.main, stagedPkg?.module, stagedPkg?.types, stagedPkg?.exports]),
  };
}

export function computeRisk(findings: Finding[]) {
  if (findings.some((f) => f.severity === "critical")) return "critical";
  if (findings.some((f) => f.severity === "high")) return "high";
  if (findings.some((f) => f.severity === "medium")) return "medium";
  return "low";
}

function diffObject(before: Record<string, string>, after: Record<string, string>) {
  const out: Array<{ key: string; status: "added" | "removed" | "modified"; previous?: string; staged?: string }> = [];
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (!(key in before)) out.push({ key, status: "added", staged: after[key] });
    else if (!(key in after)) out.push({ key, status: "removed", previous: before[key] });
    else if (before[key] !== after[key]) out.push({ key, status: "modified", previous: before[key], staged: after[key] });
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
