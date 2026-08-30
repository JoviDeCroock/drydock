import type { FindingDiffStatus } from "../../../server/lib/review";

// The finding fields the shared review surface actually renders. Deliberately
// narrower than a persisted scan finding: the authenticated workbench reads
// rows out of D1 while the anonymous /diff surface computes them on the fly and
// never persists anything, so the shared components must not demand
// persistence-only columns (`scanId`, `ruleVersion`). Both surfaces project
// into this shape.
export interface ReviewFinding {
  id: string;
  severity: string;
  file: string;
  evidence: string;
  reason: string;
  line?: number | null;
  source: string;
  ruleId?: string | null;
  dependency?: {
    name: string;
    version: string | null;
    path: string;
    section?: import("../../../server/lib/review/serialize").DependencySection;
    declaredSpec?: string;
  };
}

// A review finding paired with its status against the active comparison.
// `releaseDelta` is the split the UI cares about most: findings the release
// actually introduces versus findings that are pre-existing package context.
export interface FindingWithDiffStatus {
  finding: ReviewFinding;
  diffStatus: FindingDiffStatus;
  releaseDelta: boolean;
}
