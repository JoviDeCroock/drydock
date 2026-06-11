import type { DiffEntry, FindingDiffStatus } from "../../../../server/lib/review";
import type { ReportArtifactDigest } from "../../../../server/lib/report-provenance";
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
  provenance?: {
    artifactDigests?: ReportArtifactDigest[];
    reviewLimitations?: readonly string[];
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
