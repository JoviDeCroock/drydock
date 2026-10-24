import { hasImplicitNodeGypInstall, normalizeStringRecord } from "../tar-parser.js";
import { isRecord } from "../platform/guards";
import { jsTokenText, tokenizeJsWithinBudget } from "../platform/js-lexer";
import { hasMatchingCodeLine } from "../platform/text-utils";
import { DETERMINISTIC_RULE_IDS, deterministicFindings, safeJson } from "./rules";
import {
  codePatternsFor,
  FINDING_SECRET_PATTERNS,
  JS_PATTERN_SET,
  PROMPT_INJECTION_PATTERN_SET,
  PYTHON_PATTERN_SET,
  REVIEW_MANIPULATION_PATTERN_SET,
  SHELL_DOWNLOAD_EXECUTE_PATTERN_SET,
} from "./rules/patterns";
import { promptInjectionPatternsMatchChangedLines } from "./rules/prompt-injection";
import {
  codeViewsForScanning,
  normalizeCodeForScanning,
  withNormalizeMemo,
} from "./rules/normalize";
import { deterministicRuleIds } from "./rules/rule-ids";
import {
  installReachablePaths,
  javascriptReachableFrom,
  normalizeReachabilityPath,
  type ReachabilityLexing,
} from "./rules/reachability";
import {
  changedRegions,
  changedRegionTexts,
  patternsTouchChangedRegions,
  type ChangedRegions,
} from "./changed-regions";
import type {
  CodePatternSet,
  FileRecord,
  FindingAnnotationOptions,
  FindingDiffAnnotation,
  FindingDiffStatus,
  Finding,
} from "./types";
import type { PackageJsonSummary } from "./serialize";

export function projectReleaseRuleFindings(
  findings: Array<Finding & FindingDiffAnnotation>,
): Finding[] {
  return findings
    .filter((finding) => finding.releaseDelta)
    .map((finding) => ({
      severity: finding.severity,
      file: finding.file,
      evidence: finding.evidence,
      reason: finding.reason,
      ...(finding.line !== undefined ? { line: finding.line } : {}),
      ...(finding.ruleId !== undefined ? { ruleId: finding.ruleId } : {}),
      ...(finding.ruleVersion !== undefined ? { ruleVersion: finding.ruleVersion } : {}),
    }));
}

export function annotateFindingsWithDiffStatus<
  T extends {
    id?: string;
    file: string;
    line?: number | null;
    ruleId?: string | null;
    severity?: string | null;
    evidence?: string | null;
  },
>(
  findings: T[],
  diff: Array<{ path: string; status?: unknown; renamedFrom?: unknown }>,
  options: FindingAnnotationOptions = {},
): Array<T & FindingDiffAnnotation> {
  return withNormalizeMemo(() => annotateFindings(findings, diff, options));
}

function annotateFindings<
  T extends {
    id?: string;
    file: string;
    line?: number | null;
    ruleId?: string | null;
    severity?: string | null;
    evidence?: string | null;
  },
