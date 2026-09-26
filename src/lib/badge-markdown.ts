import { DEFAULT_BADGE_TAG, type PublicEcosystem } from "../../server/lib/public-feed";
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
