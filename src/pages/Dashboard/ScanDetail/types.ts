import type { DiffEntry, FindingDiffStatus } from "../../../../server/lib/review";
import type { PackageJsonDiff } from "../../../../server/types";
import type { PersistedScanDetail } from "../../../models/scan";

export interface PersistedSummary {
  report?: {
    version?: number;
    digest?: string;
    digestAlgorithm?: string;
    generatedAt?: string;
    rulesVersion?: string;
  };
  packageJsonDiff?: PackageJsonDiff;
  diff?: DiffEntry[];
}

export type PersistedFinding = PersistedScanDetail["findings"][number];

export interface FindingWithDiffStatus {
  finding: PersistedFinding;
  diffStatus: FindingDiffStatus;
  releaseDelta: boolean;
}