>(
  findings: T[],
  diff: Array<{ path: string; status?: unknown; renamedFrom?: unknown }>,
  options: FindingAnnotationOptions,
): Array<T & FindingDiffAnnotation> {
  const diffByPath = new Map(
    diff.map((entry) => [entry.path, normalizeFindingDiffStatus(entry.status)]),
  );
  const previousByPath = new Map((options.previousFiles ?? []).map((file) => [file.path, file]));
  const stagedByPath = new Map((options.stagedFiles ?? []).map((file) => [file.path, file]));
  // An added file renamed from a removed one (a bundler chunk under a new
  // content hash) is attributed as that predecessor modified: changed spans,
  // baseline findings and `expanded` all read the predecessor's bytes. Its
  // reported diffStatus stays `added`. Without the predecessor's text it keeps
  // the full added-file treatment.
  const predecessors = renamedPredecessors(diff, diffByPath, previousByPath);
  const attributionStatus = (path: string, status: FindingDiffStatus): FindingDiffStatus =>
    status === "added" && predecessors.has(path) ? "modified" : status;
  const comparedByPath = new Map([...previousByPath, ...predecessors]);
  const newlyInstallReachable = lazyNewlyInstallReachablePaths(
    options.previousFiles ?? [],
    options.stagedFiles ?? [],
    options.codePatternSet,
    (path) => attributionStatus(path, diffByPath.get(path) ?? "unknown"),
    predecessors,
  );
  const changesCache = new Map<string, FileChanges | null>();
  const changesFor = (path: string) =>
    fileChangesForPath(path, comparedByPath, stagedByPath, changesCache, options.codePatternSet);
  // Both readers of the baseline finding set ask only about modified files, so
  // the rules re-run over those and the manifests that give them context.
  // Fewer baseline files can only mean fewer baseline fingerprints, which
  // classifies more findings as new — never fewer.
  const baselineFingerprints = lazyBaselineFingerprints(
    [
      ...(options.previousFiles ?? []).filter(
        (file) => diffByPath.get(file.path) === "modified" || isManifestPath(file.path),
      ),
      // A predecessor's findings are keyed by the path that replaced it.
      ...[...predecessors].map(([path, file]) => ({ ...file, path })),
    ],
    options.codePatternSet,
  );
  const annotated = findings.map((finding) => {
    const persisted = finding.id ? options.persistedAnnotations?.get(finding.id) : null;
    if (persisted) return { ...finding, ...persisted };

    // Without a downloaded baseline every file reads as `added`, which would
    // score the package's whole contents as this release's delta. Report the
    // comparison as missing instead of inventing one.
    if (options.baselineComparisonSkipped) {
      return { ...finding, diffStatus: "unknown" as FindingDiffStatus, releaseDelta: false };
    }

    const diffStatus = diffByPath.get(finding.file) ?? "unknown";
    return {
      ...finding,
      diffStatus,
      releaseDelta:
        lifecycleCommandReleaseDelta(finding, previousByPath, stagedByPath) ??
        (isReleaseScopedFinding(finding) ||
          isNewlyEnabledImplicitNodeGypFinding(finding, previousByPath, stagedByPath) ||
          ((CAPABILITY_RULE_IDS.has(finding.ruleId ?? "") ||
            finding.ruleId === DETERMINISTIC_RULE_IDS.fileNativeArtifact ||
            finding.ruleId?.startsWith("propagation.")) &&
            newlyInstallReachable().has(normalizeReachabilityPath(finding.file))) ||
          isFindingOnReleaseDelta(
            finding,
            attributionStatus(finding.file, diffStatus),
            changesFor,
            options.codePatternSet,
            baselineFingerprints,
          )),
    };
  });
  if (options.baselineComparisonSkipped) return annotated;
  return markExpandedCapabilities(annotated, {
    modified: (finding) => attributionStatus(finding.file, finding.diffStatus) === "modified",
    persisted: (finding) => Boolean(finding.id && options.persistedAnnotations?.has(finding.id)),
    changesFor,
    baselineFingerprints,
    baselineHosts: lazyBaselineHosts(options.previousFiles ?? []),
    codePatternSet: options.codePatternSet,
  });
}

function renamedPredecessors(
  diff: Array<{ path: string; status?: unknown; renamedFrom?: unknown }>,
  diffByPath: Map<string, FindingDiffStatus>,
  previousByPath: Map<string, Pick<FileRecord, "path" | "textSample" | "flags">>,
): Map<string, Pick<FileRecord, "path" | "textSample" | "flags">> {
  const predecessors = new Map<string, Pick<FileRecord, "path" | "textSample" | "flags">>();
  const claimed = new Set<string>();
  for (const entry of diff) {
    if (entry.status !== "added" || typeof entry.renamedFrom !== "string") continue;
    // The diff is data that may have round-tripped through storage: honour a
    // pairing only onto a file this release removed, and only once.
    if (claimed.has(entry.renamedFrom) || diffByPath.get(entry.renamedFrom) !== "removed") continue;
    if (previousByPath.has(entry.path)) continue;
    const predecessor = previousByPath.get(entry.renamedFrom);
    if (!predecessor?.textSample || predecessor.flags.includes("binary")) continue;
    claimed.add(entry.renamedFrom);
    predecessors.set(entry.path, predecessor);
  }
  return predecessors;
}

