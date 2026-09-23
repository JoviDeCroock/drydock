import type { PublicationMonitorAdapter } from "../types";
import { enrollStagedReleases } from "./publication-auto-enrollment";
import { sweepNpmPublicationWatches } from "./publication-monitor";
import { resolvePostReleaseReview } from "./publication-review";

/** The npm publication monitor, as the ecosystem registry exposes it. */
export const npmPublicationMonitor: PublicationMonitorAdapter = {
  sweepWatches: (db, env) => sweepNpmPublicationWatches(db, env),
  registerStagedReleases: enrollStagedReleases,
  resolvePostReleaseReview,
};
