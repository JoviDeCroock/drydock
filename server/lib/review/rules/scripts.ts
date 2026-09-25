import { hasImplicitNodeGypInstall, isRootGypPath } from "../../tar-parser.js";
import {
  firstMatchingCodeLine,
  firstMatchingLine,
  firstMatchingSourceLine,
} from "../../platform/text-utils";
import type { Finding } from "../types";
import {
  CONSUMER_INSTALL_LIFECYCLE_SCRIPTS,
  omitGlobalObjectShims,
  SHELL_DOWNLOAD_EXECUTE_PATTERN_SET,
  SHELL_NETWORK_TOOL_PATTERN_SET,
} from "./patterns";
import { firstJsonPropertyLine, tag, testScope } from "./helpers";
import { changedPrefix, isUnreachableTestFile, type RuleContext } from "./context";
import {
  isBuildInfrastructurePath,
  isDocumentationPath,
  isJsonDataPath,
  isLoadableDataPath,
  isMarkupPath,
  isPythonMetadataPath,
  isTypeDeclarationPath,
  markupHidesScript,
  markupScriptText,
} from "./file-types";
import {
  normalizeReachabilityPath,
  scriptCommandTokens,
  scriptPathCandidates,
} from "./reachability";
import { normalizeCodeForScanning } from "./normalize";

