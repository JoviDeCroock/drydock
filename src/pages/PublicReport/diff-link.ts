import { packageDiffIndexPath, packageDiffPath } from "../../lib/package-diff-path";
import type { PublicReport } from "../../models/public-report";

// Sources that fetched an npm stage with the organization's own token — the
// only ones whose ecosystem is npm without a provenance block saying so
// (mirrors `REGISTRY_VERIFIED_SCAN_SOURCES` on the server).
const NPM_STAGE_SOURCES = new Set(["manual", "auto_discovery"]);

function publicDiffEcosystem(report: PublicReport): "npm" | "pypi" | null {
  const declared = report.provenance?.ecosystem;
  if (declared === "npm" || declared === "pypi") return declared;
  // A gate scan without provenance, a published-pair review (the export does
  // not name its registry), or a VS Code release has no public diff to name.
  if (declared) return null;
  return NPM_STAGE_SOURCES.has(report.scan.source) ? "npm" : null;
}

/**
 * Where "diff this package" goes from a shared report.
 *
 * The exact pair only once the registry is known to serve the reviewed
 * version: a staged or gated candidate that was rejected, or is still waiting,
 * is not on the registry, and its pair page would only fail to resolve. Until
 * then the package's version-less page, which resolves to its latest published
 * pair. The share token never appears in the link.
 */
export function reportDiffHref(report: PublicReport): { href: string; specific: boolean } {
  const { name, previousVersion, stagedVersion } = report.package;
  const ecosystem = publicDiffEcosystem(report);
  if (!name || !ecosystem) return { href: "/diff", specific: false };
  if (previousVersion && stagedVersion && report.registryStatus?.status === "published") {
    return {
      href: packageDiffPath(ecosystem, name, previousVersion, stagedVersion),
      specific: true,
    };
  }
  return { href: packageDiffIndexPath(ecosystem, name), specific: true };
}
