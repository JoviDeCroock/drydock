import {
  deterministicFindings,
  packageJsonDiffFindings,
  type DiffEntry,
  type Finding,
  type PackageJsonDiff,
} from "../../review";
import { firstJsonPropertyLine } from "../../review-rules/helpers";
import { JS_PATTERN_SET } from "../../review-rules/patterns";
import { normalizeCodeForScanning } from "../../review-rules/normalize";
import { firstMatchingLine } from "../../text-utils";
import type { AcquiredArtifact } from "../types";
import {
  extensionIdFromManifest,
  findVscodeManifestFile,
  parseVscodeExtensionManifest,
} from "./manifest";
import {
  VSCODE_RULE_IDS,
  VSCODE_RULES_VERSION,
  type VscodeAdapterDetails,
  type VscodeExtensionManifest,
} from "./types";

const COMMON_VSCODE_CONFIGURATION_NAMESPACES = new Set([
  "breadcrumbs",
  "css",
  "debug",
  "diffEditor",
  "editor",
  "emmet",
  "explorer",
  "extensions",
  "files",
  "git",
  "github",
  "html",
  "javascript",
  "json",
  "markdown",
  "npm",
  "scm",
  "search",
  "security",
  "terminal",
  "typescript",
  "window",
  "workbench",
]);

