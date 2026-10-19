import { firstMatchingCodeLine } from "../../platform/text-utils";
import type { Finding } from "../types";
import { firstJsonPropertyLine, tag } from "./helpers";
import { changedPrefix, type RuleContext } from "./context";
import { isDocumentationPath, isPythonMetadataPath, isTypeDeclarationPath } from "./file-types";
import {
  analyzeInstallWrites,
  findLinkCreation,
  type InstallWriteOrigin,
} from "./install-root-writes";
import { normalizeCodeForScanning } from "./normalize";
import { CONSUMER_INSTALL_LIFECYCLE_SCRIPTS } from "./patterns";
import { normalizeReachabilityPath } from "./reachability";

// Self-propagation: a payload that reaches the *next* artifact instead of only
// the machine it landed on. The other families answer "what can this package
// do to the consumer"; this one answers "can this package republish itself".
//
// Both signals are ordinary developer actions somewhere: a release CLI runs
// `npm publish`, a patch tool writes into `node_modules`. What has no benign
// reading is doing either one *during someone else's install*, so the whole
// family gates on `ctx.installReachable` rather than trying to separate the
// tools from the worm by pattern. That gate is also the coverage limit: a
// payload that propagates when the package is later imported, rather than when
// it is installed, is not modelled here.
export function propagationFindings(ctx: RuleContext): Finding[] {
  const findings = lifecycleCommandFindings(ctx);
  if (!ctx.installReachable.size) return findings;

  for (const file of ctx.files) {
    if (isDocumentationPath(file.path) || isTypeDeclarationPath(file.path)) continue;
    if (ctx.codePatternSet === "python" && isPythonMetadataPath(file.path)) continue;
    if (!ctx.installReachable.has(normalizeReachabilityPath(file.path))) continue;

    const sample = file.textSample || "";
    if (!sample) continue;
    const normalized = ctx.codePatternSet === "python" ? sample : normalizeCodeForScanning(sample);
    findings.push(
      ...propagationSourceFindings(ctx, {
        file: file.path,
        sample,
        normalized,
        prefix: changedPrefix(ctx, file.path),
        truncated: file.flags.includes("truncated"),
      }),
    );
  }
  return findings;
}

interface PropagationSource {
  file: string;
  sample: string;
  normalized: string;
  prefix: string;
  line?: number;
  command?: boolean;
  truncated?: boolean;
}

function lifecycleCommandFindings(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];
  const file = ctx.packageJsonFile?.path ?? "package.json";
  for (const script of CONSUMER_INSTALL_LIFECYCLE_SCRIPTS) {
    const command = ctx.scripts[script];
    if (!command || ctx.implicitScripts[script] === command) continue;
    findings.push(
      ...propagationSourceFindings(ctx, {
        file,
        sample: command,
        normalized: ctx.codePatternSet === "python" ? command : normalizeCodeForScanning(command),
        prefix: changedPrefix(ctx, file),
        line: firstJsonPropertyLine(ctx.packageJsonFile?.textSample, script, command),
        command: true,
      }),
    );
  }
  return findings;
}

function propagationSourceFindings(ctx: RuleContext, source: PropagationSource): Finding[] {
  const findings: Finding[] = [];
  const publish = matchLine(ctx.patterns.registryPublish, source.sample, source.normalized);
  if (publish) {
    findings.push(
      tag("propagationRegistryPublish", {
        severity: "critical",
        file: source.file,
        line: source.line ?? publish.line,
        evidence: `${source.prefix}registry publish on the consumer install path`,
        reason:
          "code that runs during a consumer's install invokes a registry publish, so installing this package can publish packages under whatever credentials the machine holds: the self-propagation step that turns a single compromised release into a worm",
        ...(publish.obfuscated ? { obfuscated: true } : {}),
      }),
    );
  }

  const mutation = packageMutation(ctx, source);
  if (mutation) {
    findings.push(
      tag("propagationPackageMutation", {
        severity: "high",
        file: source.file,
        line: source.line ?? mutation.line,
        evidence: `${source.prefix}install-time write into the dependency install root`,
        reason:
          "code that runs during a consumer's install writes into the directory the package manager unpacks dependencies into, so it can add hooks or payloads to packages the consumer already trusts",
        ...(mutation.obfuscated ? { obfuscated: true } : {}),
      }),
    );
  }
  return findings;
}