function lifecycleCommandReleaseDelta(
  finding: { file: string; ruleId?: string | null; evidence?: string | null },
  previousByPath: Map<string, Pick<FileRecord, "path" | "textSample" | "flags">>,
  stagedByPath: Map<string, Pick<FileRecord, "path" | "textSample" | "flags">>,
): boolean | undefined {
  if (
    finding.ruleId !== DETERMINISTIC_RULE_IDS.installScript &&
    finding.ruleId !== DETERMINISTIC_RULE_IDS.installScriptPreinstall
  )
    return undefined;

  // A display line can contain unrelated version edits or an earlier duplicate
  // key. Only the effective parsed command establishes whether this hook changed.
  const allowedHooks =
    finding.ruleId === DETERMINISTIC_RULE_IDS.installScriptPreinstall
      ? ["preinstall"]
      : ["install", "postinstall"];
  const hook = allowedHooks.find((name) => finding.evidence?.startsWith(`${name}: `));
  const previous = lifecycleScripts(previousByPath.get(finding.file));
  const staged = lifecycleScripts(stagedByPath.get(finding.file));
  if (!hook || !previous || !staged || !staged[hook]) return true;
  const command = staged[hook];
  if (finding.evidence !== `${hook}: ${command}` || /\[REDACTED[^\]]*\]/.test(command)) return true;
  return previous[hook] !== command;
}

function lifecycleScripts(
  file: Pick<FileRecord, "textSample"> | undefined,
): Record<string, string> | null {
  if (!file?.textSample) return null;
  const parsed = safeJson(file.textSample);
  if (!isRecord(parsed) || (parsed.scripts !== undefined && !isRecord(parsed.scripts))) return null;
  return normalizeStringRecord(parsed.scripts);
}

// An unchanged hook can gain an import of dormant code. Its newly activated
// findings belong to this release even when the payload bytes themselves did not change.
function lazyNewlyInstallReachablePaths(
  previousFiles: Array<Pick<FileRecord, "path" | "textSample" | "flags">>,
  stagedFiles: Array<Pick<FileRecord, "path" | "textSample" | "flags">>,
  codePatternSet: CodePatternSet | undefined,
  statusOf: (path: string) => FindingDiffStatus,
  predecessors: Map<string, Pick<FileRecord, "path" | "textSample" | "flags">>,
): () => Set<string> {
  let computed: Set<string> | undefined;
  return () => {
    if (computed) return computed;
    const reachable = (
      files: typeof previousFiles,
      executionEvidenceOnly = true,
      lexing?: ReachabilityLexing,
    ) => {
      const scripts = lifecycleScripts(files.find((file) => file.path === "package.json"));
      if (!scripts) return new Set<string>();
      const records = files.map((file) => ({ ...file, size: 0, sha256: "" }));
      return installReachablePaths(
        records,
        scripts,
        {},
        codePatternSet,
        executionEvidenceOnly,
        lexing,
      );
    };
    // A previous graph built past a lexer give-up over-counts, which would
    // shrink "newly reachable"; credit nothing as already reachable instead.
    const previousLexing: ReachabilityLexing = { gaveUp: false };
    const previousReachable = reachable(previousFiles, true, previousLexing);
    const previous = previousLexing.gaveUp ? new Set<string>() : previousReachable;
    // A renamed file was reachable before when its predecessor was.
    for (const [path, predecessor] of predecessors) {
      if (previous.has(normalizeReachabilityPath(predecessor.path))) {
        previous.add(normalizeReachabilityPath(path));
      }
    }
    const staged = reachable(stagedFiles);
    const possiblyInstalled = reachable(stagedFiles, false);
    const previousSource = new Map([
      ...previousFiles.map((file) => [file.path, file.textSample] as const),
      ...[...predecessors].map(([path, file]) => [path, file.textSample] as const),
    ]);
    const changedInstallFiles = stagedFiles
      .filter(
        (file) =>
          statusOf(file.path) === "modified" &&
          possiblyInstalled.has(normalizeReachabilityPath(file.path)) &&
          installCodeChanged(previousSource.get(file.path), file.textSample),
      )
      .map((file) => normalizeReachabilityPath(file.path));
    // A static graph cannot prove that an old import actually ran (it may have
    // lived inside an unused function). Recheck its dangerous descendants when
    // install code changes, instead of crediting prior graph membership as safety.
    const activatedByChanges = javascriptReachableFrom(
      stagedFiles.map((file) => ({ ...file, size: 0, sha256: "" })),
      changedInstallFiles,
      true,
    );
    computed = new Set([
      ...[...staged].filter((path) => !previous.has(path)),
      ...activatedByChanges,
    ]);
    return computed;
  };
}

