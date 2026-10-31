import { and, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import type { StagedDependencyCandidate } from "../lib/ecosystems/npm/dependency-readiness";
import type { AppDb } from "./client";
import { chunkForD1 } from "./d1-chunk";
import { scans } from "./schema";

const MAX_CANDIDATE_ROWS = 500;

/** The scan row the readiness check starts from, scoped to its organization. */
export async function getScanForDependencyReadiness(db: AppDb, id: string, organizationId: string) {
  const [scan] = await db
    .select()
    .from(scans)
    .where(and(eq(scans.id, id), eq(scans.organizationId, organizationId)))
    .limit(1);
  return scan ?? null;
}

/**
 * Stages this organization currently holds for the given packages on one
 * registry, read from its own staged reviews. Keyed on npm's stage record
 * (`registry_package_name` / `registry_version`), never on a tarball's
 * manifest, so a stage cannot claim to be another package's version.
 * Superseded incarnations and failed reviews are history, not a stage.
 */
export async function listStagedDependencyCandidates(
  db: AppDb,
  input: { organizationId: string; registryUrl: string; packageNames: readonly string[] },
): Promise<StagedDependencyCandidate[]> {
  const names = [...new Set(input.packageNames)];
  const out: StagedDependencyCandidate[] = [];
  // The other predicates bind a handful of parameters; leave room for them.
  for (const chunk of chunkForD1(names, 1, 8)) {
    const rows = await db
      .select({
        scanId: scans.id,
        packageName: scans.registryPackageName,
        version: scans.registryVersion,
        decision: scans.decision,
        registryVersionStatus: scans.registryVersionStatus,
      })
      .from(scans)
      .where(
        and(
          eq(scans.organizationId, input.organizationId),
          eq(scans.registryUrl, input.registryUrl),
          inArray(scans.source, ["manual", "auto_discovery"]),
          inArray(scans.registryPackageName, chunk),
          isNotNull(scans.registryVersion),
          isNull(scans.registryStatusSupersededAt),
          ne(scans.status, "failed"),
        ),
      )
      .limit(MAX_CANDIDATE_ROWS);
    for (const row of rows) {
      if (!row.packageName || !row.version) continue;
      out.push({
        scanId: row.scanId,
        packageName: row.packageName,
        version: row.version,
        decision: row.decision ?? null,
        registryVersionStatus: row.registryVersionStatus ?? null,
      });
    }
  }
  return out;
}
