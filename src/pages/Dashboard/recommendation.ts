export type RecommendationTone = "critical" | "high" | "medium" | "ok" | "neutral";

export interface ReleaseRecommendationCopy {
  label: string;
  tone: RecommendationTone;
  copy: string;
}

// `target` only shapes the trailing call-to-action copy: an npm scan ends in a
// maintainer publishing with 2FA, while a workflow gate ends in the maintainer
// releasing or blocking the held GitHub job (publishing then happens via PyPI
// Trusted Publishing). Labels and tones are identical either way.
export function getReleaseRecommendation(
  artifactRisk: string,
  releaseRisk: string,
  releaseFindingCount: number,
  target: "npm" | "gate" = "npm",
): ReleaseRecommendationCopy {
  const isGate = target === "gate";
  if (releaseRisk === "critical" || releaseRisk === "high") {
    return {
      label: "block manual approval",
      tone: releaseRisk === "critical" ? "critical" : "high",
      copy: isGate
        ? "Reject this gate until the highlighted release evidence has been reviewed and resolved."
        : "Do not approve this staged publish until the highlighted release evidence has been reviewed and resolved outside this tool.",
    };
  }
  if (releaseRisk === "medium") {
    return {
      label: "review carefully",
      tone: "medium",
      copy: isGate
        ? "Pause before releasing the job and inspect the highest-impact findings, manifest changes, and changed files below."
        : "Pause before approving and inspect the highest-impact findings, manifest changes, and changed files below.",
    };
  }
  if (
    releaseFindingCount === 0 &&
    (artifactRisk === "critical" || artifactRisk === "high" || artifactRisk === "medium")
  ) {
    return {
      label: "package context only",
      tone: "neutral",
      copy: "The release delta has no deterministic risk signals; existing package context remains visible below.",
    };
  }
  return {
    label: "likely safe",
    tone: "ok",
    copy: isGate
      ? "No blocking deterministic signals were found; your decision below releases or blocks the held GitHub job."
      : "No blocking deterministic signals were found; approval still remains a maintainer action in npm.",
  };
}