const GYP_PACKAGE_JAVASCRIPT_COMMAND_PATTERNS = [
  /<!@?\([^)\n]*\bnode\b(?:\s+--[^\s'")]+)*\s+["']?(?:\.\/)?[\w@./-]+\.(?:cjs|mjs|js)["']?/i,
  /<!@?\([^)\n]*\bbun\b(?:\s+run)?\s+["']?(?:\.\/)?[\w@./-]+\.(?:cjs|mjs|js|ts)["']?/i,
];
const COMMON_JS_ENV_NAMES = [
  "BASE_URL",
  "BABEL_ENV",
  "CI",
  "COLORTERM",
  "DEBUG",
  "DEV",
  "FORCE_COLOR",
  "LANG",
  "LC_ALL",
  "MODE",
  "NO_COLOR",
  "NODE_DEBUG",
  "NODE_DISABLE_COLORS",
  "NODE_ENV",
  "PROD",
  "SSR",
  "TERM",
  "TERM_PROGRAM",
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
// `JAVA_HOME`, `HADOOP_HOME`, `ANDROID_HOME`: tool install locations, not
// credentials. Bare `HOME` stays counted; it is how a stealer finds dotfiles.
const LOCATION_ENV_NAME_PATTERN = "[A-Z][A-Z0-9_]*_HOME";
const COMMON_JS_ENV_NAME_PATTERN = [
  ...[...COMMON_JS_ENV_NAMES, ...NPM_LIFECYCLE_ENV_NAMES].map(escapeRegex),
  LOCATION_ENV_NAME_PATTERN,
].join("|");
// `\??\.` also covers optional chaining (`process.env?.NODE_ENV`).
const COMMON_PROCESS_ENV_DOT_ACCESS = new RegExp(
  `\\bprocess\\.env\\s*\\??\\.\\s*(?:${COMMON_JS_ENV_NAME_PATTERN})\\b`,
  "g",
);
// TypeScript's lowering of `process?.env?.NODE_ENV` without a temporary:
// `(null == process ? void 0 : process.env)?.NODE_ENV`. The ternary prefix is
// required so an assignment alias (`(e = process.env).NODE_ENV`) still counts.
const COMMON_PROCESS_ENV_TERNARY_ACCESS = new RegExp(
  String.raw`\?\s*void 0\s*:\s*process\.env\s*\)\s*\??\.\s*(?:${COMMON_JS_ENV_NAME_PATTERN})\b`,
  "g",
);
// Uses of `process.env` that read no value: a presence test (`'CI' in
// process.env`, any name, since the value still needs a separate read) and an
// existence guard (`process.env && process.env.NODE_DEBUG`). Whatever the guard
// protects is judged on its own.
const PROCESS_ENV_MEMBERSHIP_TEST = /(['"`])[A-Za-z_][A-Za-z0-9_]*\1\s+in\s+process\.env\b/g;
const PROCESS_ENV_EXISTENCE_GUARD = /\bprocess\.env\s*&&/g;
// Babel/TypeScript lower `process?.env?.NODE_ENV` through a temporary:
// `null==(t=null==process?void 0:process.env)?void 0:t.NODE_ENV`, or TS's
// `(_a = process === null || process === void 0 ? void 0 : process.env) === null
// || _a === void 0 ? void 0 : _a.NODE_ENV`. Only that exact lowering, with the
// temporary read for a well-known name, is erased. A later reuse of the same
// temporary is not tracked; `process?.env.X` has never matched this rule at all,
// so this lowers no bar an author faces.
const COMMON_PROCESS_ENV_DOWNLEVEL_ACCESS = new RegExp(
  String.raw`\(\s*([A-Za-z_$][\w$]*)\s*=\s*(?:null\s*==\s*process|process\s*===\s*null\s*\|\|\s*process\s*===\s*void 0)\s*\?\s*void 0\s*:\s*process\.env\s*\)\s*(?:===\s*null\s*\|\|\s*\1\s*===\s*void 0\s*)?\?\s*void 0\s*:\s*\1\s*\.\s*(?:${COMMON_JS_ENV_NAME_PATTERN})\b`,
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

  const loadCallNames = codeLoadCallNames(ctx);
  for (const file of ctx.files) {
    if (
      isDocumentationPath(file.path) ||
      isTypeDeclarationPath(file.path) ||
      isJsonDataPath(file.path)
    ) {
      continue;
    }
    if (ctx.codePatternSet === "python" && isPythonMetadataPath(file.path)) continue;
    // Data and markup formats are text until something can load them as code.
    const loadedAsCode =
      (isLoadableDataPath(file.path) || isMarkupPath(file.path)) &&
      isLoadedAsCode(ctx, file.path, loadCallNames);
    if (isLoadableDataPath(file.path) && !loadedAsCode) continue;

    // Character references that spell code in a script-capable attribute are
    // themselves staging: the whole file is scanned and a decode in it counts.
    const markupHidingScript = isMarkupPath(file.path) && markupHidesScript(file.textSample || "");
    const sample =
      isMarkupPath(file.path) && !loadedAsCode && !markupHidingScript
        ? markupScriptText(file.textSample || "")
        : file.textSample || "";
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
    // Comment-blind: a shell command quoted in prose is documentation. See
    // `firstMatchingCodeLine`. Download-and-execute below keeps the ordinary
    // matcher, because `curl … | bash` shipped as an instruction still tells
    // someone to run it — but only outside build infrastructure (below).
    const remoteShell = matchCategory(
      ctx.patterns.remoteShell,
      sample,
      normalized,
      packedObfuscation,
      false,
      true,
    );
    const downloadExecute = matchCategory(
      SHELL_DOWNLOAD_EXECUTE_PATTERN_SET,
      sample,
      normalized,
      packedObfuscation,
    );
    // A shell network tool is a real egress sink, so it counts as network access
    // for the credential collect-and-exfiltrate chain below even though the
    // in-language network patterns cannot see it.
    const shellNetworkTool = matchCategory(
      SHELL_NETWORK_TOOL_PATTERN_SET,
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
    const dynamicSample = ctx.codePatternSet === "python" ? sample : omitGlobalObjectShims(sample);
    const dynamicNormalized =
      ctx.codePatternSet === "python" ? normalized : omitGlobalObjectShims(normalized);
    // Decoding (`atob`, base64 `Buffer.from`) only counts in a file that can act
    // on what it decodes: run it, send it (node-ipc hid its geolocation host
    // that way), or stage it through a compiler, loader or file write (see
    // `decodedPayloadSink`). On its own it is a byte codec or a data table.
    const dynamicEvaluation =
      matchCategory(
        ctx.patterns.dynamicExecution,
        dynamicSample,
        dynamicNormalized,
        packedObfuscation,
        true,
      ).matched ||
      processExecution.matched ||
      networkAccess.matched ||
      shellNetworkTool.matched ||
      markupHidingScript ||
      matchCategory(ctx.patterns.decodedPayloadSink, dynamicSample, dynamicNormalized, false, true)
        .matched
        ? matchCategory(
            ctx.patterns.dynamicEvaluation,
            dynamicSample,
            dynamicNormalized,
            packedObfuscation,
            true,
          )
        : NO_MATCH;
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
      processExecution.matched ||
      shellNetworkTool.matched ||
      dynamicEvaluation.matched ||
      credentialAccess.matched;

    // A shell command is only a capability if something in reach can run it.
    // Requiring a spawn API in the same file, or a lifecycle hook pointing at
    // it, keeps the dropper shape; `remoteShell` is additionally comment-blind
    // so an SDK documenting its HTTP API (`// equivalent to: curl -X POST …`)
    // never reaches here on prose alone.
    //
    // Download-and-execute normally skips that requirement: `curl … | bash` has
    // no benign reading, and a package shipping that line as an instruction is
    // still telling someone to run it. Build infrastructure is the exception —
    // a Dockerfile's `RUN curl … | bash` or a workflow's `- run: curl … | sh`
    // runs on a CI runner at build time, never on a consumer's install, and
    // every mainstream toolchain documents exactly that idiom. Withholding the
    // exemption there leaves the ordinary executor requirement, which those
    // files do not satisfy.
    const buildInfrastructure = isBuildInfrastructurePath(file.path);
    // Build infrastructure keeps neither the exemption nor the critical tier:
    // the same `curl … | bash` that is a dropper in a lifecycle script is a
    // documented bootstrap step in a Dockerfile.
    const downloadExecuteCapability = downloadExecute.matched && !buildInfrastructure;
    const shellExecutable =
      processExecution.matched || lifecycleScriptFile || downloadExecuteCapability;
    if (remoteShell.matched && shellExecutable) {
      findings.push(
        testScope(
          testScoped,
          remoteShell.obfuscated,
          tag("codeRemoteShell", {
            // Download-and-execute has no benign reading; a bare shell tool
            // paired with a spawn API does, so it sits one step below.
            severity: downloadExecuteCapability ? "critical" : "high",
            file: file.path,
            line: downloadExecuteCapability ? downloadExecute.line : remoteShell.line,
            evidence: downloadExecuteCapability
              ? `${prefix}shell command downloads and executes remote code`
              : `${prefix}shell command with network or inline-interpreter capability`,
            reason: downloadExecuteCapability
              ? "the command fetches code over the network and passes it to an interpreter, so the package runs bytes it never shipped and no reviewer can see"
              : "shell commands can contact remote endpoints outside the language-level network APIs; review their destinations and how responses are used",
            ...(remoteShell.obfuscated ? { obfuscated: true } : {}),
          }),
        ),
      );
    }
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
      const exfiltrationSink = networkAccess.matched || shellNetworkTool.matched;
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
  codeLinesOnly = false,
): { matched: boolean; line: number | undefined; obfuscated: boolean } {
  const findLine = codeLinesOnly
    ? firstMatchingCodeLine
    : matchAcrossLines
      ? firstMatchingSourceLine
      : firstMatchingLine;
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

const NO_MATCH = { matched: false, line: undefined, obfuscated: false } as const;

// Path tokens in the arguments of calls that can load a file as code, so a
// data-looking file named there (`require(__dirname + '/payload.txt')`,
// `fork('run.css')`) is scanned whole. Basenames and bare extensions
// (`+ '.txt'`) are collected once so the per-file check is a set lookup.
const LOAD_CALL_ARGUMENTS =
  /\b(?:require|import|fork|Worker|spawn(?:Sync)?|execFile(?:Sync)?|exec(?:Sync)?)\s*\(([^\n;]{0,300})/g;
const LOAD_CALL_PATH_TOKEN = /[^\s'"`\\/()+,;${}[\]]+/g;

function codeLoadCallNames(ctx: RuleContext): Set<string> {
  const names = new Set<string>();
  for (const file of ctx.files) {
    const path = file.path;
    if (!file.textSample || path === ctx.packageJsonFile?.path) continue;
    if (isJsonDataPath(path) || isLoadableDataPath(path) || isMarkupPath(path)) continue;
    if (isDocumentationPath(path) || isTypeDeclarationPath(path)) continue;
    LOAD_CALL_ARGUMENTS.lastIndex = 0;
    for (const call of file.textSample.matchAll(LOAD_CALL_ARGUMENTS)) {
      for (const token of call[1].match(LOAD_CALL_PATH_TOKEN) ?? []) names.add(token.toLowerCase());
    }
  }
  return names;
}

// Reachable from main/bin/exports or a lifecycle hook through static imports,
// named by a lifecycle command, or named (or its extension named) in a load
// call. A path assembled outside the call is not followed.
function isLoadedAsCode(ctx: RuleContext, path: string, loadCallNames: Set<string>): boolean {
  if (ctx.consumerReachable.has(normalizeReachabilityPath(path))) return true;
  if (isLifecycleScriptFile(ctx, path)) return true;
  // Lowercased: `require('./PAYLOAD.TXT')` loads payload.txt on a case-insensitive
  // filesystem.
  const basename = (path.replaceAll("\\", "/").split("/").at(-1) ?? "").toLowerCase();
  return (
    loadCallNames.has(basename) || loadCallNames.has(basename.slice(basename.lastIndexOf(".")))
  );
}

function omitCommonEnvironmentAccesses(source: string): string {
  return source
    .replace(PROCESS_ENV_MEMBERSHIP_TEST, eraseKeepingNewlines)
    .replace(PROCESS_ENV_EXISTENCE_GUARD, eraseKeepingNewlines)
    .replace(COMMON_PROCESS_ENV_DOWNLEVEL_ACCESS, eraseKeepingNewlines)
    .replace(COMMON_PROCESS_ENV_TERNARY_ACCESS, eraseKeepingNewlines)
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