function installCodeChanged(previous: string | undefined, staged: string | undefined): boolean {
  if (previous === undefined || staged === undefined) return true;
  const codeTokens = (source: string) => {
    const normalized = normalizeCodeForScanning(source);
    const lexed = tokenizeJsWithinBudget(normalized);
    if (!lexed) return null;
    const tokens = lexed.filter((token) => token.type !== "ws" && token.type !== "comment");
    return tokens.map((token, index) => [
      token.type,
      token.type === "string" ? token.value : jsTokenText(normalized, token),
      // A newline after return/yield or before a postfix expression can change
      // execution through ASI even when all non-whitespace tokens are equal.
      index > 0 && /[\r\n\u2028\u2029]/.test(normalized.slice(tokens[index - 1].end, token.start)),
    ]);
  };
  // A source the lexer gives up on counts as changed.
  const before = codeTokens(previous);
  const after = codeTokens(staged);
  if (!before || !after) return true;
  return JSON.stringify(before) !== JSON.stringify(after);
}

/**
 * An AI finding prepared for release attribution: file-level, whatever line it
 * records. A rule finding whose line did not change is rescued by re-matching
 * its pattern on the changed lines; an AI finding has no pattern, so a line
 * copied from a decoy earlier in the file (search returns the first match)
 * would move a newly added call out of the release. The line stays on the
 * finding for display and evidence only.
 */
export function withoutFindingLine<T extends { line?: number | null }>(
  finding: T,
): Omit<T, "line"> {
  const { line: _line, ...rest } = finding;
  return rest;
}

function isReleaseScopedFinding(finding: {
  ruleId?: string | null;
  severity?: string | null;
}): boolean {
  // Only the regression variant is about this release: a manifest that has
  // always over-claimed an entrypoint (medium) is package context, and scoping
  // it to the release would raise release risk on every rescan of that package.
  if (finding.ruleId === DETERMINISTIC_RULE_IDS.packageJsonEntrypointMissing) {
    return finding.severity === "high";
  }
  return Boolean(
    finding.ruleId?.startsWith("stage.") ||
    // release.* rules describe how THIS release arrived (burst/source
    // fingerprints), so they are always release-scoped even though their
    // synthetic file label never appears in the artifact diff.
    finding.ruleId?.startsWith("release.") ||
    finding.ruleId?.startsWith("pypi.") ||
    finding.ruleId?.startsWith("vscode.") ||
    finding.ruleId === DETERMINISTIC_RULE_IDS.dependencyUnusualSpec ||
    finding.ruleId === DETERMINISTIC_RULE_IDS.dependencyOptionalAdded ||
    finding.ruleId === DETERMINISTIC_RULE_IDS.dependencyAdded ||
    finding.ruleId === DETERMINISTIC_RULE_IDS.dependencyMajorBump ||
    finding.ruleId === DETERMINISTIC_RULE_IDS.diffCredentialFileAdded ||
    finding.ruleId === DETERMINISTIC_RULE_IDS.diffLargeNewFile ||
    finding.ruleId === DETERMINISTIC_RULE_IDS.tarSuspiciousEntry,
  );
}

function isNewlyEnabledImplicitNodeGypFinding(
  finding: { ruleId?: string | null },
  previousByPath: Map<string, Pick<FileRecord, "path" | "textSample" | "flags">>,
  stagedByPath: Map<string, Pick<FileRecord, "path" | "textSample" | "flags">>,
): boolean {
  if (finding.ruleId !== DETERMINISTIC_RULE_IDS.installScriptImplicitNodeGyp) return false;

  const stagedPackageJson = parsePackageJsonFile(stagedByPath.get("package.json"));
  if (!hasImplicitNodeGypInstall([...stagedByPath.values()], stagedPackageJson)) return false;

  const previousPackageJson = parsePackageJsonFile(previousByPath.get("package.json"));
  return !hasImplicitNodeGypInstall([...previousByPath.values()], previousPackageJson);
}

