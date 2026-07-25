type RecommendationTone = "critical" | "high" | "medium" | "ok" | "neutral";

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
  baselineComparisonSkipped = false,
): ReleaseRecommendationCopy {
  const isGate = target === "gate";
  // The published release was never downloaded, so every file reads as added
  // and `releaseRisk` graded nothing. Neither a block nor an all-clear is
  // supported by the evidence — name the gap instead.
  if (baselineComparisonSkipped) {
    return {
      label: "no baseline to compare",
      tone: "medium",
      copy: isGate
        ? "The published release is too large to download, so this report could not compare against it. Every signal below is package context, not a change this release introduced — review the artifact contents before releasing the job."
        : "The published release is too large to download, so this report could not compare against it. Every signal below is package context, not a change this release introduced — review the artifact contents before approving.",
    };
  }
  if (releaseRisk === "critical" || releaseRisk === "high") {
    return {
      label: "block manual approval",
      tone: releaseRisk === "critical" ? "critical" : "high",
      copy: isGate
        ? "Do not approve until you have reviewed and resolved the highlighted release evidence."
        : "Do not approve this staged publish until you have reviewed and resolved the highlighted release evidence outside Drydock.",
    };
  }
  if (releaseRisk === "medium") {
    return {
      label: "review carefully",
      tone: "medium",
      copy: isGate
        ? "Before releasing the job, inspect the most important findings, manifest changes, and changed files below."
        : "Before approving, inspect the most important findings, manifest changes, and changed files below.",
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
    label: "likely safe",
    tone: "ok",
    copy: isGate
      ? "No blocking deterministic signals were found. Your decision releases or blocks the held GitHub job."
      : "No blocking deterministic signals were found. A maintainer still approves the publish in npm.",
  };
}
