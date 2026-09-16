// Leaf types shared by the review barrel, its rules, and the persistence
// layer. Nothing here imports from the barrel, so rule modules can depend on
// these without a cycle.

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface FileRecord {
  path: string;
  size: number;
  sha256: string;
  textSample?: string;
  flags: string[];
}

export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface Finding {
  severity: FindingSeverity;
  file: string;
  evidence: string;
  reason: string;
  line?: number;
  ruleId?: string;
  ruleVersion?: string;
  obfuscated?: boolean;
  testScoped?: boolean;
}

export type DiffStatus = "added" | "removed" | "modified" | "unchanged";

export type FindingDiffStatus = DiffStatus | "unknown";

export interface FindingDiffAnnotation {
  diffStatus: FindingDiffStatus;
  releaseDelta: boolean;
}

export type CodePatternSet = "javascript" | "python";

export interface FindingAnnotationOptions {
  previousFiles?: Array<Pick<FileRecord, "path" | "textSample" | "flags">>;
  stagedFiles?: Array<Pick<FileRecord, "path" | "textSample" | "flags">>;
  persistedAnnotations?: Map<string, FindingDiffAnnotation>;
  codePatternSet?: CodePatternSet;
  baselineComparisonSkipped?: boolean;
}
