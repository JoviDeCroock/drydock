import { hasImplicitNodeGypInstall, isRootGypPath } from "../tar-parser.js";
import { firstMatchingLine, firstMatchingSourceLine } from "../text-utils";
import type { Finding } from "../review";
import { CONSUMER_INSTALL_LIFECYCLE_SCRIPTS } from "./patterns";
import { firstJsonPropertyLine, tag } from "./helpers";
import { changedPrefix, isUnreachableTestFile, type RuleContext } from "./context";
import { isDocumentationPath, isTypeDeclarationPath } from "./file-types";
import { scriptCommandTokens, scriptPathCandidates } from "./reachability";
import { normalizeCodeForScanning } from "./normalize";

const GYP_PACKAGE_JAVASCRIPT_COMMAND_PATTERNS = [
  /<!@?\([^)\n]*\bnode\b(?:\s+--[^\s'")]+)*\s+["']?(?:\.\/)?[\w@./-]+\.(?:cjs|mjs|js)["']?/i,
  /<!@?\([^)\n]*\bbun\b(?:\s+run)?\s+["']?(?:\.\/)?[\w@./-]+\.(?:cjs|mjs|js|ts)["']?/i,
];
const COMMON_JS_ENV_NAMES = [
  "BASE_URL",
  "BABEL_ENV",
  "CI",
  "DEBUG",
  "DEV",
  "LANG",
  "LC_ALL",
  "MODE",
  "NODE_DEBUG",
  "NODE_ENV",
  "PROD",
  "SSR",
  "TZ",
];
// npm exports these onto every lifecycle-script process; they only describe the
// running npm invocation and the package's own manifest, never secrets.
// npm_config_* is deliberately excluded: it can carry live registry auth
// (npm_config__authToken) and stays covered by the credential patterns.
const NPM_LIFECYCLE_ENV_NAMES = [
  "npm_command",
  "npm_execpath",
  "npm_lifecycle_event",
  "npm_lifecycle_script",
  "npm_node_execpath",
  "npm_package_json",
  "npm_package_name",
  "npm_package_version",
];
const COMMON_JS_ENV_NAME_PATTERN = [...COMMON_JS_ENV_NAMES, ...NPM_LIFECYCLE_ENV_NAMES]
  .map(escapeRegex)
  .join("|");
const COMMON_PROCESS_ENV_DOT_ACCESS = new RegExp(
  `\\bprocess\\.env\\s*\\.\\s*(?:${COMMON_JS_ENV_NAME_PATTERN})\\b`,
  "g",
);
const COMMON_PROCESS_ENV_BRACKET_ACCESS = new RegExp(
  `\\bprocess\\.env\\s*\\[\\s*(['"\`])(?:${COMMON_JS_ENV_NAME_PATTERN})\\1\\s*\\]`,
  "g",
);
const COMMON_IMPORT_META_ENV_DOT_ACCESS = new RegExp(
  `\\bimport\\s*\\.\\s*meta\\s*\\.\\s*env\\s*\\.\\s*(?:${COMMON_JS_ENV_NAME_PATTERN})\\b`,
  "g",
);
const COMMON_IMPORT_META_ENV_BRACKET_ACCESS = new RegExp(
  `\\bimport\\s*\\.\\s*meta\\s*\\.\\s*env\\s*\\[\\s*(['"\`])(?:${COMMON_JS_ENV_NAME_PATTERN})\\1\\s*\\]`,
  "g",
);
// javascript-obfuscator-style output commonly wraps a hexadecimal identifier
// lookup in a self-rotating string table. Individual names can remain opaque to
// the bounded constant folder, but the wrapper itself is a strong evasion
// signal. Require the whole shape so ordinary minified identifiers, loops, or
// queue rotation do not mark otherwise plain code as obfuscated.
const ROTATING_STRING_TABLE_SIGNALS = [
  /\b_0x[\da-f]{4,}\b/i,
  /\bfunction\s+_0x[\da-f]{3,}\s*\(/i,
  /\bwhile\s*\(\s*!!\[\]\s*\)/,
  /\bparseInt\s*\(\s*_0x[\da-f]+\s*\(/i,
  /\[['"]push['"]\]\s*\(/,
  /\[['"]shift['"]\]\s*\(\s*\)/,
];
const ROTATING_STRING_TABLE_SIGNAL_THRESHOLD = 5;

// Install lifecycle hooks and in-file code-execution capability: the scripts and
// code paths that run on, or are pulled in by, a registry tarball install.
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

  for (const script of CONSUMER_INSTALL_LIFECYCLE_SCRIPTS) {
    if (!ctx.scripts[script] || ctx.implicitScripts[script] === ctx.scripts[script]) continue;
    findings.push(
      tag(script === "preinstall" ? "installScriptPreinstall" : "installScript", {
        severity: script === "preinstall" ? "critical" : "high",
        file: ctx.packageJsonFile?.path ?? "package.json",
        line: firstJsonPropertyLine(ctx.packageJsonFile?.textSample, script, ctx.scripts[script]),
        evidence: `${script}: ${ctx.scripts[script]}`,
        reason: "consumer install lifecycle hooks execute on consumer machines",
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
    const packedObfuscation =
      ctx.codePatternSet !== "python" && hasRotatingStringTableObfuscation(sample);
    const prefix = changedPrefix(ctx, file.path);
    const changed = ctx.diffByPath.get(file.path)?.status;
    const lifecycleScriptFile = isLifecycleScriptFile(ctx, file.path);
    // Consumer install lifecycle script files keep full severity even under
    // test/ — an install hook pointing into the test tree is itself suspicious.
    const testScoped = !lifecycleScriptFile && isUnreachableTestFile(ctx, file.path);

    const processExecution = matchCategory(
      ctx.patterns.processExecution,
      sample,
      normalized,
      packedObfuscation,
    );
    const networkAccess = matchCategory(
      ctx.patterns.networkAccess,
      sample,
      normalized,
      packedObfuscation,
    );
    const dynamicEvaluation = matchCategory(
      ctx.patterns.dynamicEvaluation,
      sample,
      normalized,
      packedObfuscation,
      true,
    );
    const credentialSample =
      ctx.codePatternSet === "python" ? sample : omitCommonEnvironmentAccesses(sample);
    const credentialNormalized =
      ctx.codePatternSet === "python" ? normalized : omitCommonEnvironmentAccesses(normalized);
    const credentialAccess = matchCategory(
      ctx.patterns.credentialAccess,
      credentialSample,
      credentialNormalized,
      packedObfuscation,
    );
    const adjacentExecutionRisk =
      processExecution.matched || dynamicEvaluation.matched || credentialAccess.matched;

    if (processExecution.matched) {
      findings.push(
        testScope(
          testScoped,
          processExecution.obfuscated,
          tag("codeProcessExecution", {
            severity: "high",
            file: file.path,
            line: processExecution.line,
            evidence: `${prefix}process or shell execution`,
            reason: "package may execute arbitrary commands",
            ...(processExecution.obfuscated ? { obfuscated: true } : {}),
          }),
        ),
      );
    }
    if (
      (changed !== "unchanged" || lifecycleScriptFile || adjacentExecutionRisk) &&
      networkAccess.matched
    ) {
      findings.push(
        testScope(
          testScoped,
          networkAccess.obfuscated,
          tag("codeNetworkAccess", {
            severity: networkAccessSeverity(changed, lifecycleScriptFile, adjacentExecutionRisk),
            file: file.path,
            line: networkAccess.line,
            evidence: `${prefix}network-capable code path`,
            reason:
              "unexpected network access in package code can be used for exfiltration or staged payload retrieval",
            ...(networkAccess.obfuscated ? { obfuscated: true } : {}),
          }),
        ),
      );
    }
    if (dynamicEvaluation.matched) {
      findings.push(
        testScope(
          testScoped,
          dynamicEvaluation.obfuscated,
          tag("codeDynamicEvaluation", {
            severity: changed === "added" ? "high" : "medium",
            file: file.path,
            line: dynamicEvaluation.line,
            evidence: `${prefix}dynamic code or obfuscation primitive`,
            reason: "common malware and obfuscation technique",
            ...(dynamicEvaluation.obfuscated ? { obfuscated: true } : {}),
          }),
        ),
      );
    }
    if (credentialAccess.matched) {
      // A single file that both reads credentials and can reach the network is a
      // source→sink exfiltration chain: collect-then-exfil live together, so it
      // is high regardless of whether the file is newly added or a modification
      // to an existing module (the shape behind file-based credential stealers).
      // Credential access on its own stays high only when added.
      const exfiltrationSink = networkAccess.matched;
      // A same-file credential→network chain stays full severity even in a
      // test tree: collect-and-exfiltrate is the payload shape itself, not an
      // expected test-suite capability.
      findings.push(
        testScope(
          testScoped && !exfiltrationSink,
          credentialAccess.obfuscated,
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
        ),
      );
    }
  }

  return findings;
}

const DEMOTED_SEVERITY: Partial<Record<Finding["severity"], Finding["severity"]>> = {
  critical: "high",
  high: "medium",
  medium: "low",
};

// Demote a capability finding that lives in an unreachable test file by one
// severity step and mark it test-scoped so the risk roll-up can keep it out of
// the capability co-occurrence escalation. Obfuscated matches keep full
// severity: hiding an identifier inside a test file is still a malice signal.
function testScope(testScoped: boolean, obfuscated: boolean, finding: Finding): Finding {
  if (!testScoped || obfuscated) return finding;
  return {
    ...finding,
    severity: DEMOTED_SEVERITY[finding.severity] ?? finding.severity,
    evidence: `test-scoped ${finding.evidence}`,
    testScoped: true,
  };
}

// Match a capability category against the raw sample and, only if that misses,
// the constant-folded text. Prefers the raw line so evidence keeps pointing at
// the literal match when one exists; folding preserves line numbers, so the
// normalized line still maps to the real source line. `obfuscated` is set when
// the match came only from folded text or its containing file has a recognized
// packed string-table wrapper. Either evasion technique is a co-occurring
// malice signal in the risk roll-up.
function matchCategory(
  patterns: RegExp[],
  sample: string,
  normalized: string,
  sourceObfuscated = false,
  matchAcrossLines = false,
): { matched: boolean; line: number | undefined; obfuscated: boolean } {
  const findLine = matchAcrossLines ? firstMatchingSourceLine : firstMatchingLine;
  const line = findLine(sample, patterns);
  if (line !== undefined) return { matched: true, line, obfuscated: sourceObfuscated };
  if (normalized !== sample) {
    const normalizedLine = findLine(normalized, patterns);
    if (normalizedLine !== undefined)
      return { matched: true, line: normalizedLine, obfuscated: true };
  }
  return { matched: false, line: undefined, obfuscated: false };
}

function hasRotatingStringTableObfuscation(source: string): boolean {
  let matches = 0;
  for (const signal of ROTATING_STRING_TABLE_SIGNALS) {
    if (signal.test(source)) matches += 1;
  }
  return matches >= ROTATING_STRING_TABLE_SIGNAL_THRESHOLD;
}

function omitCommonEnvironmentAccesses(source: string): string {
  return source
    .replace(COMMON_PROCESS_ENV_DOT_ACCESS, eraseKeepingNewlines)
    .replace(COMMON_PROCESS_ENV_BRACKET_ACCESS, eraseKeepingNewlines)
    .replace(COMMON_IMPORT_META_ENV_DOT_ACCESS, eraseKeepingNewlines)
    .replace(COMMON_IMPORT_META_ENV_BRACKET_ACCESS, eraseKeepingNewlines);
}

// The access regexes' \s* can span newlines (`process.env\n  .npm_command`), so
// erasing a match outright would shrink the line count and point every later
// finding — and the release-delta changed-line check that consumes finding.line
// — one line early. Keep the match's newlines so line numbers stay stable.
function eraseKeepingNewlines(match: string): string {
  return match.replace(/[^\n]+/g, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  return CONSUMER_INSTALL_LIFECYCLE_SCRIPTS.some((script) => {
    const command = ctx.scripts[script];
    if (!command || ctx.implicitScripts[script] === command) return false;
    return scriptCommandTokens(command).some((token) => candidates.has(token));
  });
}
