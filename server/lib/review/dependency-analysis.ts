import type { FileRecord, Finding, PackageJsonSummary } from "./";
import {
  DETERMINISTIC_RULE_IDS,
  deterministicFindings,
  type DeterministicFindingOptions,
} from "./rules";
import {
  analyzeNodeInterpreterArgs,
  consumerInstallScriptCommands,
  lifecycleReachablePaths,
  normalizeReachabilityPath,
  shellCommandWords,
} from "./rules/reachability";
import { normalizeStringRecord } from "../tar-parser.js";
import { jsTokenText, tokenizeJs, type JsToken } from "../platform/js-lexer";
import type {
  DependencyExecutionEntrypoint,
  DependencyInstallObservation,
} from "./dependency-evidence";

type DependencyObservation = DependencyInstallObservation["risk"];

// Rule IDs that mean "installing this package runs code without anyone asking".
const AUTOMATIC_EXECUTION_RULE_IDS = new Set<string>([
  DETERMINISTIC_RULE_IDS.installScript,
  DETERMINISTIC_RULE_IDS.installScriptPreinstall,
  DETERMINISTIC_RULE_IDS.installScriptImplicitNodeGyp,
]);

/** Install-time behaviors with no benign reading. */
const STRONG_INSTALL_DANGER_RULE_IDS = new Set<string>([
  DETERMINISTIC_RULE_IDS.codeRemoteShell,
  DETERMINISTIC_RULE_IDS.codeCredentialAccess,
  DETERMINISTIC_RULE_IDS.codeDynamicEvaluation,
  DETERMINISTIC_RULE_IDS.fileSecretContent,
]);

/** Behaviors that make automatic execution require a maintainer's attention. */
const INSTALL_TIME_DANGER_RULE_IDS = new Set<string>([
  ...STRONG_INSTALL_DANGER_RULE_IDS,
  DETERMINISTIC_RULE_IDS.codeNetworkAccess,
]);

interface DependencyArtifactAssessment {
  observation: DependencyInstallObservation;
  automaticExecution: DependencyExecutionEntrypoint[];
  capabilities: string[];
  installReachableCapabilities: string[];
  /** Install-reachable files whose bodies the parser deliberately did not retain. */
  installReachableUninspectedFiles: string[];
  findings: Finding[];
}

/**
 * Observe install behavior without turning absence of a static edge into a
 * safety verdict. `risk: unknown` means automatic execution exists and the
 * artifact contains danger-shaped behavior, but the bounded graph cannot prove
 * or disprove that the install path reaches it.
 */
