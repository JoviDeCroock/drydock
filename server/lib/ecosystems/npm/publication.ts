import type { PublicationMonitorAdapter } from "../types";
import { backfillNpmPublicationWatches, enrollStagedReleases } from "./publication-auto-enrollment";
import { sweepNpmPublicationWatches } from "./publication-monitor";
import { npmPublicationRegistry } from "./publication-registry";
import { resolvePostReleaseReview } from "./publication-review";

/** The npm publication monitor, as the ecosystem registry exposes it. */
export const npmPublicationMonitor: PublicationMonitorAdapter = {
  backfillWatches: (db, env) => backfillNpmPublicationWatches(db, npmPublicationRegistry(env)),
  sweepWatches: (db, env) => sweepNpmPublicationWatches(db, env),
  registerStagedReleases: enrollStagedReleases,
  resolvePostReleaseReview,
};
