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
  // reads the byte-continuity blocks; the rest stays opaque.
  stagedPublish?: {
    provenance?: ReleaseProvenance;
    artifactIntegrity?: unknown;
    // Ecosystem this staged review belongs to, when the adapter records one.
    // Gate scans carry it inside `provenance` instead; both are absent on
    // scans persisted before either existed.
    ecosystem?: unknown;
    // atpm staged reviews: the id `npm stage approve` takes for the exact
    // candidate this report describes, the record it addresses, and whether the
    // candidate's build attestation verified. All from
    // `atpmAdapter.summarizeDetails`, and re-validated before rendering.
    approveId?: unknown;
    uri?: unknown;
    buildProvenance?: unknown;
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
