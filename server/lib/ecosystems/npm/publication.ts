import type { PublicationMonitorAdapter } from "../types";
import {
  enrollStagedReleases,
  reconcileDuePublicationEnrollments,
} from "./publication-auto-enrollment";
import { sweepNpmPublicationWatches } from "./publication-monitor";
import { resolvePostReleaseReview } from "./publication-review";

/** The npm publication monitor, as the ecosystem registry exposes it. */
export const npmPublicationMonitor: PublicationMonitorAdapter = {
  sweepWatches: (db, env) => sweepNpmPublicationWatches(db, env),
  reconcileEnrollment: (db, env) => reconcileDuePublicationEnrollments(db, env),
  registerStagedReleases: enrollStagedReleases,
  resolvePostReleaseReview,
};