export function assessDependencyArtifact(
  files: FileRecord[],
  manifest: PackageJsonSummary | null,
  options: DeterministicFindingOptions = {},
): DependencyArtifactAssessment {
  const findings = deterministicFindings(files, [], manifest, options);
  const scripts = normalizeStringRecord(manifest?.scripts);
  const implicitScripts = normalizeStringRecord(manifest?.implicitScripts);
  const automaticExecution = executionEntrypoints(findings, scripts, implicitScripts);
  const installCommands = consumerInstallScriptCommands(scripts, implicitScripts);
  const capabilities = [
    ...new Set(findings.flatMap((finding) => (finding.ruleId ? [finding.ruleId] : []))),
  ].sort();

  const reachable = lifecycleReachablePaths(files, scripts, implicitScripts);
  const inlineInstallCapabilities = installScriptCapabilities(installCommands, options);
  const installReachable = (finding: Finding) =>
    reachable.has(normalizeReachabilityPath(finding.file));
  const installReachableCapabilities = [
    ...new Set([
      ...findings.flatMap((finding) =>
        finding.ruleId && installReachable(finding) ? [finding.ruleId] : [],
      ),
      ...inlineInstallCapabilities,
    ]),
  ].sort();

  const directlyReachableUninspectedFiles = files
    .filter(
      (file) =>
        file.flags.includes("text-sample-skipped") &&
        reachable.has(normalizeReachabilityPath(file.path)),
    )
    .map((file) => file.path);

  // A computed module load or local execution target can select any omitted
  // file. Do not guess from extensions: Node loaders, child processes, and
  // package hooks can execute extensionless or custom-extension content. Once
  // the install path contains a dynamic edge, every deliberately omitted body
  // is an unresolved coverage gap.
  const omittedFiles = files.filter((file) => file.flags.includes("text-sample-skipped"));
  const filesByPath = new Map(
    files.map((file) => [normalizeReachabilityPath(file.path), file] as const),
  );
  const needsDynamicInstallAnalysis =
    automaticExecution.length > 0 &&
    (omittedFiles.length > 0 || capabilities.includes(DETERMINISTIC_RULE_IDS.fileNativeArtifact));
  const hasDynamicInstallEdge =
    needsDynamicInstallAnalysis &&
    (installCommands.some(({ command }) => hasDynamicInstallCommand(command)) ||
      [...reachable].some((path) => {
        const file = filesByPath.get(path);
        return file?.textSample
          ? hasDynamicModuleLoad(file.textSample) || hasDynamicLocalExecution(file.textSample)
          : false;
      }));
  const installReachableUninspectedFiles = [
    ...new Set([
      ...directlyReachableUninspectedFiles,
      ...(hasDynamicInstallEdge ? omittedFiles.map((file) => file.path) : []),
    ]),
  ].sort();

  const executionObserved = automaticExecution.length > 0;
  const reachableDanger = hasObservedInstallRisk(installReachableCapabilities);
  const anyDanger =
    capabilities.some((ruleId) => INSTALL_TIME_DANGER_RULE_IDS.has(ruleId)) ||
    (hasDynamicInstallEdge && capabilities.includes(DETERMINISTIC_RULE_IDS.fileNativeArtifact));
  const risk: DependencyObservation = !executionObserved
    ? "not-observed"
    : reachableDanger
      ? "observed"
      : anyDanger
        ? "unknown"
        : "not-observed";

  return {
    observation: {
      execution: executionObserved ? "observed" : "not-observed",
      risk,
      ...(hasDynamicInstallEdge ? { dynamicInstallTarget: true as const } : {}),
    },
    automaticExecution,
    capabilities,
    installReachableCapabilities,
    installReachableUninspectedFiles,
    findings,
  };
}

function hasDynamicModuleLoad(text: string): boolean {
  const tokens = tokenizeJs(text).filter(
    (token) => token.type !== "ws" && token.type !== "comment",
  );
  const loaderAliases = moduleLoaderAliases(text, tokens);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    let openIndex: number;
    if (token.type === "ident") {
      const callee = jsTokenText(text, token);
      if (callee !== "require" && callee !== "import" && !loaderAliases.has(callee)) continue;
      const previous = tokens[index - 1];
      const memberAccess =
        previous?.type === "punct" && [".", "?."].includes(jsTokenText(text, previous));
      const receiver = tokens[index - 2];
      const receiverPrevious = tokens[index - 3];
      const moduleRequire =
        callee === "require" &&
        memberAccess &&
        receiver?.type === "ident" &&
        jsTokenText(text, receiver) === "module" &&
        !(
          receiverPrevious?.type === "punct" &&
          [".", "?."].includes(jsTokenText(text, receiverPrevious))
        );
      if (memberAccess && !moduleRequire) continue;
      const optionalCall = tokens[index + 1];
      openIndex =
        optionalCall?.type === "punct" && jsTokenText(text, optionalCall) === "?."
          ? index + 2
          : index + 1;
    } else if (token.type === "string" && token.value === "require") {
      const bracketOpen = tokens[index - 1];
      const bracketClose = tokens[index + 1];
      if (
        bracketOpen?.type !== "punct" ||
        jsTokenText(text, bracketOpen) !== "[" ||
        bracketClose?.type !== "punct" ||
        jsTokenText(text, bracketClose) !== "]"
      ) {
        continue;
      }
      const optionalMember = tokens[index - 2];
      const receiverIndex =
        optionalMember?.type === "punct" && jsTokenText(text, optionalMember) === "?."
          ? index - 3
          : index - 2;
      const receiver = tokens[receiverIndex];
      const receiverPrevious = tokens[receiverIndex - 1];
      if (
        receiver?.type !== "ident" ||
        jsTokenText(text, receiver) !== "module" ||
        (receiverPrevious?.type === "punct" &&
          [".", "?."].includes(jsTokenText(text, receiverPrevious)))
      ) {
        continue;
      }
      const optionalCall = tokens[index + 2];
      openIndex =
        optionalCall?.type === "punct" && jsTokenText(text, optionalCall) === "?."
          ? index + 3
          : index + 2;
    } else {
      continue;
    }
    const open = tokens[openIndex];
    if (open?.type !== "punct" || jsTokenText(text, open) !== "(") continue;
    // Alias calls are deliberately treated as dynamic: the bounded static
    // reachability graph does not resolve their arguments, even when literal.
    if (token.type === "ident" && loaderAliases.has(jsTokenText(text, token))) return true;
    const argument = tokens[openIndex + 1];
    if (!argument || (argument.type === "punct" && jsTokenText(text, argument) === ")")) continue;
    const afterArgument = tokens[openIndex + 2];
    const argumentEndsSpecifier =
      afterArgument?.type === "punct" && [")", ","].includes(jsTokenText(text, afterArgument));
    const staticSpecifier = moduleSpecifierIsStaticForReachability(text, argument);
    if (
      !staticSpecifier ||
      !argumentEndsSpecifier ||
      !onlyWhitespaceBetween(text, open, argument) ||
      !onlyWhitespaceBetween(text, argument, afterArgument)
    ) {
      return true;
    }
  }
  return false;
}

