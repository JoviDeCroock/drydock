import {
  deterministicFindings,
  packageJsonDiffFindings,
  tarSuspiciousEntryFindings,
  type DiffEntry,
  type Finding,
  type PackageJsonDiff,
} from "../../review";
import { firstJsonPropertyLine } from "../../review/rules/helpers";
import { JS_PATTERN_SET } from "../../review/rules/patterns";
import { normalizeCodeForScanning } from "../../review/rules/normalize";
import { firstMatchingLine } from "../../platform/text-utils";
import type { AcquiredArtifact } from "../package-adapter";
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
const RELATIVE_SPECIFIER_PATTERNS = [
  /\brequire\s*\(\s*["'](\.\.?\/[^"'\n]+)["']\s*\)/g,
  /\bimport\s*\(\s*["'](\.\.?\/[^"'\n]+)["']\s*\)/g,
  /\b(?:import|export)\s+[^"'\n]*?from\s+["'](\.\.?\/[^"'\n]+)["']/g,
  /\b(?:import|export)\s+["'](\.\.?\/[^"'\n]+)["']/g,
];
const MODULE_RESOLUTION_SUFFIXES = [
  "",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  "/index.js",
  "/index.mjs",
  "/index.cjs",
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
    ...tarSuspiciousEntryFindings(args.staged.suspiciousTarEntries, {
      fileDiff: args.fileDiff,
    }),
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
  for (const reachable of startupReachableFiles(manifest, files)) {
    if (!reachable.textSample) continue;
    const sample = reachable.textSample;
    const normalized = normalizeCodeForScanning(sample);
    // `remoteShell` is part of the execution leg, not an extra requirement:
    // `curl`/`wget`/`nc` used to live in `processExecution` and moved out with
    // the rules 1.19.0 split. Without it, an extension whose shell evidence is
    // `terminal.sendText("curl … | sh")` stopped satisfying this conjunction
    // and lost its critical finding.
    const processExecution =
      matches(JS_PATTERN_SET.processExecution, sample, normalized) ||
      matches(JS_PATTERN_SET.remoteShell, sample, normalized);
    const networkAccess = matches(JS_PATTERN_SET.networkAccess, sample, normalized);
    const dynamicEvaluation = matches(JS_PATTERN_SET.dynamicEvaluation, sample, normalized);
    if (!processExecution || !networkAccess || !dynamicEvaluation) continue;
    return vscodeTag("startupRemoteCommand", {
      severity: "critical",
      file: reachable.path,
      line: firstMatchingLine(sample, [
        ...JS_PATTERN_SET.processExecution,
        ...JS_PATTERN_SET.remoteShell,
        ...JS_PATTERN_SET.networkAccess,
        ...JS_PATTERN_SET.dynamicEvaluation,
      ]),
      evidence: `startup activation ${broadActivation} reaches network + decode/eval + process execution`,
      reason:
        "remote-command VS Code malware commonly activates on startup, fetches or decodes operator-controlled payloads, and executes shell commands",
    });
  }
  return null;
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
  const loader = startupReachableFiles(manifest, files).find(
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
  const unscoped =
    /(?:vscode\.)?workspace\.getConfiguration\s*\(\s*\)\s*\.get\s*\(\s*["']([^"']+\.[^"']+)["']/g;
  const direct = /(?:vscode\.)?workspace\.getConfiguration\s*\(\s*["']([^"']+\.[^"']+)["']\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = chained.exec(sample))) keys.add(`${match[1]}.${match[2]}`);
  while ((match = unscoped.exec(sample))) keys.add(match[1]);
  while ((match = direct.exec(sample))) keys.add(match[1]);
  return [...keys].sort();
}

function configurationKeyLinePattern(key: string): RegExp {
  const [namespace, leaf] = key.split(/\.(.*)/s);
  return new RegExp(
    `workspace\\.getConfiguration\\s*\\(\\s*(?:["']${escapeRegExp(namespace)}(?:\\.${escapeRegExp(
      leaf ?? "",
    )})?["']|\\)\\s*\\.get\\s*\\(\\s*["']${escapeRegExp(key)}["'])`,
  );
}

function isDeclaredConfigurationKey(key: string, declared: Set<string>): boolean {
  // A section-scoped read like getConfiguration("myExt.section") is declared
  // when any contributed property lives under that section.
  return declared.has(key) || [...declared].some((property) => property.startsWith(`${key}.`));
}

function isCommonConfigurationKey(key: string): boolean {
  const namespace = key.split(".")[0];
  return COMMON_VSCODE_CONFIGURATION_NAMESPACES.has(namespace);
}

function startupReachableFiles(
  manifest: Pick<VscodeExtensionManifest, "main" | "browser">,
  files: AcquiredArtifact["files"],
) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const queue = [
    ...entrypointCandidates(manifest.main),
    ...entrypointCandidates(manifest.browser),
  ].flatMap((path) => {
    const resolved = resolveModulePath(path, byPath);
    return resolved ? [resolved] : [];
  });
  const reachable: AcquiredArtifact["files"] = [];
  const seen = new Set<string>();

  while (queue.length) {
    const path = queue.shift();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const file = byPath.get(path);
    if (!file) continue;
    reachable.push(file);
    if (!file.textSample) continue;
    for (const specifier of relativeSpecifiers(file.textSample)) {
      const resolved = resolveModulePath(joinRelative(path, specifier), byPath);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }

  return reachable;
}

function entrypointCandidates(path: string | null): string[] {
  if (!path) return [];
  const normalized = path.replace(/^\.\//, "");
  const out = [normalized];
  if (!/\.[cm]?js$/i.test(normalized))
    out.push(`${normalized}.js`, `${normalized}.cjs`, `${normalized}.mjs`);
  return out;
}

function relativeSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of RELATIVE_SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveModulePath(
  candidate: string,
  byPath: Map<string, AcquiredArtifact["files"][number]>,
): string | null {
  const base = normalizePathSegments(candidate.replace(/^\.\//, ""));
  if (!base) return null;
  for (const suffix of MODULE_RESOLUTION_SUFFIXES) {
    const resolved = base + suffix;
    if (byPath.has(resolved)) return resolved;
  }
  return null;
}

function joinRelative(fromPath: string, specifier: string): string {
  const directory = fromPath.split("/").slice(0, -1).join("/");
  return directory ? `${directory}/${specifier}` : specifier;
}

function normalizePathSegments(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

function broadActivationEvent(events: string[]): string | null {
  return (
    events.find(
      (event) =>
        event === "*" || event === "onStartupFinished" || event.startsWith("workspaceContains:"),
    ) ?? null
  );
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
