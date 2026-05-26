export type RecommendationTone = "critical" | "high" | "medium" | "ok" | "neutral";

export interface ReleaseRecommendationCopy {
  label: string;
  tone: RecommendationTone;
  copy: string;
}

export function getReleaseRecommendation(
  artifactRisk: string,
  releaseRisk: string,
  releaseFindingCount: number,
): ReleaseRecommendationCopy {
  if (releaseRisk === "critical" || releaseRisk === "high") {
    return {
      label: "block manual approval",
      tone: releaseRisk === "critical" ? "critical" : "high",
      copy: "Do not approve this staged publish until the highlighted release evidence has been reviewed and resolved outside this tool.",
    };
  }
  if (releaseRisk === "medium") {
    return {
      label: "review carefully",
      tone: "medium",
      copy: "Pause before approving and inspect the highest-impact findings, manifest changes, and changed files below.",
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
    copy: "No blocking deterministic signals were found; approval still remains a maintainer action in npm.",
  };
}