/** True only when the bounded static graph can represent this literal exactly. */
function moduleSpecifierIsStaticForReachability(text: string, token: JsToken): boolean {
  if (token.type === "string") {
    const value = token.value ?? "";
    const local = value.startsWith("./") || value.startsWith("../");
    return !local || !jsTokenText(text, token).includes("\\");
  }
  return (
    token.type === "template" &&
    !jsTokenText(text, token).includes("${") &&
    !jsTokenText(text, token).includes("\\")
  );
}

/**
 * Discover simple aliases for CommonJS loaders without executing package code.
 * The fixpoint also covers `const second = first`; `createRequire(...)` is a
 * loader value even though the factory call itself is not a module load.
 */
function moduleLoaderAliases(text: string, tokens: JsToken[]): Set<string> {
  const renamedFactories = destructuredModuleAliases(
    text,
    tokens,
    new Set(["module", "node:module"]),
    new Set(["createRequire"]),
  );
  const factoryAliases = simpleAliases(
    text,
    tokens,
    (sourceIndex) => {
      const sourceName = jsTokenText(text, tokens[sourceIndex]);
      const afterSource = tokens[sourceIndex + 1];
      return (
        sourceName === "createRequire" &&
        !(afterSource?.type === "punct" && jsTokenText(text, afterSource) === "(")
      );
    },
    renamedFactories,
  );
  return simpleAliases(
    text,
    tokens,
    (sourceIndex) => {
      const sourceName = jsTokenText(text, tokens[sourceIndex]);
      const afterSource = tokens[sourceIndex + 1];
      return (
        (sourceName === "require" &&
          !(afterSource?.type === "punct" && jsTokenText(text, afterSource) === "(")) ||
        ((sourceName === "createRequire" || factoryAliases.has(sourceName)) &&
          afterSource?.type === "punct" &&
          jsTokenText(text, afterSource) === "(")
      );
    },
    boundModuleRequireAliases(text, tokens),
  );
}

/** Bindings created from `module.require.bind(module)` remain module loaders. */
function boundModuleRequireAliases(text: string, tokens: JsToken[]): Set<string> {
  const aliases = new Set<string>();
  for (let index = 0; index < tokens.length - 7; index += 1) {
    const target = tokens[index];
    const equals = tokens[index + 1];
    const module = tokens[index + 2];
    if (
      target.type !== "ident" ||
      equals?.type !== "punct" ||
      jsTokenText(text, equals) !== "=" ||
      module?.type !== "ident" ||
      jsTokenText(text, module) !== "module"
    ) {
      continue;
    }
    const previous = tokens[index - 1];
    if (previous?.type === "punct" && [".", "?."].includes(jsTokenText(text, previous))) continue;

    let memberEnd: number;
    const memberOpen = tokens[index + 3];
    const member = tokens[index + 4];
    if (
      memberOpen?.type === "punct" &&
      [".", "?."].includes(jsTokenText(text, memberOpen)) &&
      member?.type === "ident" &&
      jsTokenText(text, member) === "require"
    ) {
      memberEnd = index + 5;
    } else if (
      memberOpen?.type === "punct" &&
      jsTokenText(text, memberOpen) === "[" &&
      member?.type === "string" &&
      member.value === "require" &&
      tokens[index + 5]?.type === "punct" &&
      jsTokenText(text, tokens[index + 5]) === "]"
    ) {
      memberEnd = index + 6;
    } else {
      continue;
    }

    const dot = tokens[memberEnd];
    const bind = tokens[memberEnd + 1];
    const open = tokens[memberEnd + 2];
    if (
      dot?.type === "punct" &&
      [".", "?."].includes(jsTokenText(text, dot)) &&
      bind?.type === "ident" &&
      jsTokenText(text, bind) === "bind" &&
      open?.type === "punct" &&
      jsTokenText(text, open) === "("
    ) {
      aliases.add(jsTokenText(text, target));
    }
  }
  return aliases;
}