function parsePackageJsonFile(
  file: Pick<FileRecord, "textSample"> | undefined,
): PackageJsonSummary | null {
  if (!file?.textSample) return null;
  return safeJson(file.textSample) as PackageJsonSummary | null;
}

function isFindingOnReleaseDelta(
  finding: { file: string; line?: number | null; ruleId?: string | null },
  diffStatus: FindingDiffStatus,
  changesFor: (path: string) => FileChanges | null,
  codePatternSet: CodePatternSet | undefined,
  baselineFingerprints: () => Set<string> | null,
): boolean {
  if (diffStatus === "added") return true;
  if (diffStatus !== "modified") return false;
  // When line-level evidence is unavailable (no recorded line, binary file, or
  // missing text samples), fall back to the baseline finding set: if the same
  // rule already fired on the same file in the baseline version, the capability
  // pre-existed the release and reads as package context. Without a baseline
  // counterpart the classification still fails open to release delta.
  if (!finding.line) return !baselineHasFinding(baselineFingerprints, finding);

  const changes = changesFor(finding.file);
  if (!changes) return !baselineHasFinding(baselineFingerprints, finding);
  if (changes.raw.lines.has(finding.line)) return true;
  const patterns = patternsForFinding(finding, codePatternSet);
  // A rule with no patterns on a narrowed (minified) line keeps line-level
  // behaviour: the line changed, so the finding is on the delta.
  if (!patterns.length) return changes.raw.refinedLines.has(finding.line);
  return findingPatternMatchesChanges(finding, patterns, changes);
}

// A modified file's changed regions, raw and (JavaScript) constant-folded.
// Detection matches both texts, so release classification must too: a payload
// assembled from string pieces (`'chi' + 'ld_process'`) only matches after
// folding, and a raw-only check read it as package context whenever the file
// already used the same capability on an unchanged line.
interface FileChanges {
  stagedText: string;
  raw: ChangedRegions;
  folded: () => { text: string; regions: ChangedRegions } | null;
  // Comment-blind views of the staged and folded texts (same offsets).
  code: (text: string) => string;
}

function fileChangesForPath(
  path: string,
  previousByPath: Map<string, Pick<FileRecord, "path" | "textSample" | "flags">>,
  stagedByPath: Map<string, Pick<FileRecord, "path" | "textSample" | "flags">>,
  cache: Map<string, FileChanges | null>,
  codePatternSet: CodePatternSet | undefined,
): FileChanges | null {
  if (cache.has(path)) return cache.get(path) ?? null;
  const previous = previousByPath.get(path);
  const staged = stagedByPath.get(path);
  if (
    !previous?.textSample ||
    !staged?.textSample ||
    previous.flags.includes("binary") ||
    staged.flags.includes("binary")
  ) {
    cache.set(path, null);
    return null;
  }
  const previousText = previous.textSample;
  const stagedText = staged.textSample;
  const foldable = codePatternSet !== "python" && !path.endsWith(".py");
  let folded: { text: string; regions: ChangedRegions } | null | undefined;
  const codeViews = new Map<string, string>();
  const changes: FileChanges = {
    code: (text) => {
      let view = codeViews.get(text);
      if (view === undefined) {
        view = codeViewsForScanning(path, text).code;
        codeViews.set(text, view);
      }
      return view;
    },
    stagedText,
    raw: changedRegions(previousText, stagedText),
    folded: () => {
      if (folded !== undefined) return folded;
      if (!foldable) return (folded = null);
      const text = normalizeCodeForScanning(stagedText);
      const previousFolded = normalizeCodeForScanning(previousText);
      folded =
        text === stagedText && previousFolded === previousText
          ? null
          : { text, regions: changedRegions(previousFolded, text) };
      return folded;
    },
  };
  cache.set(path, changes);
  return changes;
}

