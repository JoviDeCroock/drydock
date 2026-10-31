/**
 * Dependency readiness for a scan's decision view: whether the reviewed npm
 * release's runtime dependencies are installable yet, or are waiting on a
 * stage this organization still holds.
 *
 * Computed on request, not at scan time: the answer depends on what npm and
 * this organization's other stages look like when the maintainer is about to
 * approve. Advisory and fail-open — every registry or storage problem degrades
 * to "could not check", and nothing here moves risk, findings, or a decision.
 */
import { Hono } from "hono";
import { getNpmConnection } from "../../db/npm-connections";
import {
  getScanForDependencyReadiness,
  listStagedDependencyCandidates,
} from "../../db/scan-dependency-candidates";
import { requireActiveOrganization } from "../../lib/auth/active-organization";
import { decryptNpmToken } from "../../lib/ecosystems/npm/connection";
import {
  bundledDependencyNames,
  dependencyLookupQueue,
  dependencyReadinessAppliesToScan,
  dependencyReadinessTargets,
  evaluateDependencyReadiness,
  planDependencyReadiness,
  runDependencyLookups,
  type DependencyReadinessResponse,
  type PackageVersionsLookup,
  type ReleaseSibling,
  type StagedDependencyCandidate,
} from "../../lib/ecosystems/npm/dependency-readiness";
import { fetchPackageMetadataCachedWithSource } from "../../lib/ecosystems/npm/registry-cache";
import { listGatePackageScans } from "../../lib/github-app/webhook-gates";
import { workerExecutionContext } from "../../lib/platform/execution-context";
import { describeOperationalError, emitOperationalEvent } from "../../lib/platform/observability";
import { guardRateLimit } from "../../lib/rate-limit";
import { loadScanReportManifest, scanArtifactReadBucket } from "../../lib/scan/artifacts";
import type { Bindings, Variables } from "../../types";

export const scanDependencyReadinessRoutes = new Hono<{
  Bindings: Bindings;
  Variables: Variables;
}>();

scanDependencyReadinessRoutes.get("/:id/dependency-readiness", async (c) => {
  const db = c.var.db;
  const session = c.get("authSession");
  const organizationId = await requireActiveOrganization(c, db);
  const scan = await getScanForDependencyReadiness(db, c.req.param("id"), organizationId);
  if (!scan) return c.json({ error: "not found" }, 404);

  const respond = (body: DependencyReadinessResponse) =>
    c.json(body, 200, { "cache-control": "no-store" });
  if (!dependencyReadinessAppliesToScan(scan)) return respond({ status: "not-applicable" });

  const limited = await guardRateLimit(
    c,
    { key: `dependency-readiness:${session.userId}`, limit: 30, windowMs: 60 * 1000 },
    "rate limit exceeded",
  );
  if (limited) return limited;

  const report = await loadScanReportManifest(scanArtifactReadBucket(c.env), scan);
  if (!report) return respond({ status: "unavailable", reason: "report-unavailable" });

  const plan = planDependencyReadiness(report.packageJson, {
    changed: report.dependencyChanges,
    bundled: bundledDependencyNames(report.stagedPaths),
  });

  // A staged review must ask the registry it was captured from with the
  // organization's own credential, exactly as its scan did; a connection
  // edited since then fails closed rather than answering about another
  // registry. (A legacy row that never captured its registry is asked of the
  // current connection's, which is what its scan used.) A gate review needs no
  // npm connection, so without a usable one it reads the public registry
  // anonymously.
  const isGate = scan.source === "workflow_gate";
  const connection = await getNpmConnection(db, organizationId).catch(() => null);
  const usable = connection?.validationStatus === "valid" ? connection : null;
  if (!isGate && !usable) {
    return respond({ status: "unavailable", reason: "npm-connection-unavailable" });
  }
  if (!isGate && usable && scan.registryUrl && usable.registryUrl !== scan.registryUrl) {
    return respond({ status: "unavailable", reason: "npm-connection-changed" });
  }
  let token: string | undefined;
  let registryUrl = c.env.NPM_REGISTRY || "https://registry.npmjs.org";
  if (usable) {
    try {
      token = await decryptNpmToken(c.env, usable);
      registryUrl = usable.registryUrl;
    } catch (err) {
      emitOperationalEvent("warn", "scan.dependency_readiness.credential_unavailable", {
        organizationId,
        scanId: scan.id,
        error: describeOperationalError(err),
      });
      if (!isGate) return respond({ status: "unavailable", reason: "npm-connection-unavailable" });
    }
  }
  const credentialed = token !== undefined;
  if (!plan.requirements.length) {
    return respond(
      evaluateDependencyReadiness({
        plan,
        siblings: [],
        candidates: [],
        lookups: new Map(),
        credentialed,
      }),
    );
  }
  const targets = dependencyReadinessTargets(plan);
  const [siblings, candidates] = await Promise.all([
    isGate && scan.gateId ? loadReleaseSiblings(db, organizationId, scan.gateId, scan.id) : [],
    token
      ? listStagedDependencyCandidates(db, {
          organizationId,
          registryUrl,
          packageNames: targets,
        }).catch((err): StagedDependencyCandidate[] => {
          emitOperationalEvent("warn", "scan.dependency_readiness.candidates_failed", {
            organizationId,
            scanId: scan.id,
            error: describeOperationalError(err),
          });
          return [];
        })
      : [],
  ]);

  const ctx = workerExecutionContext(c.executionCtx);
  const lookup = async (
    packageName: string,
    options: { fresh: boolean },
  ): Promise<PackageVersionsLookup> => {
    try {
      const { metadata, fromCache } = await fetchPackageMetadataCachedWithSource(c.env, ctx, {
        packageName,
        registryUrl,
        cacheScope: token ? `org:${organizationId}` : "public",
        npmToken: token,
        // Version keys and dist-tags are all this reads.
        abbreviated: true,
        revalidate: options.fresh,
      });
      return {
        status: "found",
        versions: Object.keys(metadata.versions ?? {}),
        distTags: metadata["dist-tags"] ?? {},
        fromCache,
      };
    } catch (err) {
      // npm answers 404 for a package that does not exist and for one this
      // token may not read; both mean "nothing installable is visible".
      if (err instanceof Error && /\b404$/.test(err.message)) return { status: "not-found" };
      return { status: "error" };
    }
  };

  const queue = dependencyLookupQueue(plan, siblings, candidates);
  const lookups = await runDependencyLookups(plan, queue, lookup);
  const result = evaluateDependencyReadiness({
    plan,
    siblings,
    candidates,
    lookups,
    credentialed,
  });
  const failed = result.issues.filter((issue) => issue.reason === "lookup-failed").length;
  if (failed) {
    emitOperationalEvent("warn", "scan.dependency_readiness.lookup_failed", {
      organizationId,
      scanId: scan.id,
      failedLookups: failed,
    });
  }
  return respond(result);
});

// The other packages of the same gated release publish together with this
// one (the gate releases only once every package is approved), so they satisfy
// each other's dependencies. Names come from each tarball's manifest, which is
// what `npm publish` publishes under.
async function loadReleaseSiblings(
  db: Parameters<typeof listGatePackageScans>[0],
  organizationId: string,
  gateId: string,
  scanId: string,
): Promise<ReleaseSibling[]> {
  const packages = await listGatePackageScans(db, organizationId, gateId).catch(() => []);
  return packages.flatMap((pkg) =>
    pkg.scanId !== scanId && pkg.packageName && pkg.stagedVersion
      ? [{ name: pkg.packageName, version: pkg.stagedVersion }]
      : [],
  );
}