const LOCAL_EXECUTION_CALLEES = new Set([
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync",
]);

/** True when an install-reachable process or shell edge has no static target. */
function hasDynamicLocalExecution(text: string): boolean {
  // Shell variables and substitutions can select a packaged executable even
  // when the static reachability expressions cannot name it.
  if (/(?:^|[;\n&|]\s*)(?:source|\.)\s+(?:["']?\$|["'][^"']*\$)/m.test(text)) return true;

  const tokens = tokenizeJs(text).filter(
    (token) => token.type !== "ws" && token.type !== "comment",
  );
  const aliases = localExecutionAliases(text, tokens);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    let callee: string;
    let memberAccess: boolean;
    let openIndex: number;
    if (token.type === "ident") {
      callee = jsTokenText(text, token);
      if (!LOCAL_EXECUTION_CALLEES.has(callee) && !aliases.has(callee)) continue;
      const previous = tokens[index - 1];
      memberAccess =
        previous?.type === "punct" && [".", "?."].includes(jsTokenText(text, previous));
      const optionalCall = tokens[index + 1];
      openIndex =
        optionalCall?.type === "punct" && jsTokenText(text, optionalCall) === "?."
          ? index + 2
          : index + 1;
    } else if (token.type === "string" && LOCAL_EXECUTION_CALLEES.has(token.value ?? "")) {
      const bracketOpen = tokens[index - 1];
      const bracketClose = tokens[index + 1];
      if (
        bracketOpen?.type !== "punct" ||
        jsTokenText(text, bracketOpen) !== "[" ||
        bracketClose?.type !== "punct" ||
        jsTokenText(text, bracketClose) !== "]"
      ) {
        continue;
      }
      callee = token.value!;
      memberAccess = true;
      const optionalCall = tokens[index + 2];
      openIndex =
        optionalCall?.type === "punct" && jsTokenText(text, optionalCall) === "?."
          ? index + 3
          : index + 2;
    } else {
      continue;
    }
    if (memberAccess && aliases.has(callee)) continue;
    const open = tokens[openIndex];
    if (open?.type !== "punct" || jsTokenText(text, open) !== "(") continue;

    // Alias calls are unresolved by the bounded path graph, including when a
    // literal is passed through them.
    if (aliases.has(callee) && !memberAccess) return true;
    const argument = tokens[openIndex + 1];
    if (!argument || (argument.type === "punct" && jsTokenText(text, argument) === ")")) continue;
    const afterArgument = tokens[openIndex + 2];
    const argumentEndsTarget =
      afterArgument?.type === "punct" && [")", ","].includes(jsTokenText(text, afterArgument));
    const staticTarget =
      argument.type === "string" ||
      (argument.type === "template" && !jsTokenText(text, argument).includes("${"));
    if (
      !staticTarget ||
      !argumentEndsTarget ||
      !onlyWhitespaceBetween(text, open, argument) ||
      !onlyWhitespaceBetween(text, argument, afterArgument)
    ) {
      return true;
    }
    if (
      argument.type === "string" &&
      (callee === "exec" || callee === "execSync") &&
      hasDynamicShellCommand(argument.value ?? "")
    ) {
      return true;
    }
    if (
      argument.type === "string" &&
      ["node", "nodejs"].includes(argument.value ?? "") &&
      afterArgument?.type === "punct" &&
      jsTokenText(text, afterArgument) === "," &&
      analyzeNodeInterpreterArgs(text, tokens).hasDynamic
    ) {
      return true;
    }
  }
  return false;
}

function onlyWhitespaceBetween(text: string, before: JsToken, after: JsToken | undefined): boolean {
  return after !== undefined && /^\s*$/.test(text.slice(before.end, after.start));
}

