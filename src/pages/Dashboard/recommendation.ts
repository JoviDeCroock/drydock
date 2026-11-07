type RecommendationTone = "critical" | "high" | "medium" | "ok" | "neutral";

export interface ReleaseRecommendationCopy {
  label: string;
  tone: RecommendationTone;
  copy: string;
  /**
   * One line that must stay beside the label because the label alone would
   * overstate the result, e.g. a low release-change grade on a package that
   * still carries high-risk findings from before this release.
   */
  caveat?: { text: string; tone: RecommendationTone };
}

/**
 * Where a workflow gate stands once someone decided. Each value maps to what
 * Drydock actually told GitHub Actions; the gate only ever controls the one
 * protected job the workflow configured, so the copy never claims more.
 */
export type GateOutcome =
  | "rejected"
  | "rejected-other"
  | "approved"
  | "package-approved"
  | "package-rejected";

export interface ReleaseRecommendationContext {
  /**
   * An npm scan ends in a maintainer approving the stage on npm; a workflow
   * gate ends in this decision releasing or blocking the held GitHub job, so
   * the gate speaks in job vocabulary rather than npm's "manual approval".
   */
  target?: "npm" | "gate";
  /** The published predecessor was too large to download, so nothing was compared. */
  baselineComparisonSkipped?: boolean;
  /** No earlier version exists: every file is new, so "nothing fired" is not an all-clear. */
  firstRelease?: boolean;
  /**
   * npm already published this version. A decision here no longer gates it,
   * so the copy must not tell the reader to hold an approval back.
   */
  published?: boolean;
  /** The version the release delta was graded against, named in a scoped verdict. */
  baselineVersion?: string | null;
  /** A decided workflow gate: the copy reports the result instead of asking for it. */
  gateOutcome?: GateOutcome | null;
}

const GATE_OUTCOME_SENTENCES: Record<GateOutcome, string> = {
  rejected:
    "This package was rejected, so Drydock told GitHub Actions not to run the configured protected publish job.",
  "rejected-other":
    "Another package in this release was rejected, so Drydock told GitHub Actions not to run the configured protected publish job.",
  approved:
    "Every release package was approved, so Drydock told GitHub Actions to continue the configured protected publish job.",
  "package-approved":
    "This package is approved; GitHub Actions holds the configured protected publish job until every release package is approved.",
  "package-rejected":
    "This package was rejected; a rejection blocks the configured protected publish job.",
};

export function getReleaseRecommendation(
  artifactRisk: string,
  releaseRisk: string,
  releaseFindingCount: number,
  {
    target = "npm",
    baselineComparisonSkipped = false,
    firstRelease = false,
    published = false,
    baselineVersion = null,
    gateOutcome = null,
  }: ReleaseRecommendationContext = {},
): ReleaseRecommendationCopy {
  const isGate = target === "gate";
  // Once a gate is decided, an instruction to approve or reject would contradict
  // the recorded result beside it, so the result replaces the instruction.
  const settled = isGate && gateOutcome ? GATE_OUTCOME_SENTENCES[gateOutcome] : null;
  const before = isGate
    ? "before approving the job"
    : published
      ? "before recording a decision"
      : "before approving";
  // The published release was never downloaded, so every file reads as added
  // and `releaseRisk` graded nothing. Neither a block nor an all-clear is
  // supported by the evidence — name the gap instead.
  if (baselineComparisonSkipped) {
    return {
      label: "no baseline to compare",
      tone: "medium",
      copy: `The published release is too large to download, so this report could not compare against it. Every signal below is package context, not a change this release introduced. ${settled ?? `Review the artifact contents ${before}.`}`,
    };
  }
  if (releaseRisk === "critical" || releaseRisk === "high") {
    const tone = releaseRisk === "critical" ? "critical" : "high";
    if (published) {
      return {
        label: "investigate published release",
        tone,
        copy: "This version is already published. Find out why the highlighted release evidence is there, then record whether this organization stands behind the release.",
      };
    }
    return isGate
      ? {
          // Once decided, the label reports the recorded outcome; "block this
          // release" beside a rejection that already blocked it reads as a
          // request still waiting on the reader.
          label: gateOutcome?.includes("rejected")
            ? "release blocked"
            : gateOutcome === "package-approved"
              ? "high-risk package approved"
              : gateOutcome === "approved"
                ? "high-risk release approved"
                : "block this release",
          tone,
          copy: settled
            ? `${settled} The highlighted release evidence stays below for the record.`
            : "Do not approve until the highlighted release evidence is explained. Rejecting blocks the configured protected publish job.",
        }
      : {
          label: "block manual approval",
          tone,
          copy: "Do not approve this staged publish on npm until the highlighted release evidence is explained.",
        };
  }
  if (releaseRisk === "medium") {
    return {
      label: "review carefully",
      tone: "medium",
      copy: settled
        ? `${settled} The findings, manifest changes, and changed files stay below for the record.`
        : `Inspect the most important findings, manifest changes, and changed files below ${before}.`,
    };
  }
  // With no earlier version every file is new, so a quiet rule set says less
  // than it does on an ordinary release: neutral, never the green all-clear.
  if (firstRelease) {
    return {
      label: "first release",
      tone: "neutral",
      copy: `There is no earlier version to compare against, so every file below is new. No blocking deterministic signals were found. ${settled ?? `Read the entrypoints and manifest ${before}.`}`,
    };
  }
  // The release delta graded low, but the grade is only about what changed:
  // findings the package already carried still rate it high. A green
  // all-clear here would read as a clean package, so the verdict names its
  // scope and the remaining findings stay beside it.
  if (artifactRisk === "critical" || artifactRisk === "high") {
    return {
      label: baselineVersion
        ? `low release-change risk against ${baselineVersion}`
        : "low release-change risk",
      tone: "neutral",
      caveat: {
        text: `Existing ${artifactRisk}-risk package findings remain`,
        tone: artifactRisk,
      },
      copy: `What this release changed raised no blocking deterministic signals, but findings the package already carried still grade it ${artifactRisk}. ${settled ?? `Read them below ${before}.`}`,
    };
  }
  if (releaseFindingCount === 0 && artifactRisk === "medium") {
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
      ? `No blocking deterministic signals were found. ${settled ?? "Your decision releases or blocks the held GitHub job."}`
      : published
        ? "No blocking deterministic signals were found in this release."
        : "No blocking deterministic signals were found. A maintainer still approves the publish in npm.",
  };
}
