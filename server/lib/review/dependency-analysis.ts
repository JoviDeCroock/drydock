import type { FileRecord, Finding, PackageJsonSummary } from "./";
import {
  DETERMINISTIC_RULE_IDS,
  deterministicFindings,
  type DeterministicFindingOptions,
} from "./rules";
import {
  consumerInstallScriptCommands,
  lifecycleReachablePaths,
  normalizeReachabilityPath,
} from "./rules/reachability";
import { normalizeStringRecord } from "../tar-parser.js";
import { jsTokenText, tokenizeJs } from "../platform/js-lexer";
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
  const capabilities = [
    ...new Set(findings.flatMap((finding) => (finding.ruleId ? [finding.ruleId] : []))),
  ].sort();

  const reachable = lifecycleReachablePaths(files, scripts, implicitScripts);
  const inlineInstallCapabilities = installScriptCapabilities(scripts, implicitScripts, options);
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

  // A computed require/import can target any omitted file. Do not guess from
  // extensions: Node loaders and package hooks can execute extensionless or
  // custom-extension content. Once the install path contains a dynamic module
  // edge, every deliberately omitted body is an unresolved coverage gap.
  const omittedFiles = files.filter((file) => file.flags.includes("text-sample-skipped"));
  const filesByPath = new Map(
    files.map((file) => [normalizeReachabilityPath(file.path), file] as const),
  );
  const hasDynamicInstallModuleLoad =
    automaticExecution.length > 0 &&
    omittedFiles.length > 0 &&
    [...reachable].some((path) => {
      const file = filesByPath.get(path);
      return file?.textSample ? hasDynamicModuleLoad(file.textSample) : false;
    });
  const installReachableUninspectedFiles = [
    ...new Set([
      ...directlyReachableUninspectedFiles,
      ...(hasDynamicInstallModuleLoad ? omittedFiles.map((file) => file.path) : []),
    ]),
  ].sort();

  const executionObserved = automaticExecution.length > 0;
  const reachableDanger = hasObservedInstallRisk(installReachableCapabilities);
  const anyDanger = capabilities.some((ruleId) => INSTALL_TIME_DANGER_RULE_IDS.has(ruleId));
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
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    let openIndex: number;
    if (token.type === "ident") {
      const callee = jsTokenText(text, token);
      if (callee !== "require" && callee !== "import") continue;
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
    const argument = tokens[openIndex + 1];
    if (!argument || (argument.type === "punct" && jsTokenText(text, argument) === ")")) continue;
    const afterArgument = tokens[openIndex + 2];
    const argumentEndsSpecifier =
      afterArgument?.type === "punct" && [")", ","].includes(jsTokenText(text, afterArgument));
    const staticSpecifier =
      argument.type === "string" ||
      (argument.type === "template" && !jsTokenText(text, argument).includes("${"));
    if (!staticSpecifier || !argumentEndsSpecifier) return true;
  }
  return false;
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
    !provenDanger && hasReachableNativeExecution(evidence.installReachableCapabilities);
  const certainty = evidence.observation.risk === "observed" ? "observed" : "unknown";
  const observedCapabilities =
    certainty === "observed" ? evidence.installReachableCapabilities : evidence.capabilities;
  const strong = observedCapabilities.some((ruleId) => STRONG_INSTALL_DANGER_RULE_IDS.has(ruleId));
  return {
    severity:
      certainty === "observed" ? (strong ? "critical" : "high") : strong ? "high" : "medium",
    certainty,
    strong,
    nativeExecution,
    observedCapabilities,
  };
}

function installScriptCapabilities(
  scripts: Record<string, string>,
  implicitScripts: Record<string, string>,
  options: DeterministicFindingOptions,
): string[] {
  const capabilities = new Set<string>();
  for (const [index, { command }] of consumerInstallScriptCommands(
    scripts,
    implicitScripts,
  ).entries()) {
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
