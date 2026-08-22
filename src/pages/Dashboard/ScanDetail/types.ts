import type { DiffEntry } from "../../../../server/lib/review";
import type { SummaryDiffStats } from "../../../../server/lib/scan/summary-diff";
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
  /**
   * The summary-embedded diff. For artifact-backed scans this is the compacted
   * release delta (see server/lib/scan/summary-diff.ts) and `PersistedScanDetail.diff`
   * carries the complete one; on legacy/degraded rows it is the full diff.
   */
  diff?: DiffEntry[];
  /** Aggregate shape of the real diff, when the scan recorded it. */
  diffStats?: SummaryDiffStats;
  // Baseline selection recorded by the pipeline. The UI only reads
  // `comparisonSkipped`, which says a published predecessor existed but was
  // never downloaded, so the diff is not a release delta.
  baseline?: { version?: string | null; comparisonSkipped?: string };
  // Adapter-shaped staged details persisted by summarizeDetails. The UI only
  // reads the byte-continuity blocks; the rest stays opaque.
  stagedPublish?: {
    provenance?: ReleaseProvenance;
    artifactIntegrity?: unknown;
  };
  // Advisory release-memory blob. Old scans lack it and its shape is only
  // trusted after normalizeReleaseConsistency, so it stays unknown here.
  releaseConsistency?: unknown;
  // Advisory source-binding envelope. Untyped here because persisted blobs
  // predate the feature or may be malformed; readers re-validate through
  // `normalizeIntentEnvelope`.
  intentEnvelope?: unknown;
}

export type PersistedFinding = PersistedScanDetail["findings"][number];
