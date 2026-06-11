import { hasImplicitNodeGypInstall, isRootGypPath } from "../tar-parser.js";
import { firstMatchingLine } from "../text-utils";
import type { Finding } from "../review";
import { LIFECYCLE_SCRIPTS } from "./patterns";
import { firstJsonPropertyLine, tag } from "./helpers";
import { changedPrefix, type RuleContext } from "./context";
import { isDocumentationPath, isTypeDeclarationPath } from "./file-types";
import { normalizeCodeForScanning } from "./normalize";

const GYP_PACKAGE_JAVASCRIPT_COMMAND_PATTERNS = [
  /<!@?\([^)\n]*\bnode\b(?:\s+--[^\s'")]+)*\s+["']?(?:\.\/)?[\w@./-]+\.(?:cjs|mjs|js)["']?/i,
  /<!@?\([^)\n]*\bbun\b(?:\s+run)?\s+["']?(?:\.\/)?[\w@./-]+\.(?:cjs|mjs|js|ts)["']?/i,
];

// Install lifecycle hooks and in-file code-execution capability: the scripts and
// code paths that run on, or are pulled in by, a consumer install.
export function scriptFindings(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];

  const implicitNodeGyp =
    ctx.implicitScripts.install === "node-gyp rebuild" ||
    hasImplicitNodeGypInstall(ctx.files, ctx.packageJson);
  if (implicitNodeGyp) {
    findings.push(
      tag("installScriptImplicitNodeGyp", {
        severity: "high",
        file: ctx.rootGypFile?.path ?? ctx.packageJsonFile?.path ?? "package.json",
        line: ctx.rootGypFile
          ? 1
          : firstJsonPropertyLine(ctx.packageJsonFile?.textSample, "gypfile"),
        evidence: "implicit install: node-gyp rebuild",
        reason: ctx.rootGypFile
          ? "npm defaults install to node-gyp rebuild when a root *.gyp file exists and no install/preinstall script or gypfile=false is declared"
          : "npm staged metadata reports the default node-gyp install hook; the source root had a *.gyp file even if that file is not present in the packed tarball",
      }),
    );
  }

  for (const file of ctx.files) {
    if (!isRootGypPath(file.path)) continue;
    const line = firstMatchingLine(file.textSample, GYP_PACKAGE_JAVASCRIPT_COMMAND_PATTERNS);
    if (line === undefined) continue;
    findings.push(
      tag("installScriptGypCommandSubstitution", {
        severity: "critical",
        file: file.path,
        line,
        evidence: "gyp command substitution executes package JavaScript",
        reason:
          "GYP command substitutions run shell commands during node-gyp configure; in a root gyp file this is an install-time execution path outside package.json lifecycle scripts",
      }),
    );
  }

  for (const script of LIFECYCLE_SCRIPTS) {
    if (!ctx.scripts[script] || ctx.implicitScripts[script] === ctx.scripts[script]) continue;
    findings.push(
      tag(script === "preinstall" ? "installScriptPreinstall" : "installScript", {
        severity: script === "preinstall" ? "critical" : "high",
        file: ctx.packageJsonFile?.path ?? "package.json",
        line: firstJsonPropertyLine(ctx.packageJsonFile?.textSample, script, ctx.scripts[script]),
        evidence: `${script}: ${ctx.scripts[script]}`,
        reason: "install lifecycle hooks execute on consumer machines",
      }),
    );
  }

  for (const file of ctx.files) {
    if (isDocumentationPath(file.path) || isTypeDeclarationPath(file.path)) continue;

    const sample = file.textSample || "";
    // Constant-fold runtime-assembled identifiers (`'chi'+'ld_process'`,
    // `globalThis['re'+'quire']`) so the literal regex set sees them. Matching
    // both raw and normalized text means folding can only add detections, never
    // drop one a literal scan already finds. JavaScript only for now; the
    // normalizer is JS-flavored and Python evasion is out of scope.
    const normalized = ctx.codePatternSet === "python" ? sample : normalizeCodeForScanning(sample);
    const prefix = changedPrefix(ctx, file.path);
    const changed = ctx.diffByPath.get(file.path)?.status;
    const lifecycleScriptFile = isLifecycleScriptFile(ctx, file.path);

    const processExecution = matchCategory(ctx.patterns.processExecution, sample, normalized);
    const networkAccess = matchCategory(ctx.patterns.networkAccess, sample, normalized);
    const dynamicEvaluation = matchCategory(ctx.patterns.dynamicEvaluation, sample, normalized);
    const credentialAccess = matchCategory(ctx.patterns.credentialAccess, sample, normalized);
    const adjacentExecutionRisk =
      processExecution.matched || dynamicEvaluation.matched || credentialAccess.matched;

    if (processExecution.matched) {
      findings.push(
        tag("codeProcessExecution", {
          severity: "high",
          file: file.path,
          line: processExecution.line,
          evidence: `${prefix}process or shell execution`,
          reason: "package may execute arbitrary commands",
          ...(processExecution.obfuscated ? { obfuscated: true } : {}),
        }),
      );
    }
    if (
      (changed !== "unchanged" || lifecycleScriptFile || adjacentExecutionRisk) &&
      networkAccess.matched
    ) {
      findings.push(
        tag("codeNetworkAccess", {
          severity: networkAccessSeverity(changed, lifecycleScriptFile, adjacentExecutionRisk),
          file: file.path,
          line: networkAccess.line,
          evidence: `${prefix}network-capable code path`,
          reason:
            "unexpected network access in package code can be used for exfiltration or staged payload retrieval",
          ...(networkAccess.obfuscated ? { obfuscated: true } : {}),
        }),
      );
    }
    if (dynamicEvaluation.matched) {
      findings.push(
        tag("codeDynamicEvaluation", {
          severity: changed === "added" ? "high" : "medium",
          file: file.path,
          line: dynamicEvaluation.line,
          evidence: `${prefix}dynamic code or obfuscation primitive`,
          reason: "common malware and obfuscation technique",
          ...(dynamicEvaluation.obfuscated ? { obfuscated: true } : {}),
        }),
      );
    }
    if (credentialAccess.matched) {
      // A single file that both reads credentials and can reach the network is a
      // source→sink exfiltration chain: collect-then-exfil live together, so it
      // is high regardless of whether the file is newly added or a modification
      // to an existing module (the shape behind file-based credential stealers).
      // Credential access on its own stays high only when added.
      const exfiltrationSink = networkAccess.matched;
      findings.push(
        tag("codeCredentialAccess", {
          severity: changed === "added" || exfiltrationSink ? "high" : "medium",
          file: file.path,
          line: credentialAccess.line,
          evidence: exfiltrationSink
            ? `${prefix}credential read paired with network egress`
            : `${prefix}secret/environment access`,
          reason: exfiltrationSink
            ? "package reads credentials and has a network egress path in the same file: the collect-and-exfiltrate shape used to steal install-time and cloud secrets"
            : "package may read credentials from the install environment",
          ...(credentialAccess.obfuscated ? { obfuscated: true } : {}),
        }),
      );
    }
  }

  return findings;
}

// Match a capability category against the raw sample and, only if that misses,
// the constant-folded text. Prefers the raw line so evidence keeps pointing at
// the literal match when one exists; folding preserves line numbers, so the
// normalized line still maps to the real source line. `obfuscated` is set when
// the match came only from the folded text — i.e. the identifier was assembled
// (`['chi','ld_pro','cess'].join('')`) — which the risk roll-up treats as a
// co-occurring malice signal.
function matchCategory(
  patterns: RegExp[],
  sample: string,
  normalized: string,
): { matched: boolean; line: number | undefined; obfuscated: boolean } {
  const line = firstMatchingLine(sample, patterns);
  if (line !== undefined) return { matched: true, line, obfuscated: false };
  if (normalized !== sample) {
    const normalizedLine = firstMatchingLine(normalized, patterns);
    if (normalizedLine !== undefined)
      return { matched: true, line: normalizedLine, obfuscated: true };
  }
  return { matched: false, line: undefined, obfuscated: false };
}

function networkAccessSeverity(
  changed: RuleContext["diff"][number]["status"] | undefined,
  lifecycleScriptFile: boolean,
  adjacentExecutionRisk: boolean,
): Finding["severity"] {
  return changed === "added" && (lifecycleScriptFile || adjacentExecutionRisk) ? "high" : "medium";
}

function isLifecycleScriptFile(ctx: RuleContext, path: string): boolean {
  const candidates = scriptPathCandidates(path);
  return LIFECYCLE_SCRIPTS.some((script) => {
    const command = ctx.scripts[script];
    if (!command || ctx.implicitScripts[script] === command) return false;
    return scriptCommandTokens(command).some((token) => candidates.has(token));
  });
}

function scriptPathCandidates(path: string): Set<string> {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const withoutPackage = normalized.startsWith("package/")
    ? normalized.slice("package/".length)
    : normalized;
  const basename = withoutPackage.split("/").at(-1) ?? withoutPackage;
  const baseValues = [normalized, withoutPackage, basename];
  const values = [...baseValues];
  for (const value of baseValues) {
    values.push(value.replace(/\.[^/.]+$/, ""));
  }
  return new Set(values.filter(Boolean));
}

function scriptCommandTokens(command: string): string[] {
  return [...command.matchAll(/(?:\.\/)?[\w@./-]+(?:\.[\w-]+)?\b/g)].map((match) =>
    match[0].replace(/^\.\//, ""),
  );
}