function findingPatternMatchesChanges(
  finding: { file: string; ruleId?: string | null },
  patterns: RegExp[],
  changes: FileChanges,
): boolean {
  // The propagation and prompt-injection matchers are line-oriented; they see
  // every changed line, narrowed ones included, as before.
  if (isPropagationFinding(finding) || isPromptInjectionFinding(finding)) {
    const changedLines = new Set([...changes.raw.lines, ...changes.raw.refinedLines]);
    if (isPropagationFinding(finding)) {
      return hasMatchingCodeLine(changes.stagedText, patterns, changedLines);
    }
    return promptInjectionPatternsMatchChangedLines(
      changes.stagedText,
      changedLines,
      patterns,
      finding.ruleId === DETERMINISTIC_RULE_IDS.filePromptInjection
        ? REVIEW_MANIPULATION_PATTERN_SET
        : [],
    );
  }
  // Detection reads these rules comment-blind in JavaScript, so an edited
  // comment beside an older call is not that call arriving. Blanking keeps
  // offsets, so the changed regions still apply.
  const view = COMMENT_BLIND_RULE_IDS.has(finding.ruleId ?? "")
    ? changes.code
    : (text: string) => text;
  if (patternsTouchChangedRegions(view(changes.stagedText), changes.raw, patterns)) return true;
  const folded = changes.folded();
  return Boolean(
    folded && patternsTouchChangedRegions(view(folded.text), folded.regions, patterns),
  );
}

const COMMENT_BLIND_RULE_IDS = new Set<string>([
  DETERMINISTIC_RULE_IDS.codeNetworkAccess,
  DETERMINISTIC_RULE_IDS.codeDynamicEvaluation,
  DETERMINISTIC_RULE_IDS.codeCredentialAccess,
]);

// Whether the file's changes match some capability pattern only once string
// pieces are joined (`'chi' + 'ld_process'`), even where a sibling pattern
// (`execSync`) matches raw. Judged over the whole change, not per finding, so
// where the payload sits in the file does not matter.
function hasAssembledChange(
  changes: FileChanges | null,
  codePatternSet: CodePatternSet | undefined,
): boolean {
  const folded = changes?.folded();
  if (!changes || !folded) return false;
  const patterns = codePatternsFor(codePatternSet);
  return [
    ...patterns.processExecution,
    ...patterns.networkAccess,
    ...patterns.dynamicEvaluation,
    ...patterns.credentialAccess,
    ...patterns.remoteShell,
  ].some(
    (pattern) =>
      patternsTouchChangedRegions(folded.text, folded.regions, [pattern]) &&
      !patternsTouchChangedRegions(changes.stagedText, changes.raw, [pattern]),
  );
}

function isPropagationFinding(finding: { ruleId?: string | null }): boolean {
  return (
    finding.ruleId === DETERMINISTIC_RULE_IDS.propagationRegistryPublish ||
    finding.ruleId === DETERMINISTIC_RULE_IDS.propagationPackageMutation
  );
}

function isPromptInjectionFinding(finding: { ruleId?: string | null }): boolean {
  return (
    finding.ruleId === DETERMINISTIC_RULE_IDS.filePromptInjection ||
    finding.ruleId === DETERMINISTIC_RULE_IDS.fileReviewManipulation
  );
}

function patternsForFinding(
  finding: { file: string; ruleId?: string | null },
  codePatternSet: CodePatternSet | undefined,
): RegExp[] {
  const patterns = codePatternSet
    ? codePatternsFor(codePatternSet)
    : finding.file.endsWith(".py")
      ? PYTHON_PATTERN_SET
      : JS_PATTERN_SET;
  switch (finding.ruleId) {
    case DETERMINISTIC_RULE_IDS.codeProcessExecution:
      return patterns.processExecution;
    case DETERMINISTIC_RULE_IDS.codeRemoteShell:
      // Both sets, because the finding's recorded line comes from whichever
      // matched: `scripts.ts` prefers the download-and-execute line when one
      // exists and falls back to the bare shell-tool line otherwise. Omitting
      // this case entirely (the `default: []` below) is not a silent
      // degradation — it removes the rule from the release delta, so a decoy
      // `curl` in an untouched comment earlier in the file pins the finding's
      // line to an unchanged line and the newly added dropper stops counting
      // toward `releaseRisk`, which is exactly what the gate reads.
      return [...patterns.remoteShell, ...SHELL_DOWNLOAD_EXECUTE_PATTERN_SET];
    case DETERMINISTIC_RULE_IDS.codeNetworkAccess:
      return patterns.networkAccess;
    case DETERMINISTIC_RULE_IDS.codeDynamicEvaluation:
      return patterns.dynamicEvaluation;
    case DETERMINISTIC_RULE_IDS.codeCredentialAccess:
      return patterns.credentialAccess;
    case DETERMINISTIC_RULE_IDS.propagationRegistryPublish:
      return patterns.registryPublish;
    case DETERMINISTIC_RULE_IDS.propagationPackageMutation:
      return [...patterns.installRootPath, ...patterns.installWrite, ...patterns.installLink];
    case DETERMINISTIC_RULE_IDS.fileSecretContent:
      // The finding-side set, so line matching agrees with what detection
      // actually flagged (placeholder URL credentials are not secrets).
      return FINDING_SECRET_PATTERNS.map(([pattern]) => pattern);
    case DETERMINISTIC_RULE_IDS.filePromptInjection:
      return PROMPT_INJECTION_PATTERN_SET;
    case DETERMINISTIC_RULE_IDS.fileReviewManipulation:
      return REVIEW_MANIPULATION_PATTERN_SET;
    default:
      return [];
  }
}