function localExecutionAliases(text: string, tokens: JsToken[]): Set<string> {
  const renamedBindings = destructuredModuleAliases(
    text,
    tokens,
    new Set(["child_process", "node:child_process"]),
    LOCAL_EXECUTION_CALLEES,
  );
  return simpleAliases(
    text,
    tokens,
    (sourceIndex) => {
      const source = tokens[sourceIndex];
      const sourceName = jsTokenText(text, source);
      const afterSource = tokens[sourceIndex + 1];
      if (
        LOCAL_EXECUTION_CALLEES.has(sourceName) &&
        !(afterSource?.type === "punct" && jsTokenText(text, afterSource) === "(")
      ) {
        return true;
      }

      const member = tokens[sourceIndex + 2];
      const afterMember = tokens[sourceIndex + 3];
      if (
        afterSource?.type === "punct" &&
        [".", "?."].includes(jsTokenText(text, afterSource)) &&
        member?.type === "ident" &&
        LOCAL_EXECUTION_CALLEES.has(jsTokenText(text, member)) &&
        !(afterMember?.type === "punct" && jsTokenText(text, afterMember) === "(")
      ) {
        return true;
      }

      const requiredModule = tokens[sourceIndex + 2];
      const close = tokens[sourceIndex + 3];
      const dot = tokens[sourceIndex + 4];
      const method = tokens[sourceIndex + 5];
      return (
        sourceName === "require" &&
        afterSource?.type === "punct" &&
        jsTokenText(text, afterSource) === "(" &&
        requiredModule?.type === "string" &&
        ["child_process", "node:child_process"].includes(requiredModule.value ?? "") &&
        close?.type === "punct" &&
        jsTokenText(text, close) === ")" &&
        dot?.type === "punct" &&
        [".", "?."].includes(jsTokenText(text, dot)) &&
        method?.type === "ident" &&
        LOCAL_EXECUTION_CALLEES.has(jsTokenText(text, method)) &&
        !(
          tokens[sourceIndex + 6]?.type === "punct" &&
          jsTokenText(text, tokens[sourceIndex + 6]) === "("
        )
      );
    },
    renamedBindings,
  );
}

/** Renamed CommonJS destructuring and ESM imports from a known module. */
function destructuredModuleAliases(
  text: string,
  tokens: JsToken[],
  modules: Set<string>,
  exports: Set<string>,
): Set<string> {
  const aliases = new Set<string>();
  for (let openIndex = 0; openIndex < tokens.length; openIndex += 1) {
    const open = tokens[openIndex];
    if (open.type !== "punct" || jsTokenText(text, open) !== "{") continue;

    let depth = 1;
    let closeIndex = openIndex + 1;
    for (; closeIndex < tokens.length && depth > 0; closeIndex += 1) {
      const value = jsTokenText(text, tokens[closeIndex]);
      if (tokens[closeIndex].type !== "punct") continue;
      if (value === "{") depth += 1;
      if (value === "}") depth -= 1;
    }
    if (depth !== 0) continue;
    closeIndex -= 1;

    const afterClose = tokens[closeIndex + 1];
    const source =
      afterClose?.type === "ident" && jsTokenText(text, afterClose) === "from"
        ? tokens[closeIndex + 2]
        : afterClose?.type === "punct" && jsTokenText(text, afterClose) === "="
          ? requiredModuleToken(text, tokens, closeIndex + 2)
          : undefined;
    if (source?.type !== "string" || !modules.has(source.value ?? "")) {
      openIndex = closeIndex;
      continue;
    }

    let bindingDepth = 0;
    for (let index = openIndex + 1; index < closeIndex; index += 1) {
      const token = tokens[index];
      const value = jsTokenText(text, token);
      if (token.type === "punct" && ["{", "["].includes(value)) bindingDepth += 1;
      if (token.type === "punct" && ["}", "]"].includes(value)) bindingDepth -= 1;
      if (bindingDepth !== 0 || token.type !== "ident" || !exports.has(value)) continue;
      const separator = tokens[index + 1];
      const renamed = tokens[index + 2];
      const separatorText = separator ? jsTokenText(text, separator) : "";
      if (
        renamed?.type === "ident" &&
        ((separator?.type === "punct" && separatorText === ":") ||
          (separator?.type === "ident" && separatorText === "as"))
      ) {
        aliases.add(jsTokenText(text, renamed));
      }
    }
    openIndex = closeIndex;
  }
  return aliases;
}

