import { diffLines } from "diff";
import { hasImplicitNodeGypInstall } from "./tar-parser.js";
import {
  codePatternsFor,
  DETERMINISTIC_RULE_IDS,
  deterministicFindings,
  JS_PATTERN_SET,
  PYTHON_PATTERN_SET,
  safeJson,
  SECRET_PATTERNS,
} from "./review-rules";
import type {
  CodePatternSet,
  FileRecord,
  FindingAnnotationOptions,
  FindingDiffAnnotation,
  FindingDiffStatus,
  PackageJsonSummary,
} from "./review";

export function annotateFindingsWithDiffStatus<
  T extends { id?: string; file: string; line?: number | null; ruleId?: string | null },
>(
  findings: T[],
  diff: Array<{ path: string; status?: unknown }>,
  options: FindingAnnotationOptions = {},
): Array<T & FindingDiffAnnotation> {
  const diffByPath = new Map(
    diff.map((entry) => [entry.path, normalizeFindingDiffStatus(entry.status)]),
  );
  const previousByPath = new Map((options.previousFiles ?? []).map((file) => [file.path, file]));
  const stagedByPath = new Map((options.stagedFiles ?? []).map((file) => [file.path, file]));
  const changedLineCache = new Map<string, Set<number> | null>();
  const baselineFingerprints = lazyBaselineFingerprints(
    options.previousFiles ?? [],
    options.codePatternSet,
  );
  return findings.map((finding) => {
    const persisted = finding.id ? options.persistedAnnotations?.get(finding.id) : null;
    if (persisted) return { ...finding, ...persisted };

    const diffStatus = diffByPath.get(finding.file) ?? "unknown";
    return {
      ...finding,
      diffStatus,
      releaseDelta:
        isReleaseScopedFinding(finding) ||
        isNewlyEnabledImplicitNodeGypFinding(finding, previousByPath, stagedByPath) ||
        isFindingOnReleaseDelta(
          finding,
          diffStatus,
          previousByPath,
          stagedByPath,
          changedLineCache,
          options.codePatternSet,
          baselineFingerprints,
        ),
    };
  });
}

function isReleaseScopedFinding(finding: { ruleId?: string | null }): boolean {
  return Boolean(
    finding.ruleId?.startsWith("stage.") ||
    finding.ruleId?.startsWith("pypi.") ||
    finding.ruleId === DETERMINISTIC_RULE_IDS.dependencyUnusualSpec ||
    finding.ruleId === DETERMINISTIC_RULE_IDS.dependencyOptionalAdded ||
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
  previousByPath: Map<string, Pick<FileRecord, "path" | "textSample" | "flags">>,
  stagedByPath: Map<string, Pick<FileRecord, "path" | "textSample" | "flags">>,
  changedLineCache: Map<string, Set<number> | null>,
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

  const changedLines = changedStagedLinesForPath(
    finding.file,
    previousByPath,
    stagedByPath,
    changedLineCache,
  );
  if (!changedLines) return !baselineHasFinding(baselineFingerprints, finding);
  if (changedLines.has(finding.line)) return true;
  return findingPatternMatchesChangedLine(
    finding,
    stagedByPath.get(finding.file)?.textSample,
    changedLines,
    codePatternSet,
  );
}

function changedStagedLinesForPath(
  path: string,
  previousByPath: Map<string, Pick<FileRecord, "path" | "textSample" | "flags">>,
  stagedByPath: Map<string, Pick<FileRecord, "path" | "textSample" | "flags">>,
  cache: Map<string, Set<number> | null>,
): Set<number> | null {
  if (cache.has(path)) return cache.get(path) ?? null;
  const previous = previousByPath.get(path);
  const staged = stagedByPath.get(path);
  if (!previous?.textSample || !staged?.textSample) {
    cache.set(path, null);
    return null;
  }
  if (previous.flags.includes("binary") || staged.flags.includes("binary")) {
    cache.set(path, null);
    return null;
  }
  const lines = changedStagedLines(previous.textSample, staged.textSample);
  cache.set(path, lines);
  return lines;
}

function changedStagedLines(previous: string, staged: string): Set<number> {
  const changed = new Set<number>();
  let stagedLine = 0;
  for (const part of diffLines(previous, staged)) {
    const lines = splitComparableLines(part.value);
    if (part.added) {
      for (const _line of lines) {
        stagedLine += 1;
        changed.add(stagedLine);
      }
    } else if (!part.removed) {
      stagedLine += lines.length;
    }
  }
  return changed;
}

function splitComparableLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function findingPatternMatchesChangedLine(
  finding: { file: string; ruleId?: string | null },
  stagedText: string | undefined,
  changedLines: Set<number>,
  codePatternSet: CodePatternSet | undefined,
): boolean {
  if (!stagedText) return false;
  const patterns = patternsForFinding(finding, codePatternSet);
  if (!patterns.length) return false;
  const lines = splitComparableLines(stagedText);
  for (const lineNumber of changedLines) {
    const line = lines[lineNumber - 1];
    if (line === undefined) continue;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) return true;
    }
  }
  return false;
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
    case DETERMINISTIC_RULE_IDS.codeNetworkAccess:
      return patterns.networkAccess;
    case DETERMINISTIC_RULE_IDS.codeDynamicEvaluation:
      return patterns.dynamicEvaluation;
    case DETERMINISTIC_RULE_IDS.codeCredentialAccess:
      return patterns.credentialAccess;
    case DETERMINISTIC_RULE_IDS.fileSecretContent:
      return SECRET_PATTERNS.map(([pattern]) => pattern);
    default:
      return [];
  }
}

// Deterministic findings recomputed over the baseline files, keyed by
// ruleId + file. Computed lazily because most scans resolve every finding
// through line-level diff evidence and never need the baseline pass.
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

export function isReleaseDeltaStatus(status: FindingDiffStatus): boolean {
  return status === "added" || status === "modified";
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
