import { DEFAULT_BADGE_TAG, type PublicEcosystem } from "../../server/lib/public-feed";
import { packageOnlyDiffPath } from "./package-diff-path";

// README markdown for a package's shields.io status badge. Offered only for
// shared scans that are feed-listed with a resolvable ecosystem: the badge
// endpoint serves feed-listed scans exclusively, so handing out the snippet
// any earlier would mint a permanent "not reviewed" badge.
//
// The snippet is for the release line the copied scan was staged under, not for
// the package as a whole. The endpoint defaults to `latest`, so a maintainer
// who lists an `rc` review and pastes an untagged snippet would embed a badge
// that never shows it — the tag has to ride along or the two disagree silently.
//
// The click target differs by ecosystem. A README outlives any one release,
// while the badge always shows the *newest* listed review on its line — so the
// link must not pin what the badge does not. npm has an evergreen package-only
// diff form (`/diff/<name>` resolves the latest published pair on load), so the
// badge links there. PyPI and VS Code have no package-only diff form, so the
// badge links the share URL of the scan the maintainer copied it from — correct
// at copy time, and still a live report afterwards, but version-pinned.
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
  // The scan's dist-tag. Null (nothing was staged under one) and `latest` both
  // mean the default badge, which is left untagged so the common snippet stays
  // the short one.
  tag?: string | null;
}): string {
  // The name rides raw inside the endpoint URL (all three ecosystems' name
  // grammars are path-safe, and the badge route decodes the wildcard segment);
  // the endpoint is then encoded as a whole to nest inside shields' `url=`.
  const query = tag && tag !== DEFAULT_BADGE_TAG ? `?tag=${encodeURIComponent(tag)}` : "";
  const endpoint = `${origin}/public/badge/${ecosystem}/${packageName}${query}`;
  const image = `https://img.shields.io/endpoint?url=${encodeURIComponent(endpoint)}`;
  const target = ecosystem === "npm" ? `${origin}${packageOnlyDiffPath(packageName)}` : reportUrl;
  // The alt text names the line too: a README with a stable row and a
  // prerelease row otherwise has two images called the same thing.
  const alt = query ? `Drydock review (${tag})` : "Drydock review";
  return `[![${alt}](${image})](${target})`;
}