function requiredModuleToken(
  text: string,
  tokens: JsToken[],
  startIndex: number,
): JsToken | undefined {
  const requireToken = tokens[startIndex];
  const open = tokens[startIndex + 1];
  const module = tokens[startIndex + 2];
  const close = tokens[startIndex + 3];
  return requireToken?.type === "ident" &&
    jsTokenText(text, requireToken) === "require" &&
    open?.type === "punct" &&
    jsTokenText(text, open) === "(" &&
    module?.type === "string" &&
    close?.type === "punct" &&
    jsTokenText(text, close) === ")"
    ? module
    : undefined;
}

/**
 * Resolve simple assignment aliases in O(tokens + edges) with a worklist.
 * Reverse-ordered chains are common in generated code and must not turn one
 * synchronous dependency assessment into an unbounded quadratic scan.
 */
function simpleAliases(
  text: string,
  tokens: JsToken[],
  isSeed: (sourceIndex: number) => boolean,
  initialAliases: Iterable<string> = [],
): Set<string> {
  const aliases = new Set<string>();
  const downstream = new Map<string, string[]>();
  const queue = [...initialAliases];
  for (let index = 0; index < tokens.length - 2; index += 1) {
    const target = tokens[index];
    const equals = tokens[index + 1];
    const source = tokens[index + 2];
    if (
      target.type !== "ident" ||
      equals?.type !== "punct" ||
      jsTokenText(text, equals) !== "=" ||
      source?.type !== "ident"
    ) {
      continue;
    }
    const targetPrevious = tokens[index - 1];
    if (
      targetPrevious?.type === "punct" &&
      [".", "?."].includes(jsTokenText(text, targetPrevious))
    ) {
      continue;
    }
    const targetName = jsTokenText(text, target);
    if (isSeed(index + 2)) {
      queue.push(targetName);
      continue;
    }
    const afterSource = tokens[index + 3];
    if (afterSource?.type === "punct" && jsTokenText(text, afterSource) === "(") continue;
    const sourceName = jsTokenText(text, source);
    const targets = downstream.get(sourceName) ?? [];
    targets.push(targetName);
    downstream.set(sourceName, targets);
  }

  while (queue.length) {
    const alias = queue.pop();
    if (!alias || aliases.has(alias)) continue;
    aliases.add(alias);
    queue.push(...(downstream.get(alias) ?? []));
  }
  return aliases;
}

interface DependencyInstallRiskClassification {
  severity: "medium" | "high" | "critical";
  certainty: "observed" | "unknown";
  strong: boolean;
  /** The install path can invoke or load native code, rather than a downloader-shaped capability. */
  nativeExecution: boolean;
  observedCapabilities: string[];
}

/** One policy mapping shared by finding projection and UI rendering. */
export function classifyDependencyInstallRisk(
  evidence: Pick<
    DependencyArtifactAssessment,
    "observation" | "capabilities" | "installReachableCapabilities"
  >,
): DependencyInstallRiskClassification | null {
  if (evidence.observation.risk === "not-observed") return null;
  const provenDanger = evidence.installReachableCapabilities.some((ruleId) =>
    INSTALL_TIME_DANGER_RULE_IDS.has(ruleId),
  );
  const nativeExecution =
    !provenDanger &&
    (hasReachableNativeExecution(evidence.installReachableCapabilities) ||
      (evidence.observation.dynamicInstallTarget === true &&
        evidence.capabilities.includes(DETERMINISTIC_RULE_IDS.fileNativeArtifact)));
  const certainty = evidence.observation.risk === "observed" ? "observed" : "unknown";
  const observedCapabilities =
    certainty === "observed" ? evidence.installReachableCapabilities : evidence.capabilities;
  const strong = observedCapabilities.some((ruleId) => STRONG_INSTALL_DANGER_RULE_IDS.has(ruleId));
  return {
    severity: nativeExecution
      ? "high"
      : certainty === "observed"
        ? strong
          ? "critical"
          : "high"
        : strong
          ? "high"
          : "medium",
    certainty,
    strong,
    nativeExecution,
    observedCapabilities,
  };
}