// Besides naming `node_modules` and the path climbs the evaluator sees
// (`climbLine`: a parent escape or another package's resolved path), the
// install root is reached through the module-lookup paths, the consumer's cwd
// or npm prefix, a `chdir`, or resolving a bare specifier against the
// importing module.
const JS_INSTALL_ROOT_REFERENCE_PATTERNS = [
  /\bmodule\s*\.\s*paths\b|\b_nodeModulePaths\b|\bglobalPaths\b/,
  /\bINIT_CWD\b|\bnpm_config_(?:local_)?prefix\b|\bnpm\s+(?:root|prefix)\b/,
  /\bchdir\s*\(|\b(?:cd|pushd)\s+["']?\.\.(?:[/\\\s"';&|]|$)/,
  /\bimport\.meta\s*\.\s*resolve\s*\(\s*(?!['"`]\.\.?[/\\'"`])/,
];
const JS_WRITE_CANDIDATE =
  /\b(?:writeFile|appendFile|outputFile|writeJson|writeJSON|outputJson|outputJSON|createWriteStream|copyFile|cp|copy|move|rename|link|symlink|ensureLink|ensureSymlink|open)(?:Sync)?\b|\b(?:exec|spawn|execFile|execa|execaCommand)(?:Sync)?\s*\(/;

// Naming node_modules and writing a file is every native-binary installer
// (esbuild installs its platform binary under its own `lib/` and renames it
// into `bin/`), so a JavaScript source fires only when some write's
// destination is not proven to stay in the package's own directory, a temp
// or the home directory (`analyzeInstallWrites`), and either the destination
// is concretely the install root, the file reaches for the install root, or
// it takes the destination from a sibling module that does.
// Lifecycle command lines are shell, not a JS file; a truncated sample may
// hide the sink; Python keeps the file-level co-occurrence.
function packageMutation(
  ctx: RuleContext,
  source: PropagationSource,
): { line: number | undefined; obfuscated: boolean } | null {
  const installRoot = matchLine(ctx.patterns.installRootPath, source.sample, source.normalized);
  if (ctx.codePatternSet === "python" || source.command || source.truncated) {
    const write = matchLine(ctx.patterns.installWrite, source.sample, source.normalized);
    if (!installRoot || !write) return null;
    return { line: installRoot.line, obfuscated: installRoot.obfuscated || write.obfuscated };
  }
  if (!JS_WRITE_CANDIDATE.test(source.sample) && !JS_WRITE_CANDIDATE.test(source.normalized)) {
    return null;
  }
  const origin = {
    filePath: source.file,
    packageName: ctx.packageJson?.name ?? null,
    packageMain: ctx.packageJson?.main ?? null,
  };
  const raw = analyzeInstallWrites(source.sample, origin);
  const folded =
    source.normalized !== source.sample && (!raw.unproven || raw.climbLine === undefined)
      ? analyzeInstallWrites(source.normalized, origin)
      : null;
  const verdict = raw.unproven || !folded ? raw : folded;
  const writeLine = verdict.line ?? raw.writeLine ?? folded?.writeLine;
  // A link anywhere in the package can redirect a write that is proven to
  // stay home, so it voids the proof and is itself the install-root reference.
  const link = verdict.unproven || writeLine !== undefined ? packageLinkCreation(ctx) : null;
  if (!verdict.unproven && !link) return null;
  const climb =
    raw.climbLine !== undefined
      ? { line: raw.climbLine, obfuscated: false }
      : folded?.climbLine !== undefined
        ? { line: folded.climbLine, obfuscated: true }
        : null;
  if (installRoot)
    return { line: installRoot.line ?? verdict.line, obfuscated: installRoot.obfuscated };
  if (verdict.intoInstallRoot) return { line: verdict.line, obfuscated: false };
  const reference =
    climb ?? matchLine(JS_INSTALL_ROOT_REFERENCE_PATTERNS, source.sample, source.normalized);
  if (reference) {
    return { line: reference.line ?? verdict.line, obfuscated: reference.obfuscated };
  }
  if (link) return { line: writeLine, obfuscated: false };
  if (
    verdict.importedFrom.some((specifier) =>
      importReachesInstallRoot(ctx, source.file, specifier, origin),
    )
  ) {
    return { line: verdict.line, obfuscated: false };
  }
  return null;
}

const LINK_SCAN_PATH = /\.(?:[cm]?jsx?|[cm]?tsx?|sh|bash|zsh|command)$/i;
const linkCreationCache = new WeakMap<RuleContext, { file: string; line?: number } | null>();

// Where the package first creates a link: any code file or lifecycle script,
// install-reachable or not, since reachability is only approximated. A code
// file whose text was not sampled in full counts, because the link could be
// in the part that was not read.
function packageLinkCreation(ctx: RuleContext): { file: string; line?: number } | null {
  if (linkCreationCache.has(ctx)) return linkCreationCache.get(ctx) ?? null;
  const origin = {
    filePath: "package.json",
    packageName: ctx.packageJson?.name ?? null,
    packageMain: ctx.packageJson?.main ?? null,
  };
  let found: { file: string; line?: number } | null = null;
  for (const command of [...Object.values(ctx.scripts), ...Object.values(ctx.implicitScripts)]) {
    if (findLinkCreation(command, origin) !== null) {
      found = { file: ctx.packageJsonFile?.path ?? "package.json" };
      break;
    }
  }
  for (const file of found ? [] : ctx.files) {
    const shebang = file.textSample?.startsWith("#!") ?? false;
    const code =
      (LINK_SCAN_PATH.test(file.path) || shebang) &&
      !isTypeDeclarationPath(file.path) &&
      !isDocumentationPath(file.path);
    if (!code || ctx.diffByPath.get(file.path)?.status === "removed") continue;
    if (!file.textSample || file.flags.includes("truncated")) {
      found = { file: file.path };
      break;
    }
    const fileOrigin = { ...origin, filePath: file.path };
    const normalized = normalizeCodeForScanning(file.textSample);
    const line =
      findLinkCreation(file.textSample, fileOrigin) ??
      (normalized !== file.textSample ? findLinkCreation(normalized, fileOrigin) : null);
    if (line !== null) {
      found = { file: file.path, line };
      break;
    }
  }
  linkCreationCache.set(ctx, found);
  return found;
}

const MODULE_SUFFIXES = ["", ".js", ".cjs", ".mjs", "/index.js", "/index.cjs", "/index.mjs"];

function importReachesInstallRoot(
  ctx: RuleContext,
  from: string,
  specifier: string,
  origin: InstallWriteOrigin,
): boolean {
  const segments = from.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment && segment !== ".") segments.push(segment);
  }
  const base = segments.join("/");
  const target = MODULE_SUFFIXES.map((suffix) => `${base}${suffix}`);
  const file = ctx.files.find((candidate) => target.includes(candidate.path));
  if (!file?.textSample) return false;
  const normalized = normalizeCodeForScanning(file.textSample);
  if (
    matchLine(ctx.patterns.installRootPath, file.textSample, normalized) ||
    matchLine(JS_INSTALL_ROOT_REFERENCE_PATTERNS, file.textSample, normalized)
  ) {
    return true;
  }
  const sibling = { ...origin, filePath: file.path };
  return (
    analyzeInstallWrites(file.textSample, sibling).climbLine !== undefined ||
    (normalized !== file.textSample &&
      analyzeInstallWrites(normalized, sibling).climbLine !== undefined)
  );
}

// Matches the capability rules' contract: scan the literal text first so the
// evidence line points at real source, fall back to the constant-folded text,
// and remember when only the folded text matched — assembling `npm pub` +
// `lish` at runtime is itself a malice signal the risk layer reads.
function matchLine(
  patterns: RegExp[],
  sample: string,
  normalized: string,
): { line: number | undefined; obfuscated: boolean } | null {
  const line = firstMatchingCodeLine(sample, patterns);
  if (line !== undefined) return { line, obfuscated: false };
  if (normalized === sample) return null;
  const normalizedLine = firstMatchingCodeLine(normalized, patterns);
  return normalizedLine === undefined ? null : { line: normalizedLine, obfuscated: true };
}