const CAPABILITY_RULE_IDS = deterministicRuleIds(
  (spec) => spec.risk === "capability" || spec.risk === "weak-lone-capability",
);
const STANDING_DANGER_RULE_IDS = deterministicRuleIds((spec) => spec.standingDanger === true);
// Reading one more environment variable is reading a different credential,
// not more of the same capability (`HOME` in the baseline says nothing about a
// new `npm_config__authToken` read), and a new eval site runs new code whatever
// the file compiled before.
const NEVER_EXPANDED_RULE_IDS = new Set<string>([
  DETERMINISTIC_RULE_IDS.codeCredentialAccess,
  DETERMINISTIC_RULE_IDS.codeDynamicEvaluation,
]);
// A release that only adds more of what a modified file already did (more
// package-manager spawns in a CLI, another request in an HTTP client) is still
// in the release, but growing one capability is not the shape of a payload
// arriving. Such capability findings are marked `expanded`, and release risk
// scores each one step lower; they still count toward capability
// co-occurrence (see computeRisk), so a combination across files keeps its
// floor. A file keeps full scoring when anything in its delta is new to it: a
// finding for a rule its baseline version did not have, an obfuscated match, a
// change that matches a capability only once string pieces are joined, or a
// host the baseline package never named. Credential access and
// standing-danger evidence are never marked, and a file whose changes cannot
// be read is not marked.
function markExpandedCapabilities<
  T extends {
    id?: string;
    file: string;
    ruleId?: string | null;
    obfuscated?: boolean;
  } & FindingDiffAnnotation,
>(
  findings: T[],
  ctx: {
    modified: (finding: T) => boolean;
    persisted: (finding: T) => boolean;
    changesFor: (path: string) => FileChanges | null;
    baselineFingerprints: () => Set<string> | null;
    baselineHosts: () => Set<string>;
    codePatternSet: CodePatternSet | undefined;
  },
): T[] {
  const deltasByFile = new Map<string, T[]>();
  for (const finding of findings) {
    if (!finding.releaseDelta || !ctx.modified(finding) || ctx.persisted(finding)) {
      continue;
    }
    const deltas = deltasByFile.get(finding.file) ?? [];
    deltas.push(finding);
    deltasByFile.set(finding.file, deltas);
  }
  const expanded = new Set<T>();
  for (const [file, deltas] of deltasByFile) {
    const newToFile = deltas.some(
      (finding) => finding.obfuscated || !baselineHasFinding(ctx.baselineFingerprints, finding),
    );
    if (newToFile || hasAssembledChange(ctx.changesFor(file), ctx.codePatternSet)) continue;
    if (introducesHost(ctx.changesFor(file), ctx.baselineHosts)) continue;
    for (const finding of deltas) {
      if (
        finding.ruleId &&
        CAPABILITY_RULE_IDS.has(finding.ruleId) &&
        !STANDING_DANGER_RULE_IDS.has(finding.ruleId) &&
        !NEVER_EXPANDED_RULE_IDS.has(finding.ruleId)
      ) {
        expanded.add(finding);
      }
    }
  }
  if (!expanded.size) return findings;
  return findings.map((finding) =>
    expanded.has(finding) ? { ...finding, releaseDeltaKind: "expanded" as const } : finding,
  );
}

