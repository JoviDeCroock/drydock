import {
  DEFAULT_BADGE_TAG,
  REGISTRY_VERIFIED_SCAN_SOURCES,
  type PublicEcosystem,
} from "../../server/lib/public-feed";
import { packageOnlyDiffPath } from "./package-diff-path";

export function badgeMarkdown({
  origin,
  ecosystem,
  packageName,
  reportUrl,
  tag,
}: {
  origin: string;
  ecosystem: PublicEcosystem;
  packageName: string;
  reportUrl: string;
  tag?: string | null;
}): string {
  const query = tag && tag !== DEFAULT_BADGE_TAG ? `?tag=${encodeURIComponent(tag)}` : "";
  const endpoint = `${origin}/public/badge/${ecosystem}/${packageName}${query}`;
  const image = `https://img.shields.io/endpoint?url=${encodeURIComponent(endpoint)}`;
  const target = ecosystem === "npm" ? `${origin}${packageOnlyDiffPath(packageName)}` : reportUrl;
  const alt = query ? `Drydock review (${tag})` : "Drydock review";
  return `[![${alt}](${image})](${target})`;
}

/** Sharing a report cannot grant authority over a public npm badge. */
export function shareBadgeMarkdown(input: {
  origin: string;
  ecosystem: PublicEcosystem | null;
  packageName: string | null;
  reportUrl: string;
  tag?: string | null;
  badgePublic: boolean;
  feedListed: boolean;
  npmPackageClaimOwned?: boolean;
  npmPackageManagementAllowed?: boolean;
}): string | null {
  if (!input.ecosystem || !input.packageName || (!input.badgePublic && !input.feedListed))
    return null;
  if (
    input.ecosystem === "npm" &&
    (input.npmPackageClaimOwned !== true || input.npmPackageManagementAllowed !== true)
  )
    return null;
  return badgeMarkdown({ ...input, ecosystem: input.ecosystem, packageName: input.packageName });
}

/**
 * Why a review cannot answer the npm badge, when its package claim is the
 * reason. Only staged reviews carry a claim; an npm workflow-gate review never
 * answers the badge at all. Another organization is never named.
 */
export function npmBadgeAuthorityNote(input: {
  ecosystem: PublicEcosystem | null;
  source: string;
  /** The review's public identity (`scanPublicPackageName`). */
  packageName: string | null;
  npmPackageClaimOwned?: boolean;
  npmPackageManagementAllowed?: boolean;
  npmPackageManagedElsewhere?: boolean;
}): string | null {
  if (input.ecosystem !== "npm" || !input.packageName) return null;
  if (input.source === "workflow_gate")
    return "Workflow-gate reviews do not answer the npm badge; only staged reviews on public npm do.";
  if (!(REGISTRY_VERIFIED_SCAN_SOURCES as readonly string[]).includes(input.source)) return null;
  if (input.npmPackageClaimOwned === true)
    return input.npmPackageManagementAllowed === true
      ? null
      : "This review cannot answer the npm badge until you choose where this package is managed.";
  return input.npmPackageManagedElsewhere === true
    ? "This review cannot answer the npm badge because another organization manages this package."
    : "This review cannot answer the npm badge because this organization does not manage this package.";
}
