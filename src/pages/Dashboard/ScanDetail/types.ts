import type { DiffEntry, FindingDiffStatus } from "../../../../server/lib/review";
import type { PackageJsonDiff, ReleaseProvenance } from "../../../../server/types";
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
  // Adapter-shaped staged details persisted by summarizeDetails. The UI only
  // reads the byte-continuity provenance block; the rest stays opaque.
  stagedPublish?: {
    provenance?: ReleaseProvenance;
  };
  // Advisory release-memory blob. Old scans lack it and its shape is only
  // trusted after normalizeReleaseConsistency, so it stays unknown here.
  releaseConsistency?: unknown;
}

export type PersistedFinding = PersistedScanDetail["findings"][number];

export interface FindingWithDiffStatus {
  finding: PersistedFinding;
  diffStatus: FindingDiffStatus;
  releaseDelta: boolean;
}
