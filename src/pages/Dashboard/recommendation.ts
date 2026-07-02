export type RecommendationTone = "critical" | "high" | "medium" | "ok" | "neutral";

export interface ReleaseRecommendationCopy {
  label: string;
  tone: RecommendationTone;
  copy: string;
}

// `target` only shapes the trailing call-to-action copy: an npm scan ends in a
// maintainer publishing with 2FA, while a workflow gate ends in the maintainer
// clearing or blocking the held GitHub job (publishing then happens via PyPI
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
      label: "keep in drydock",
      tone: releaseRisk === "critical" ? "critical" : "high",
      copy: isGate
        ? "Do not clear until you have inspected and resolved the highlighted release evidence."
        : "Do not clear this staged publish until you have inspected and resolved the highlighted release evidence outside Drydock.",
    };
  }
  if (releaseRisk === "medium") {
    return {
      label: "inspect carefully",
      tone: "medium",
      copy: isGate
        ? "Before releasing the job, inspect the most important findings, manifest changes, and changed files below."
        : "Before clearing, inspect the most important findings, manifest changes, and changed files below.",
    };
  }
  if (
    releaseFindingCount === 0 &&
    (artifactRisk === "critical" || artifactRisk === "high" || artifactRisk === "medium")
  ) {
    return {
      label: "package context only",
      tone: "neutral",
      copy: "The changed files have no deterministic risk signals. Package context is summarized below.",
    };
  }
  return {
    label: "cleared for release",
    tone: "ok",
    copy: isGate
      ? "No blocking deterministic signals were found. The held GitHub job is ready for clearance."
      : "No blocking deterministic signals were found. A maintainer still clears the publish in npm.",
  };
}
