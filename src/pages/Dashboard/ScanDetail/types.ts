import type { DiffEntry } from "../../../../server/lib/review";
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
  // Baseline selection recorded by the pipeline. The UI only reads
  // `comparisonSkipped`, which says a published predecessor existed but was
  // never downloaded, so the diff is not a release delta.
  baseline?: { version?: string | null; comparisonSkipped?: string };
  // Adapter-shaped staged details persisted by summarizeDetails. The UI only
  // reads the byte-continuity blocks and the stage timestamp; the rest stays
  // opaque.
  stagedPublish?: {
    provenance?: ReleaseProvenance;
    artifactIntegrity?: unknown;
    /** npm's own creation time for the stage, as the registry reported it. */
    createdAt?: string | null;
    /** Named directly by a published-pair review, which has no gate provenance. */
    ecosystem?: string;
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
