import type { BadgeVerdict } from "../../../server/lib/public-feed";
import { Alert, type AlertTone } from "../../components/Alert";

// Each line restates the badge's own claim and nothing more. In particular no
// timing beyond what the evidence carries: a staged review ran before release,
// but the decision on it may have come after npm published, so "approved"
// never says "before publication".
const COPY: Record<
  BadgeVerdict["outcome"],
  { tone: AlertTone; title: string; body: (verdict: BadgeVerdict) => string }
> = {
  approved: {
    tone: "ok",
    title: "Approved by its publisher.",
    body: (verdict) =>
      verdict.decidedAfterPublish
        ? `${verdict.version} was reviewed in Drydock and approved by its publisher after npm published it, against the bytes npm serves.`
        : `${verdict.version} was reviewed in Drydock and approved by its publisher.`,
  },
  rejected: {
    tone: "critical",
    title: "Rejected by its publisher.",
    // A record of the review decision, not a claim about what npm did with it.
    body: (verdict) =>
      verdict.decidedAfterPublish
        ? `${verdict.version} was reviewed in Drydock and rejected by its publisher after npm published it.`
        : `${verdict.version} was reviewed in Drydock and rejected by its publisher.`,
  },
  published_without_approval: {
    tone: "warn",
    title: "Published without its publisher's approval.",
    body: (verdict) =>
      `npm published ${verdict.version} without its publisher's Drydock approval, or with different bytes than the ones it reviewed.`,
  },
};

/**
 * The README badge's verdict, on the page the badge links to. Rendered only
 * when the badge speaks for exactly the version on the right of this diff.
 */
export function BadgeVerdictNotice({ verdict }: { verdict: BadgeVerdict }) {
  const copy = COPY[verdict.outcome];
  return (
    <Alert tone={copy.tone}>
      <p class="m-0">
        <strong>{copy.title}</strong> {copy.body(verdict)} The diff below is Drydock's public
        comparison of the same release.
      </p>
    </Alert>
  );
}
