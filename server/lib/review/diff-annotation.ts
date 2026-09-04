import { diffLines } from "diff";
import { hasImplicitNodeGypInstall } from "../tar-parser.js";
import { hasMatchingCodeLine } from "../platform/text-utils";
import {
  codePatternsFor,
  DETERMINISTIC_RULE_IDS,
  deterministicFindings,
  FINDING_SECRET_PATTERNS,
  JS_PATTERN_SET,
  PYTHON_PATTERN_SET,
  safeJson,
  SHELL_DOWNLOAD_EXECUTE_PATTERN_SET,
} from "./rules";
import type {
  CodePatternSet,
  FileRecord,
  FindingAnnotationOptions,
  FindingDiffAnnotation,
  FindingDiffStatus,
  Finding,
  PackageJsonSummary,
} from "./";

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
  },
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
  if (isPropagationFinding(finding)) {
    return hasMatchingCodeLine(stagedText, patterns, changedLines);
  }
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

function isPropagationFinding(finding: { ruleId?: string | null }): boolean {
  return (
    finding.ruleId === DETERMINISTIC_RULE_IDS.propagationRegistryPublish ||
    finding.ruleId === DETERMINISTIC_RULE_IDS.propagationPackageMutation
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
      return [...patterns.installRootPath, ...patterns.installWrite];
    case DETERMINISTIC_RULE_IDS.fileSecretContent:
      // The finding-side set, so line matching agrees with what detection
      // actually flagged (placeholder URL credentials are not secrets).
      return FINDING_SECRET_PATTERNS.map(([pattern]) => pattern);
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
