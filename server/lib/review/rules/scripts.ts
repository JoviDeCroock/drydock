import { hasImplicitNodeGypInstall, isRootGypPath } from "../../tar-parser.js";
import {
  firstMatchingCodeLine,
  firstMatchingLine,
  firstMatchingSourceLine,
} from "../../platform/text-utils";
import type { Finding } from "../types";
import {
  CONSUMER_INSTALL_LIFECYCLE_SCRIPTS,
  ENV_ALIAS_BINDING,
  envAliasHarvestPatterns,
  omitDynamicImportShims,
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
import { codeViewsForScanning, normalizeCodeForScanning } from "./normalize";

const GYP_PACKAGE_JAVASCRIPT_COMMAND_PATTERNS = [
  /<!@?\([^)\n]*\bnode\b(?:\s+--[^\s'")]+)*\s+["']?(?:\.\/)?[\w@./-]+\.(?:cjs|mjs|js)["']?/i,
  /<!@?\([^)\n]*\bbun\b(?:\s+run)?\s+["']?(?:\.\/)?[\w@./-]+\.(?:cjs|mjs|js|ts)["']?/i,
];
// Uses of `process.env` that read no value: a presence test (`'CI' in
// process.env`, any name, since the value still needs a separate read) and an
// existence guard (`process.env && process.env.NODE_DEBUG`). Erased before the
// alias check so they do not read as the env object bound to a name; whatever
// the guard protects is judged on its own.
const PROCESS_ENV_MEMBERSHIP_TEST = /(['"`])[A-Za-z_][A-Za-z0-9_]*\1\s+in\s+process\.env\b/g;
const PROCESS_ENV_EXISTENCE_GUARD = /\bprocess\.env\s*&&/g;
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
    // Network, credential and dynamic-evaluation patterns are comment-blind in
    // JavaScript sources: prose such as `// fetch() leaves them alone` or a
    // JSDoc `@param processEnv process.env object` is not a capability. See
    // `codeViewsForScanning` for what is blanked and what is kept. Views only
    // remove matches, so a file is lexed for them only once a category's
    // patterns match its raw text.
    const javascript = ctx.codePatternSet !== "python";
    const dynamicSample = javascript ? omitGlobalObjectShims(sample) : sample;
    const dynamicNormalized = javascript ? omitGlobalObjectShims(normalized) : normalized;
    // Call-shaped eval primitives also skip string literal bodies, so a code
    // generator's emitted `"WebAssembly.compile(bytes)"` is not a call. The
    // dynamic-import shim is erased only for them; it stays a staging sink.
    const callSample = javascript ? omitDynamicImportShims(dynamicSample) : dynamicSample;
    const callNormalized = javascript
      ? omitDynamicImportShims(dynamicNormalized)
      : dynamicNormalized;
    const views = lazyCodeViews(file.path, sample, normalized);
    const dynamicViews = lazyCodeViews(file.path, dynamicSample, dynamicNormalized, [
      sample,
      normalized,
      views,
    ]);
    const callViews = lazyCodeViews(file.path, callSample, callNormalized, [
      dynamicSample,
      dynamicNormalized,
      dynamicViews,
    ]);
    const networkAccess = matchInCodeViews(
      [
        [
          ctx.patterns.networkAccess,
          sample,
          normalized,
          () => [views().code, views().normalizedCode],
        ],
      ],
      packedObfuscation,
    );
    const callGroup: ViewGroup = [
      ctx.patterns.dynamicCall,
      callSample,
      callNormalized,
      () => [callViews().codeNoStrings, callViews().normalizedCodeNoStrings],
    ];
    const dynamicCodeView = (): [string, string] => [
      dynamicViews().code,
      dynamicViews().normalizedCode,
    ];
    const dynamicExecution = matchInCodeViews(
      [
        callGroup,
        [ctx.patterns.dynamicStringArgument, dynamicSample, dynamicNormalized, dynamicCodeView],
      ],
      packedObfuscation,
      true,
    );
    // Decoding (`atob`, base64 `Buffer.from`) only counts in a file that can act
    // on what it decodes: run it, send it (node-ipc hid its geolocation host
    // that way), or stage it through a compiler, loader or file write (see
    // `decodedPayloadSink`). On its own it is a byte codec or a data table.
    // The gate is the whole file, not the decode's neighbourhood: a proximity
    // window would let a dropper move its decode away from the exec or fetch
    // and fall back to one weak capability.
    const dynamicEvaluation =
      dynamicExecution.matched ||
      processExecution.matched ||
      networkAccess.matched ||
      shellNetworkTool.matched ||
      markupHidingScript ||
      matchInCodeViews(
        [[ctx.patterns.decodedPayloadSink, dynamicSample, dynamicNormalized, dynamicCodeView]],
        false,
        true,
      ).matched
        ? matchInCodeViews(
            [
              callGroup,
              [
                [...ctx.patterns.dynamicStringArgument, ...ctx.patterns.payloadDecoding],
                dynamicSample,
                dynamicNormalized,
                dynamicCodeView,
              ],
            ],
            packedObfuscation,
            true,
          )
        : NO_MATCH;
    const credentialAccess = matchCategory(
      [...ctx.patterns.credentialAccess, ...ctx.patterns.credentialAlias],
      sample,
      normalized,
    ).matched
      ? matchCredentialAccess(
          ctx.patterns,
          javascript ? omitValuelessEnvironmentUses(views().code) : views().code,
          javascript
            ? omitValuelessEnvironmentUses(views().normalizedCode)
            : views().normalizedCode,
          packedObfuscation,
        )
      : NO_MATCH;
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
      // A decode right beside an eval primitive is the staged-payload chain
      // itself (event-stream's decrypt-then-`new Function`), the way a
      // credential read beside egress is the exfiltration chain: high whether
      // the file is new or a module the payload was spliced into. Only the
      // escalation is local; the finding itself keeps the whole-file gate.
      const decodedExecution =
        dynamicExecution.matched &&
        [
          [callViews().codeNoStrings, dynamicViews().code],
          [callViews().normalizedCodeNoStrings, dynamicViews().normalizedCode],
        ].some(([callText, decodeText]) =>
          matchesWithin(
            callText,
            ctx.patterns.dynamicCall,
            decodeText,
            ctx.patterns.payloadDecoding,
            DECODED_EXECUTION_WINDOW,
          ),
        );
      findings.push(
        testScope(
          testScoped,
          dynamicEvaluation.obfuscated,
          tag("codeDynamicEvaluation", {
            severity: changed === "added" || decodedExecution ? "high" : "medium",
            file: file.path,
            line: dynamicEvaluation.line,
            evidence: decodedExecution
              ? `${prefix}decoded payload beside a code-execution primitive`
              : `${prefix}dynamic code or obfuscation primitive`,
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
): CategoryMatch {
  return matchCategoryViews(
    [[patterns, sample, normalized]],
    sourceObfuscated,
    matchAcrossLines,
    codeLinesOnly,
  );
}

// One category whose pattern groups read different views of the same file.
// Every raw view is tried before any folded one, so a category keeps the
// single-view rule: folding can only add a match, and a folded-only match is
// what marks it obfuscated. The earliest line wins within a pass.
function matchCategoryViews(
  groups: Array<[patterns: RegExp[], sample: string, normalized: string]>,
  sourceObfuscated = false,
  matchAcrossLines = false,
  codeLinesOnly = false,
): CategoryMatch {
  const findLine = codeLinesOnly
    ? firstMatchingCodeLine
    : matchAcrossLines
      ? firstMatchingSourceLine
      : firstMatchingLine;
  const earliest = (texts: Array<[RegExp[], string]>) => {
    let best: number | undefined;
    for (const [patterns, text] of texts) {
      if (!patterns.length) continue;
      const line = findLine(text, patterns);
      if (line !== undefined && (best === undefined || line < best)) best = line;
    }
    return best;
  };
  const line = earliest(groups.map(([patterns, sample]) => [patterns, sample]));
  if (line !== undefined) return { matched: true, line, obfuscated: sourceObfuscated };
  const folded = groups.filter(([, sample, normalized]) => normalized !== sample);
  const normalizedLine = earliest(folded.map(([patterns, , normalized]) => [patterns, normalized]));
  if (normalizedLine !== undefined)
    return { matched: true, line: normalizedLine, obfuscated: true };
  return NO_MATCH;
}

interface ScanViews {
  code: string;
  codeNoStrings: string;
  normalizedCode: string;
  normalizedCodeNoStrings: string;
}

type ViewGroup = [
  patterns: RegExp[],
  sample: string,
  normalized: string,
  views: () => [code: string, normalizedCode: string],
];

// `matchCategoryViews` over code views, skipping the lexer for any group whose
// patterns miss the raw text (a view can only lose matches).
function matchInCodeViews(
  groups: ViewGroup[],
  sourceObfuscated = false,
  matchAcrossLines = false,
): CategoryMatch {
  const live = groups.filter(
    ([patterns, sample, normalized]) =>
      patterns.length > 0 &&
      matchCategory(patterns, sample, normalized, false, matchAcrossLines).matched,
  );
  if (live.length === 0) return NO_MATCH;
  return matchCategoryViews(
    live.map(([patterns, , , views]) => [patterns, ...views()]),
    sourceObfuscated,
    matchAcrossLines,
  );
}

// Folding never touches comments or changes line numbers, so the folded text
// is only re-lexed when folding changed it. `reuse` hands back already lexed
// views when an erasure pass (shims) left both texts unchanged.
function lazyCodeViews(
  path: string,
  sample: string,
  normalized: string,
  reuse?: [sample: string, normalized: string, views: () => ScanViews],
): () => ScanViews {
  let views: ScanViews | undefined;
  return () => {
    if (views) return views;
    if (reuse && reuse[0] === sample && reuse[1] === normalized) return (views = reuse[2]());
    const raw = codeViewsForScanning(path, sample);
    const folded = normalized === sample ? raw : codeViewsForScanning(path, normalized);
    return (views = {
      code: raw.code,
      codeNoStrings: raw.codeNoStrings,
      normalizedCode: folded.code,
      normalizedCodeNoStrings: folded.codeNoStrings,
    });
  };
}

function hasRotatingStringTableObfuscation(source: string): boolean {
  let matches = 0;
  for (const signal of ROTATING_STRING_TABLE_SIGNALS) {
    if (signal.test(source)) matches += 1;
  }
  return matches >= ROTATING_STRING_TABLE_SIGNAL_THRESHOLD;
}

const NO_MATCH = { matched: false, line: undefined, obfuscated: false } as const;

// Characters between a decode and an eval call for the pair to read as one
// staged-payload chain. A bundle's unrelated base64 helper and template
// compiler sit far further apart than a payload's decode-then-run.
const DECODED_EXECUTION_WINDOW = 300;

function matchesWithin(
  textA: string,
  patternsA: RegExp[],
  textB: string,
  patternsB: RegExp[],
  window: number,
): boolean {
  if (patternsA.length === 0 || patternsB.length === 0) return false;
  const a = matchOffsets(textA, patternsA);
  if (a.length === 0) return false;
  const b = matchOffsets(textB, patternsB);
  let j = 0;
  for (const offset of a) {
    while (j < b.length && b[j] < offset - window) j += 1;
    if (j < b.length && b[j] <= offset + window) return true;
  }
  return false;
}

function matchOffsets(text: string, patterns: RegExp[]): number[] {
  const offsets: number[] = [];
  for (const pattern of patterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
      offsets.push(match.index);
    }
  }
  return offsets.sort((x, y) => x - y);
}

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

function omitValuelessEnvironmentUses(source: string): string {
  return source
    .replace(PROCESS_ENV_MEMBERSHIP_TEST, eraseKeepingNewlines)
    .replace(PROCESS_ENV_EXISTENCE_GUARD, eraseKeepingNewlines);
}

// Keep the match's newlines so line numbers stay stable for later findings and
// the release-delta changed-line check that consumes finding.line.
function eraseKeepingNewlines(match: string): string {
  return match.replace(/[^\n]+/g, "");
}

// Credential access in one file: a direct match (secret-shaped name, computed
// key, whole-environment harvest, credential file), or the env object bound to
// a value together with evidence of what is read through it — a secret-shaped
// constant name, or a harvest of the binding itself. The finding points at that
// evidence line, which is the one a payload adds.
function matchCredentialAccess(
  patterns: RuleContext["patterns"],
  sample: string,
  normalized: string,
  sourceObfuscated: boolean,
): CategoryMatch {
  const direct = matchCategory(patterns.credentialAccess, sample, normalized, sourceObfuscated);
  if (direct.matched || patterns.credentialAlias.length === 0) return direct;
  const alias = matchCategory(patterns.credentialAlias, sample, normalized, sourceObfuscated);
  if (!alias.matched) return NO_MATCH;
  // An env object that only appears once string pieces are joined
  // (`globalThis['proc' + 'ess']['e' + 'nv']`), or in a packed string-table
  // file, is hidden on purpose; nobody assembles it to read `PORT`.
  if (alias.obfuscated) return alias;
  const names = new Set<string>();
  for (const text of normalized === sample ? [sample] : [sample, normalized]) {
    ENV_ALIAS_BINDING.lastIndex = 0;
    for (const binding of text.matchAll(ENV_ALIAS_BINDING)) names.add(binding[1]);
  }
  const evidence = matchCategory(
    [...patterns.secretName, ...envAliasHarvestPatterns([...names])],
    sample,
    normalized,
    sourceObfuscated,
  );
  if (!evidence.matched) return NO_MATCH;
  return { ...evidence, obfuscated: evidence.obfuscated || alias.obfuscated };
}

type CategoryMatch = { matched: boolean; line: number | undefined; obfuscated: boolean };

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
