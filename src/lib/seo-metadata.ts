import { packageDiffPath, type DiffEcosystem } from "./package-diff-path";
import { diffRefLabel } from "./pkg-pr-new";

export const SITE_NAME = "Drydock";
export const SITE_URL = "https://drydock.org";
export const OG_IMAGE_URL = `${SITE_URL}/og-image.png`;
export const OG_IMAGE_ALT =
  "Drydock — pre-publish package review for npm, PyPI, and VS Code maintainers";

export interface PageSeoMetadata {
  title: string;
  description: string;
  path: string;
}

export const homePageSeo: PageSeoMetadata = {
  title: "Drydock: pre-publish package review",
  description:
    "Drydock lets npm, PyPI, and VS Code maintainers review the exact package artifact before an npm stage publish or gated release goes live.",
  path: "/",
};

export const docsPageSeo: PageSeoMetadata = {
  title: "Learn Drydock: artifact review before you publish",
  description:
    "Learn how Drydock reviews npm, PyPI, and VS Code release artifacts, then set up npm stage publish or a GitHub workflow gate.",
  path: "/docs",
};

export const privacyPageSeo: PageSeoMetadata = {
  title: "Drydock privacy policy",
  description:
    "How Drydock collects, uses, retains, and protects your account, organization, and release data.",
  path: "/privacy",
};

export function packageDiffSeo(
  packageName?: string,
  fromVersion?: string,
  toVersion?: string,
  ecosystem: DiffEcosystem = "npm",
): PageSeoMetadata {
  if (!packageName || !fromVersion || !toVersion) {
    return {
      title: "Diff any npm or PyPI package | Drydock",
      description:
        "Compare two published versions of any npm package or PyPI project file by file, with deterministic supply-chain findings pinned to the diff. Free, no account needed.",
      path: "/diff",
    };
  }
  // Preview sides (pkg.pr.new URLs) render as short labels; the canonical path
  // keeps the raw spec values.
  const fromLabel = diffRefLabel(fromVersion);
  const toLabel = diffRefLabel(toVersion);
  return {
    title: `${packageName} ${fromLabel} → ${toLabel} | Drydock package diff`,
    description: `File-by-file diff of ${packageName} between ${fromLabel} and ${toLabel}, with deterministic supply-chain findings pinned to changed lines.`,
    path: packageDiffPath(ecosystem, packageName, fromVersion, toVersion),
  };
}

export function getPageSeoMetadata(pathname: string): PageSeoMetadata | undefined {
  const canonicalPathname =
    pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

  if (canonicalPathname === "/") return homePageSeo;
  if (canonicalPathname === "/docs") return docsPageSeo;
  if (canonicalPathname === "/privacy") return privacyPageSeo;
  if (canonicalPathname === "/diff") return packageDiffSeo();
  return undefined;
}