const WASM_LOADER_PATTERNS = [
  /\bWebAssembly\.(?:compile|compileStreaming|instantiate|instantiateStreaming)\s*\(/,
  /\bnew\s+Go\s*\(/,
  /\bgo\.run\s*\(/,
  /\bwasm_exec(?:\.js)?\b/,
];

export function buildVscodeFindings(args: {
  staged: AcquiredArtifact;
  details: VscodeAdapterDetails;
  fileDiff: DiffEntry[];
  manifestDiff: PackageJsonDiff;
  stagedManifestText: string | null;
}): Finding[] {
  const extensionManifest = parseVscodeExtensionManifest(args.staged.files).manifest;
  return [
    ...deterministicFindings(args.staged.files, args.fileDiff, args.staged.manifest, {
      codePatternSet: "javascript",
    }),
    ...packageJsonDiffFindings(args.manifestDiff, args.stagedManifestText),
    ...vscodeManifestFindings(args.details, extensionManifest, args.staged.files),
  ];
}

function vscodeManifestFindings(
  details: VscodeAdapterDetails,
  manifest: VscodeExtensionManifest,
  files: AcquiredArtifact["files"],
): Finding[] {
  const findings: Finding[] = [];
  const packageJsonFile = findVscodeManifestFile(files);
  const extensionId = extensionIdFromManifest(manifest);
  const mismatches: string[] = [];
  if (details.manifest.package !== extensionId) {
    mismatches.push(`manifest package ${details.manifest.package} != package.json ${extensionId}`);
  }
  if (details.manifest.version !== manifest.version) {
    mismatches.push(
      `manifest version ${details.manifest.version} != package.json ${manifest.version}`,
    );
  }
  if (mismatches.length) {
    findings.push(
      vscodeTag("metadataMismatch", {
        severity: "critical",
        file: "package.json",
        evidence: mismatches.join("; "),
        reason:
          "the reviewed VSIX identity does not match its extension manifest, so the release target cannot be trusted",
      }),
    );
  }

  const broadActivation = broadActivationEvent(manifest.activationEvents);
  if (broadActivation) {
    findings.push(
      vscodeTag("broadActivation", {
        severity: "high",
        file: "package.json",
        line: firstJsonPropertyLine(
          packageJsonFile?.textSample,
          "activationEvents",
          broadActivation,
        ),
        evidence: `activationEvents includes ${broadActivation}`,
        reason:
          "broad VS Code activation runs extension code at startup or workspace open, before a user invokes a narrow feature",
      }),
    );
  }

  const remoteCommandFinding = startupRemoteCommandFinding(manifest, files, broadActivation);
  if (remoteCommandFinding) findings.push(remoteCommandFinding);

  const wasmLoaderFinding = startupWasmLoaderFinding(manifest, files, broadActivation);
  if (wasmLoaderFinding) findings.push(wasmLoaderFinding);

  findings.push(...undeclaredConfigurationReadFindings(manifest, files));

  if (manifest.extensionDependencies.length) {
    findings.push(
      vscodeTag("extensionDependency", {
        severity: "medium",
        file: "package.json",
        line: firstJsonPropertyLine(packageJsonFile?.textSample, "extensionDependencies"),
        evidence: `extensionDependencies: ${manifest.extensionDependencies.join(", ")}`,
        reason:
          "extension dependencies are installed and activated transitively, a delivery path abused by malicious extension campaigns",
      }),
    );
  }
  if (manifest.extensionPack.length) {
    findings.push(
      vscodeTag("extensionDependency", {
        severity: "low",
        file: "package.json",
        line: firstJsonPropertyLine(packageJsonFile?.textSample, "extensionPack"),
        evidence: `extensionPack: ${manifest.extensionPack.join(", ")}`,
        reason:
          "extension packs install additional extensions transitively, so reviewers should confirm every packed extension is intended",
      }),
    );
  }

  return findings;
}

function startupRemoteCommandFinding(
  manifest: VscodeExtensionManifest,
  files: AcquiredArtifact["files"],
  broadActivation: string | null,
): Finding | null {
  if (!broadActivation) return null;
  const entrypoint = entrypointFile(manifest, files);
  if (!entrypoint?.textSample) return null;
  const sample = entrypoint.textSample;
  const normalized = normalizeCodeForScanning(sample);
  const processExecution = matches(JS_PATTERN_SET.processExecution, sample, normalized);
  const networkAccess = matches(JS_PATTERN_SET.networkAccess, sample, normalized);
  const dynamicEvaluation = matches(JS_PATTERN_SET.dynamicEvaluation, sample, normalized);
  if (!processExecution || !networkAccess || !dynamicEvaluation) return null;
  return vscodeTag("startupRemoteCommand", {
    severity: "critical",
    file: entrypoint.path,
    line: firstMatchingLine(sample, [
      ...JS_PATTERN_SET.processExecution,
      ...JS_PATTERN_SET.networkAccess,
      ...JS_PATTERN_SET.dynamicEvaluation,
    ]),
    evidence: `startup activation ${broadActivation} reaches network + decode/eval + process execution`,
    reason:
      "remote-command VS Code malware commonly activates on startup, fetches or decodes operator-controlled payloads, and executes shell commands",
  });
}

function undeclaredConfigurationReadFindings(
  manifest: VscodeExtensionManifest,
  files: AcquiredArtifact["files"],
): Finding[] {
  const declared = new Set(manifest.configurationProperties);
  const findings: Finding[] = [];
  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file.path) || !file.textSample) continue;
    for (const key of readConfigurationKeys(file.textSample)) {
      if (isDeclaredConfigurationKey(key, declared) || isCommonConfigurationKey(key)) continue;
      findings.push(
        vscodeTag("undeclaredConfigurationRead", {
          severity: "high",
          file: file.path,
          line: firstMatchingLine(file.textSample, [configurationKeyLinePattern(key)]),
          evidence: `reads undeclared VS Code configuration ${key}`,
          reason:
            "undeclared extension configuration can be pre-seeded through workspace settings and used as an operator-controlled input without appearing in the manifest",
        }),
      );
    }
  }
  return findings;
}