function installScriptCapabilities(
  installCommands: ReturnType<typeof consumerInstallScriptCommands>,
  options: DeterministicFindingOptions,
): string[] {
  const capabilities = new Set<string>();
  for (const [index, { command }] of installCommands.entries()) {
    const findings = deterministicFindings(
      [
        {
          path: `<install-script>/${index}.js`,
          size: command.length,
          sha256: "",
          textSample: command,
          flags: [],
        },
      ],
      [],
      null,
      options,
    );
    for (const finding of findings) {
      if (finding.ruleId && INSTALL_TIME_DANGER_RULE_IDS.has(finding.ruleId)) {
        capabilities.add(finding.ruleId);
      }
    }
  }
  return [...capabilities];
}

function hasDynamicInstallCommand(command: string): boolean {
  if (
    hasDynamicModuleLoad(command) ||
    hasDynamicLocalExecution(command) ||
    hasDynamicShellCommand(command)
  ) {
    return true;
  }
  for (const program of inlineNodePrograms(command)) {
    if (hasDynamicModuleLoad(program) || hasDynamicLocalExecution(program)) return true;
  }
  return false;
}

const SHELL_INTERPRETERS = new Set(["bash", "dash", "ksh", "sh", "zsh"]);
const SHELL_COMMAND_OPERATORS = new Set([";", "&&", "||", "|"]);

/** True when a shell command chooses the executable at runtime. */
function hasDynamicShellCommand(command: string, inspectInlineShell = true): boolean {
  const words = shellCommandWords(command);
  for (let index = 0; index < words.length;) {
    while (SHELL_COMMAND_OPERATORS.has(words[index] ?? "")) index += 1;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index += 1;
    const program = words[index];
    if (!program) break;
    if (hasShellExpansion(program)) return true;

    const end = words.findIndex(
      (word, wordIndex) => wordIndex > index && SHELL_COMMAND_OPERATORS.has(word),
    );
    const commandEnd = end === -1 ? words.length : end;
    if (inspectInlineShell && SHELL_INTERPRETERS.has(program)) {
      const commandFlag = words.slice(index + 1, commandEnd).findIndex((word) => word === "-c");
      if (commandFlag !== -1) {
        const inline = words[index + 1 + commandFlag + 1];
        if (inline && hasDynamicShellCommand(inline, false)) return true;
      }
    }
    index = commandEnd + 1;
  }
  return false;
}

function hasShellExpansion(value: string): boolean {
  return /`|\$\(|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(value);
}

/** Extract bounded `node -e` / `node --eval` bodies without invoking a shell. */
function inlineNodePrograms(command: string): string[] {
  const programs: string[] = [];
  const pattern =
    /\b(?:node|nodejs)\s+(?:(?:--eval|--print)(?:=|\s+)|(?:-e|-p)\s+)(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s;&|]+))/g;
  for (const match of command.matchAll(pattern)) {
    programs.push(match[1] ?? match[2] ?? match[3]);
  }
  return programs;
}

function hasReachableNativeExecution(capabilities: string[]): boolean {
  return capabilities.includes(DETERMINISTIC_RULE_IDS.fileNativeArtifact);
}

/** True only when a capability set proves danger on the install-reachable path. */
export function hasObservedInstallRisk(capabilities: string[]): boolean {
  return (
    capabilities.some((ruleId) => INSTALL_TIME_DANGER_RULE_IDS.has(ruleId)) ||
    hasReachableNativeExecution(capabilities)
  );
}

function executionEntrypoints(
  findings: Finding[],
  scripts: Record<string, string>,
  implicitScripts: Record<string, string>,
): DependencyExecutionEntrypoint[] {
  const entrypoints: DependencyExecutionEntrypoint[] = [];
  for (const script of ["preinstall", "install", "postinstall"]) {
    if (!scripts[script] || implicitScripts[script] === scripts[script]) continue;
    entrypoints.push({ kind: "script", name: script });
  }
  for (const finding of findings) {
    if (!finding.ruleId || !AUTOMATIC_EXECUTION_RULE_IDS.has(finding.ruleId)) continue;
    if (finding.ruleId === DETERMINISTIC_RULE_IDS.installScript) continue;
    if (finding.ruleId === DETERMINISTIC_RULE_IDS.installScriptPreinstall) continue;
    entrypoints.push({ kind: "node-gyp", name: finding.file });
  }
  return entrypoints;
}
