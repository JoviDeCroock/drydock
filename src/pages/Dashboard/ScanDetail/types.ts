import type { SummaryDiffEntry } from "../../../../server/lib/review";
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
  // Digest-free by construction: `summaryDiffEntries` projects the digests out
  // before D1 persistence (they stay in the R2 artifacts). A file's own hash
  // comes off its `files[]` record, never off this array.
  diff?: SummaryDiffEntry[];
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