function startupWasmLoaderFinding(
  manifest: VscodeExtensionManifest,
  files: AcquiredArtifact["files"],
  broadActivation: string | null,
): Finding | null {
  if (!broadActivation || !hasWasmArtifact(files)) return null;
  const loader = entrypointFiles(manifest, files).find(
    (file) => isJavaScriptFile(file.path) && isWasmLoader(file.textSample),
  );
  if (!loader?.textSample) return null;
  return vscodeTag("startupWasmLoader", {
    severity: "critical",
    file: loader.path,
    line: firstMatchingLine(loader.textSample, WASM_LOADER_PATTERNS),
    evidence: `startup activation ${broadActivation} loads a bundled WebAssembly payload`,
    reason:
      "startup-loaded VS Code WebAssembly payloads can hide network and process behavior inside an opaque module",
  });
}

function hasWasmArtifact(files: AcquiredArtifact["files"]): boolean {
  return files.some((file) => /\.wasm$/i.test(file.path));
}

function isJavaScriptFile(path: string): boolean {
  return /\.[cm]?jsx?$/.test(path);
}

function isWasmLoader(sample: string | undefined): boolean {
  if (!sample) return false;
  return WASM_LOADER_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(sample);
  });
}

function readConfigurationKeys(sample: string): string[] {
  const keys = new Set<string>();
  const chained =
    /(?:vscode\.)?workspace\.getConfiguration\s*\(\s*["']([^"']+)["']\s*\)\s*\.get\s*\(\s*["']([^"']+)["']/g;
  const direct = /(?:vscode\.)?workspace\.getConfiguration\s*\(\s*["']([^"']+\.[^"']+)["']\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = chained.exec(sample))) keys.add(`${match[1]}.${match[2]}`);
  while ((match = direct.exec(sample))) keys.add(match[1]);
  return [...keys].sort();
}

function configurationKeyLinePattern(key: string): RegExp {
  const [namespace, leaf] = key.split(/\.(.*)/s);
  return new RegExp(
    `workspace\\.getConfiguration\\s*\\(\\s*["']${escapeRegExp(namespace)}(?:\\.${escapeRegExp(
      leaf ?? "",
    )})?["']`,
  );
}

function isDeclaredConfigurationKey(key: string, declared: Set<string>): boolean {
  return declared.has(key);
}

function isCommonConfigurationKey(key: string): boolean {
  const namespace = key.split(".")[0];
  return COMMON_VSCODE_CONFIGURATION_NAMESPACES.has(namespace);
}

function entrypointFile(
  manifest: Pick<VscodeExtensionManifest, "main" | "browser">,
  files: AcquiredArtifact["files"],
) {
  return entrypointFiles(manifest, files)[0] ?? null;
}

function entrypointFiles(
  manifest: Pick<VscodeExtensionManifest, "main" | "browser">,
  files: AcquiredArtifact["files"],
) {
  const candidates = [
    ...entrypointCandidates(manifest.main),
    ...entrypointCandidates(manifest.browser),
  ];
  const seen = new Set<string>();
  return candidates
    .map((path) => files.find((file) => file.path === path))
    .filter((file): file is AcquiredArtifact["files"][number] => {
      if (!file || seen.has(file.path)) return false;
      seen.add(file.path);
      return true;
    });
}

function entrypointCandidates(path: string | null): string[] {
  if (!path) return [];
  const normalized = path.replace(/^\.\//, "");
  const out = [normalized];
  if (!/\.[cm]?js$/i.test(normalized))
    out.push(`${normalized}.js`, `${normalized}.cjs`, `${normalized}.mjs`);
  return out;
}

function broadActivationEvent(events: string[]): string | null {
  return events.find((event) => event === "*" || event === "onStartupFinished") ?? null;
}

function matches(patterns: RegExp[], sample: string, normalized: string): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    const raw = pattern.test(sample);
    pattern.lastIndex = 0;
    return raw || pattern.test(normalized);
  });
}

function vscodeTag(
  rule: keyof typeof VSCODE_RULE_IDS,
  finding: Omit<Finding, "ruleId" | "ruleVersion">,
): Finding {
  return { ...finding, ruleId: VSCODE_RULE_IDS[rule], ruleVersion: VSCODE_RULES_VERSION };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
