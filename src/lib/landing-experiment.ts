export const LANDING_EXPERIMENT = "landing-package-diff-v1";

export type LandingVariant = "control" | "challenger";
export type AcquisitionChannel = "direct" | "search" | "github" | "other";

export function classifyAcquisitionChannel(
  referrer: string | undefined,
  ownHost: string,
): AcquisitionChannel {
  if (!referrer) return "direct";
  try {
    const host = new URL(referrer).hostname.toLowerCase();
    if (host === ownHost) return "direct";
    if (host === "github.com" || host.endsWith(".github.com")) return "github";
    if (
      ["google.com", "bing.com", "duckduckgo.com", "search.brave.com"].some(
        (search) => host === search || host === `www.${search}`,
      )
    )
      return "search";
    return "other";
  } catch {
    return "direct";
  }
}

export const landingHeroCopy = {
  control: {
    title: "Review your package before you publish.",
    description:
      "Compare your built npm, PyPI, or VS Code release with the previous version. Drydock shows changed files and supply-chain findings so you can inspect unexpected behavior before publication.",
    action: "Read a diff",
  },
  challenger: {
    title: "See what changed in the package your users will install.",
    description:
      "Inspect changed files and supply-chain findings. Try a public package diff without an account or installation. Add a review to your built release when you’re ready to publish.",
    action: "Diff a package",
  },
} as const;