// URL hosts, quoted bare hostnames (`hostname: 'api.example.com'`) and IPv4
// literals. A changed region that names one the baseline package never did is
// a new destination, whatever else the file already did. Quoted names ending
// in a file extension are paths, not hosts.
const HOST_LITERAL =
  /\b(?:https?|wss?|ftp):\/\/([^\s/'"`:?#\\)<>]+)|['"`]((?:[a-z0-9-]+\.)+[a-z][a-z0-9-]{1,23})['"`]|\b(\d{1,3}(?:\.\d{1,3}){3})\b/gi;
const FILE_EXTENSION_LABELS = new Set([
  "cjs",
  "css",
  "csv",
  "cts",
  "gif",
  "htm",
  "html",
  "jpeg",
  "jpg",
  "js",
  "json",
  "jsx",
  "less",
  "lock",
  "map",
  "md",
  "mjs",
  "mts",
  "node",
  "png",
  "py",
  "scss",
  "sh",
  "svg",
  "toml",
  "ts",
  "tsx",
  "txt",
  "wasm",
  "webp",
  "xml",
  "yaml",
  "yml",
]);

function hostsIn(text: string): string[] {
  const hosts: string[] = [];
  HOST_LITERAL.lastIndex = 0;
  for (const match of text.matchAll(HOST_LITERAL)) {
    const host = (match[1] ?? match[2] ?? match[3]).toLowerCase();
    if (match[2] && FILE_EXTENSION_LABELS.has(host.slice(host.lastIndexOf(".") + 1))) continue;
    hosts.push(host);
  }
  return hosts;
}

function introducesHost(changes: FileChanges | null, baselineHosts: () => Set<string>): boolean {
  // Unreadable changes cannot show that no new destination arrived.
  if (!changes) return true;
  const texts = changedRegionTexts(changes.stagedText, changes.raw);
  const folded = changes.folded();
  if (folded) {
    for (const text of changedRegionTexts(folded.text, folded.regions)) texts.push(text);
  }
  const known = baselineHosts();
  return texts.some((text) => hostsIn(text).some((host) => !known.has(host)));
}

function lazyBaselineHosts(
  previousFiles: Array<Pick<FileRecord, "path" | "textSample" | "flags">>,
): () => Set<string> {
  let computed: Set<string> | undefined;
  return () => {
    computed ??= new Set(previousFiles.flatMap((file) => hostsIn(file.textSample ?? "")));
    return computed;
  };
}

// Deterministic findings recomputed over the baseline files, keyed by
// ruleId + file. Computed lazily because most scans resolve every finding
// through line-level diff evidence and never need the baseline pass.
function isManifestPath(path: string): boolean {
  return path === "package.json" || path.endsWith("/package.json");
}

function lazyBaselineFingerprints(
  previousFiles: Array<Pick<FileRecord, "path" | "textSample" | "flags">>,
  codePatternSet: CodePatternSet | undefined,
): () => Set<string> | null {
  let computed: Set<string> | null | undefined;
  return () => {
    if (computed !== undefined) return computed;
    if (!previousFiles.length) {
      computed = null;
      return computed;
    }
    const baselineRecords: FileRecord[] = previousFiles.map((file) => ({
      path: file.path,
      size: 0,
      sha256: "",
      textSample: file.textSample,
      flags: file.flags,
    }));
    const findings = deterministicFindings(baselineRecords, [], null, { codePatternSet });
    computed = new Set(findings.map((finding) => findingFingerprint(finding)));
    return computed;
  };
}

function baselineHasFinding(
  baselineFingerprints: () => Set<string> | null,
  finding: { file: string; ruleId?: string | null },
): boolean {
  if (!finding.ruleId) return false;
  return Boolean(baselineFingerprints()?.has(findingFingerprint(finding)));
}

function findingFingerprint(finding: { file: string; ruleId?: string | null }): string {
  return `${finding.ruleId ?? ""}\u0000${finding.file}`;
}

export function normalizeFindingDiffStatus(value: unknown): FindingDiffStatus {
  switch (value) {
    case "added":
    case "removed":
    case "modified":
    case "unchanged":
      return value;
    default:
      return "unknown";
  }
}
