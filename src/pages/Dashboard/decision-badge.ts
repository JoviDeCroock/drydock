import type { BadgeTone } from "../../components";

export function decisionBadgePresentation({
  decision,
  releaseStatus,
}: {
  decision?: string | null;
  releaseStatus?: string | null;
}): { tone: BadgeTone; label: string } {
  if (releaseStatus === "released_mismatch") {
    return { tone: "critical", label: "release mismatch" };
  }
  if (decision === "publish") return { tone: "ok", label: "approved" };
  if (decision === "no_publish") return { tone: "critical", label: "blocked" };
  if (releaseStatus === "released") return { tone: "ok", label: "released" };
  if (releaseStatus === "withdrawn") return { tone: "neutral", label: "withdrawn" };
  return { tone: "neutral", label: "undecided" };
}
