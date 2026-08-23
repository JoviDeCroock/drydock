import { packageDiffCardPath, packageDiffPath, type DiffEcosystem } from "./package-diff-path";
import { diffRefLabel } from "./pkg-pr-new";

export const SITE_NAME = "Drydock";
export const PRODUCT_NAME = "Drydock Package Review";
export const SITE_URL = "https://drydock.org";
export const OG_IMAGE_URL = `${SITE_URL}/og-image.png`;
export const OG_IMAGE_ALT =
  "Drydock Package Review — pre-publish package security for npm, PyPI, and VS Code maintainers";

// Standard 1.91:1 share-card ratio, matching server/lib/og-card.ts. The static
// site-wide card is 1200x800; per-diff cards are generated at 1200x630.
export const OG_CARD_IMAGE_WIDTH = 1200;
export const OG_CARD_IMAGE_HEIGHT = 630;

export interface PageSeoMetadata {
  title: string;
  description: string;
  path: string;
}

export const discoveryGuideSeoByPath = {
  "/npm-staged-publishing": {
    title: "npm staged publishing security review | Drydock",
    description:
      "Review an npm staged package tarball against its published baseline before completing publication with npm 2FA.",
    path: "/npm-staged-publishing",
  },
  "/github-actions-package-gate": {
    title: "GitHub Actions package release gate | Drydock",
    description:
      "Hold npm, PyPI, or VS Code publication in a GitHub Environment until the exact built artifacts pass human review.",
    path: "/github-actions-package-gate",
  },
  "/pypi-release-security": {
    title: "PyPI release security for wheels and sdists | Drydock",
    description:
      "Review Python wheels and source distributions before a GitHub Actions trusted-publishing workflow uploads them to PyPI.",
    path: "/pypi-release-security",
  },
  "/vscode-extension-security": {
    title: "VS Code extension pre-publish security | Drydock",
    description:
      "Review the packaged VSIX, activation changes, entrypoints, and risky capabilities before marketplace publication.",
    path: "/vscode-extension-security",
  },
  "/package-tarball-diff": {
    title: "Package tarball diff for npm, PyPI, and atpm | Drydock",
    description:
      "Compare package artifacts file by file with deterministic supply-chain findings. No account or package installation required.",
    path: "/package-tarball-diff",
  },
  "/security": {
    title: "Drydock package-review security model",
    description:
      "How Drydock isolates hostile package artifacts, keeps publish credentials outside the sandbox, and preserves human release decisions.",
    path: "/security",
  },
  "/open-source": {
    title: "Open-source pre-publish package review | Drydock",
    description:
      "Audit Drydock's Apache-2.0 detection rules and security boundaries, or self-host package review in your own Cloudflare account.",
    path: "/open-source",
  },
} as const satisfies Record<string, PageSeoMetadata>;

export type DiscoveryGuidePath = keyof typeof discoveryGuideSeoByPath;
export const DISCOVERY_GUIDE_PATHS = Object.keys(discoveryGuideSeoByPath) as DiscoveryGuidePath[];
export const incidentCaseSeoByPath = {
  "/incidents/node-ipc-peacenotwar": {
    title: "node-ipc 11.0.0 package diff: peacenotwar added | Drydock",
    description:
      "Inspect the surviving node-ipc 9.2.1 to 11.0.0 artifact diff and the new peacenotwar runtime dependency without installing either release.",
    path: "/incidents/node-ipc-peacenotwar",
  },
  "/incidents/es5-ext-postinstall": {
    title: "es5-ext 0.10.54 package diff: postinstall added | Drydock",
    description:
      "Inspect the es5-ext 0.10.53 to 0.10.54 artifact diff that introduced a postinstall hook in a patch release.",
    path: "/incidents/es5-ext-postinstall",
  },
} as const satisfies Record<string, PageSeoMetadata>;

export type IncidentCasePath = keyof typeof incidentCaseSeoByPath;
export const INCIDENT_CASE_PATHS = Object.keys(incidentCaseSeoByPath) as IncidentCasePath[];

// Per-diff share card. Every shared diff otherwise unfurls with the same
// site-wide image, so a timeline reader cannot tell which package a link is
// about without clicking it.
export function packageDiffOgImageUrl(
  packageName: string,
  fromVersion: string,
  toVersion: string,
  ecosystem: DiffEcosystem = "npm",
): string {
  return `${SITE_URL}${packageDiffCardPath(ecosystem, packageName, fromVersion, toVersion)}`;
}

export function packageDiffOgImageAlt(
  packageName: string,
  fromVersion: string,
  toVersion: string,
): string {
  return `Drydock package diff card for ${packageName} ${diffRefLabel(fromVersion)} to ${diffRefLabel(toVersion)}`;
}

export const homePageSeo: PageSeoMetadata = {
  title: "Drydock Package Review: pre-publish package security",
  description:
    "Review the exact npm, PyPI, or VS Code artifact before publication. Drydock diffs built package bytes and pins supply-chain risks to changed lines.",
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
  // Readable spelling, when an atpm package's canonical DID form differs from
  // its recognizable verified handle. The canonical name still builds the path
  // — only the human-facing strings use this.
  displayName?: string,
): PageSeoMetadata {
  if (!packageName || !fromVersion || !toVersion) {
    return {
      title: "Diff any npm, PyPI, or atpm package | Drydock",
      description:
        "Compare two published versions of any npm package, PyPI project, or atpm package file by file, with deterministic supply-chain findings pinned to the diff. No account required.",
      path: "/diff",
    };
  }
  // Preview sides (pkg.pr.new URLs) render as short labels; the canonical path
  // keeps the raw spec values.
  const fromLabel = diffRefLabel(fromVersion);
  const toLabel = diffRefLabel(toVersion);
  const shownName = displayName || packageName;
  return {
    title: `${shownName} ${fromLabel} → ${toLabel} | Drydock package diff`,
    description: `File-by-file diff of ${shownName} between ${fromLabel} and ${toLabel}, with deterministic supply-chain findings pinned to changed lines.`,
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
  if (canonicalPathname in discoveryGuideSeoByPath) {
    return discoveryGuideSeoByPath[canonicalPathname as DiscoveryGuidePath];
  }
  if (canonicalPathname in incidentCaseSeoByPath) {
    return incidentCaseSeoByPath[canonicalPathname as IncidentCasePath];
  }
  return undefined;
}
