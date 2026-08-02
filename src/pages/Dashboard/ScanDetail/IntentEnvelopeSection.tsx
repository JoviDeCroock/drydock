import type { IntentEnvelope, IntentEnvelopeTier } from "../../../../server/types";
import { Badge, type BadgeTone } from "../../../components/Badge";
import { SectionLabel } from "../../../components/Typography";

// Advisory source-binding row rendered under the recommendation. The envelope
// never changes risk, so tier tones stay informational (ok / info / neutral)
// rather than borrowing severity colors. Scans persisted before the envelope
// existed render nothing (the parent passes null).
export function IntentEnvelopeSection({ envelope }: { envelope: IntentEnvelope }) {
  return (
    <section class="flex flex-col gap-3 min-w-0">
      <SectionLabel as="h2">Source binding</SectionLabel>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Badge tone={tierTone(envelope.tier)}>{envelope.tier}</Badge>
        <span class="text-[13px] leading-[1.55] text-ink-muted min-w-0">
          {tierDescription(envelope)}
        </span>
      </div>
      {envelope.signals.length ? (
        <ul class="list-none p-0 m-0 flex flex-col gap-2">
          {envelope.signals.map((signal, index) => (
            <li
              key={`${signal.kind}-${index}`}
              class="grid grid-cols-[132px_minmax(0,1fr)] gap-3 text-[13px]"
            >
              <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
                {signal.kind}
              </span>
              <span class="min-w-0 text-ink-muted break-words">{signal.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function tierTone(tier: IntentEnvelopeTier): BadgeTone {
  if (tier === "attested") return "ok";
  if (tier === "declared") return "info";
  return "neutral";
}

function tierDescription(envelope: IntentEnvelope): string {
  if (envelope.tier === "attested") {
    const repoName = repositoryDisplayName(envelope.repository);
    return repoName
      ? `Built and held by a GitHub workflow gate for ${repoName}.`
      : "Built and held by a GitHub workflow gate.";
  }
  if (envelope.tier === "declared") {
    return envelope.repository
      ? `Package declares repository ${envelope.repository} — binding is unverified.`
      : "Package declares a repository — binding is unverified.";
  }
  return "No repository binding — the artifact cannot be tied to reviewed source.";
}

// "https://github.com/owner/repo" → "owner/repo" for the one-liner; other
// hosts keep the full URL so the forge stays visible.
function repositoryDisplayName(repository: string | null): string | null {
  if (!repository) return null;
  const match = /^https:\/\/github\.com\/(.+)$/.exec(repository);
  return match ? match[1] : repository;
}
