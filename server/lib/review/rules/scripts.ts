import { hasImplicitNodeGypInstall, isRootGypPath } from "../../tar-parser.js";
import {
  firstMatchingCodeLine,
  firstMatchingLine,
  firstMatchingSourceLine,
} from "../../platform/text-utils";
import type { Finding } from "../types";
import {
  CONSUMER_INSTALL_LIFECYCLE_SCRIPTS,
  ENV_OBJECT_PATTERN,
  ENV_OBJECT_VALUE_USE,
  omitDynamicImportShims,
  omitGlobalObjectShims,
  SECRET_NAME,
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
// Uses of the env object as a value that read nothing: a presence test
// (`'CI' in process.env`, any name, since the value still needs a separate
// read), existence and type guards (`process.env && …`, `typeof process.env`,
// `void 0 !== process.env`, `!process.env`, `process.env ? … : …`). Erased
// before credential matching; whatever the guard protects is judged on its own.
const ENV_VALUE = ENV_OBJECT_VALUE_USE.source;
const VALUELESS_ENVIRONMENT_USES = [
  new RegExp(String.raw`(['"\x60])[A-Za-z_][A-Za-z0-9_]*\1\s+in\s+${ENV_VALUE}`, "g"),
  new RegExp(String.raw`${ENV_VALUE}\s*&&`, "g"),
  new RegExp(String.raw`\btypeof\s+${ENV_VALUE}`, "g"),
  new RegExp(String.raw`${ENV_VALUE}\s*[!=]==?\s*(?:undefined\b|null\b|void\s+0\b)`, "g"),
  new RegExp(String.raw`(?:\bundefined|\bnull|\bvoid\s+0)\s*[!=]==?\s*${ENV_VALUE}`, "g"),
  new RegExp(String.raw`(?<![!=<>])!+\s*${ENV_VALUE}`, "g"),
  new RegExp(String.raw`${ENV_VALUE}\s*\?(?![?.])`, "g"),
  new RegExp(String.raw`\bif\s*\(\s*${ENV_VALUE}\s*\)`, "g"),
];
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
  // The folded text reads `_0x9f['pu' + 'sh']` as `_0x9f.push`.
  /\[['"]push['"]\]\s*\(|\b_0x[\da-f]+\.push\s*\(/i,
  /\[['"]shift['"]\]\s*\(\s*\)|\b_0x[\da-f]+\.shift\s*\(\s*\)/i,
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
      ctx.codePatternSet !== "python" &&
      (hasRotatingStringTableObfuscation(sample) ||
        (normalized !== sample && hasRotatingStringTableObfuscation(normalized)));
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
              ...undecodedPayloadDecodingGroup(file.path, sample, normalized, ctx, dynamicSample),
            ],
            packedObfuscation,
            true,
          )
        : NO_MATCH;
    const credentialAccess = matchCategory(ctx.patterns.credentialAccess, sample, normalized)
      .matched
      ? matchCategory(
          ctx.patterns.credentialAccess,
          javascript
            ? omitValuelessEnvironmentUses(views().code, views().codeNoStrings)
            : views().code,
          javascript
            ? omitValuelessEnvironmentUses(views().normalizedCode, views().normalizedCodeNoStrings)
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

// Folding a literal decode replaces the call with what it decodes to, so the
// decode itself is matched in text folded without decoding: an assembled
// `Buffer.from(…, 'bas' + 'e64')` stays a decode.
function undecodedPayloadDecodingGroup(
  path: string,
  sample: string,
  normalized: string,
  ctx: RuleContext,
  dynamicSample: string,
): ViewGroup[] {
  if (ctx.codePatternSet === "python" || normalized === sample) return [];
  const undecoded = omitGlobalObjectShims(normalizeCodeForScanning(sample, { decode: false }));
  if (undecoded === omitGlobalObjectShims(normalized)) return [];
  const views = lazyCodeViews(path, dynamicSample, undecoded);
  return [
    [
      ctx.patterns.payloadDecoding,
      dynamicSample,
      undecoded,
      () => [views().code, views().normalizedCode],
    ],
  ];
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
  // Only names some file here can be looked up by are kept: the text is hostile
  // and its distinct tokens are bounded only by the retained bytes.
  const lookups = new Set(ctx.files.flatMap((file) => loadCallLookupNames(file.path)));
  const names = new Set<string>();
  for (const file of ctx.files) {
    const path = file.path;
    if (!file.textSample || path === ctx.packageJsonFile?.path) continue;
    if (isJsonDataPath(path) || isLoadableDataPath(path) || isMarkupPath(path)) continue;
    if (isDocumentationPath(path) || isTypeDeclarationPath(path)) continue;
    LOAD_CALL_ARGUMENTS.lastIndex = 0;
    for (const call of file.textSample.matchAll(LOAD_CALL_ARGUMENTS)) {
      for (const [token] of call[1].matchAll(LOAD_CALL_PATH_TOKEN)) {
        const name = token.toLowerCase();
        if (lookups.has(name)) names.add(name);
      }
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
  const [basename, extension] = loadCallLookupNames(path);
  return loadCallNames.has(basename) || loadCallNames.has(extension);
}

// Lowercased: `require('./PAYLOAD.TXT')` loads payload.txt on a case-insensitive
// filesystem.
function loadCallLookupNames(path: string): [string, string] {
  const basename = (path.replaceAll("\\", "/").split("/").at(-1) ?? "").toLowerCase();
  return [basename, basename.slice(basename.lastIndexOf("."))];
}

// `code` and `inert` are same-length views (comments blanked; `inert` also
// blanks string bodies), so offsets found in one apply to the other.
function omitValuelessEnvironmentUses(code: string, inert: string): string {
  let out = hoistSplitEnvironmentMembers(code);
  for (const pattern of VALUELESS_ENVIRONMENT_USES) {
    out = out.replace(pattern, eraseKeepingNewlines);
  }
  for (const pattern of LOWERED_OPTIONAL_ENVIRONMENT_READS) {
    // Replacer arguments are the captures, then the offset and the input.
    out = out.replace(pattern, (match: string, ...rest: unknown[]) =>
      SECRET_NAME.test(String(rest.slice(0, -2).at(-1))) ? match : eraseKeepingNewlines(match),
    );
  }
  const hoistedInert = hoistSplitEnvironmentMembers(inert);
  out = omitNamedEnvironmentAliases(out, hoistedInert);
  return omitNamedEnvironmentDestructuring(out, hoistedInert);
}

// Compilers lower `process?.env?.NODE_ENV` into a bare `process.env` inside a
// conditional whose result is then read by name: TypeScript's
// `(null == process ? void 0 : process.env)?.NODE_ENV`, and the temporary forms
// `null==(t=null==process?void 0:process.env)?void 0:t.NODE_ENV` and
// `(_a = process === null || process === void 0 ? void 0 : process.env) ===
// null || _a === void 0 ? void 0 : _a.NODE_ENV`. Only those exact shapes, and
// only for a non-secret name (the last capture), are a named read.
const LOWERED_OPTIONAL_ENVIRONMENT_READS = [
  new RegExp(String.raw`\?\s*void\s+0\s*:\s*${ENV_VALUE}\s*\)\s*\??\.\s*([\w$]+)`, "g"),
  new RegExp(
    String.raw`\(\s*([A-Za-z_$][\w$]*)\s*=\s*(?:null\s*==\s*process|process\s*===\s*null\s*\|\|\s*process\s*===\s*void\s+0)\s*\?\s*void\s+0\s*:\s*${ENV_VALUE}\s*\)\s*(?:===\s*null\s*\|\|\s*\1\s*===\s*void\s+0\s*)?\?\s*void\s+0\s*:\s*\1\s*\.\s*([\w$]+)`,
    "g",
  ),
];

// `const env = process.env` followed only by named reads of non-secret
// variables (`env.TERM`, `env['CI']`, `'NO_COLOR' in env`) is the same as
// reading them directly. Only a declaration whose initializer is exactly the
// env object qualifies (not a default parameter or an assignment expression,
// whose value can flow on). Every other occurrence of the name, found in the
// string-blind view, keeps the binding counted: passed, spread, copied,
// re-bound, enumerated, indexed by a computed key, or reused as an unrelated
// variable (a minifier's `e`), since the scan has no scopes.
const ENV_ALIAS_DECLARATION = new RegExp(
  String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(${ENV_VALUE})(?=[^\S\n]*(?:[;,\n]|$))`,
  "gd",
);
const ENV_ALIAS_LIMIT = 32;

function omitNamedEnvironmentAliases(code: string, inert: string): string {
  const erase: Array<[number, number]> = [];
  let seen = 0;
  ENV_ALIAS_DECLARATION.lastIndex = 0;
  for (const binding of code.matchAll(ENV_ALIAS_DECLARATION)) {
    if (++seen > ENV_ALIAS_LIMIT) break;
    const [nameStart] = binding.indices?.[1] ?? [-1];
    const env = binding.indices?.[2];
    if (env && onlyNamedReadsThrough(code, inert, binding[1], nameStart)) erase.push(env);
  }
  return blankRanges(code, erase);
}

function onlyNamedReadsThrough(
  code: string,
  inert: string,
  name: string,
  declaration: number,
): boolean {
  const occurrence = new RegExp(String.raw`(?<![\w$.])${name.replace(/\$/g, "\\$")}(?![\w$])`, "g");
  for (const use of inert.matchAll(occurrence)) {
    if (use.index === declaration) continue;
    const after = code.slice(use.index + name.length, use.index + name.length + 256);
    const member =
      /^\s*(?:\?\.|\.)\s*([\w$]+)/.exec(after) ??
      /^\s*(?:\?\.\s*)?\[\s*(["'])([^"'\n\\]*)\1\s*\]/.exec(after);
    if (member) {
      if (SECRET_NAME.test(member.at(-1) ?? "")) return false;
      continue;
    }
    const before = code.slice(Math.max(0, use.index - 128), use.index);
    if (/(['"\x60])[A-Za-z_][\w]*\1\s+in\s+$/.test(before)) continue;
    return false;
  }
  return true;
}

function blankRanges(source: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return source;
  let out = "";
  let pos = 0;
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    out += source.slice(pos, start) + " ".repeat(end - start);
    pos = end;
  }
  return out + source.slice(pos);
}

// Patterns match line by line, so a member read split across lines
// (`process.env\n  .npm_command`) would leave a bare `process.env` that reads
// as a value. Moving the line break after the member keeps the read on the
// env object's line and the line count, and the length, unchanged.
const SPLIT_ENVIRONMENT_MEMBER = new RegExp(
  String.raw`(${ENV_OBJECT_PATTERN.source})([^\S\n]*\n\s*)((?:\?\.|\.)\s*[\w$]+|(?:\?\.\s*)?\[)`,
  "g",
);

function hoistSplitEnvironmentMembers(source: string): string {
  return source.replace(
    SPLIT_ENVIRONMENT_MEMBER,
    (_, env: string, gap: string, member: string) => env + member + gap,
  );
}

// Blank to spaces, keeping newlines and length: line numbers stay stable for
// later findings and the release-delta changed-line check that consumes
// finding.line, and offsets stay aligned with the string-blind view.
function eraseKeepingNewlines(match: string): string {
  return match.replace(/[^\n]/g, " ");
}

// `const { PORT, HOME: home = '' } = process.env`, on one line or many, declares
// exactly the names it lists, so it is judged like `process.env.PORT`: erased
// when no listed name looks like a secret, kept with a rest element or a
// computed key. The pattern is found by a backward bracket scan over the
// string-blind view; a slash in it (regex or division), or a scan past the
// window or the per-file budget, leaves the use counted.
const DESTRUCTURING_WINDOW = 4096;
const DESTRUCTURING_BUDGET = 256 * 1024;

function omitNamedEnvironmentDestructuring(code: string, inert: string): string {
  if (!code.includes("}")) return code;
  let budget = DESTRUCTURING_BUDGET;
  const erase: Array<[number, number]> = [];
  ENV_OBJECT_VALUE_USE.lastIndex = 0;
  for (const match of code.matchAll(ENV_OBJECT_VALUE_USE)) {
    const before = /\}\s*=\s*$/.exec(inert.slice(Math.max(0, match.index - 64), match.index));
    if (!before) continue;
    const close = match.index - before[0].length;
    const open = matchingOpenBrace(inert, close, Math.min(DESTRUCTURING_WINDOW, budget));
    if (open < 0) {
      budget -= DESTRUCTURING_WINDOW;
      if (budget <= 0) break;
      continue;
    }
    budget -= close - open;
    // Only a declaration. A destructuring assignment (`({ HOME } =
    // process.env)`) is an expression whose value is the whole env object.
    if (!/(?<![\w$.])(?:const|let|var)\s*$/.test(inert.slice(Math.max(0, open - 16), open))) {
      continue;
    }
    const names = code.slice(open + 1, close);
    if (/\.\.\.|\[/.test(names) || SECRET_NAME.test(names)) continue;
    erase.push([match.index, match.index + match[0].length]);
  }
  return blankRanges(code, erase);
}

function matchingOpenBrace(inert: string, close: number, window: number): number {
  let depth = 0;
  const stop = Math.max(0, close - window);
  for (let i = close - 1; i >= stop; i -= 1) {
    const c = inert[i];
    if (c === "/") return -1;
    if (c === "}" || c === ")" || c === "]") depth += 1;
    else if (c === "(" || c === "[") {
      if (depth === 0) return -1;
      depth -= 1;
    } else if (c === "{") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
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
