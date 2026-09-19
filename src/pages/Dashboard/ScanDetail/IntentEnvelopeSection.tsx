import type { IntentEnvelope, IntentEnvelopeTier } from "../../../../server/types";
import { Badge, type BadgeTone } from "../../../components/Badge";
import { SectionLabel } from "../../../components/Typography";

// Advisory source-binding row rendered under the recommendation. The envelope
// never changes risk, so tier tones stay informational (ok / info / neutral)
// rather than borrowing severity colors. Scans persisted before the envelope
// existed render nothing (the parent passes null).
export function IntentEnvelopeSection({ envelope }: { envelope: IntentEnvelope }) {
  const signals = sourceBindingSignals(envelope);
  return (
    <section class="flex flex-col gap-3 min-w-0">
      <SectionLabel as="h3">Source binding</SectionLabel>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Badge tone={tierTone(envelope.tier)}>{envelope.tier}</Badge>
        <span class="text-[13px] leading-[1.55] text-ink min-w-0">{tierDescription(envelope)}</span>
        {envelope.repository ? <RepositoryLink repository={envelope.repository} /> : null}
      </div>
      {signals.length ? (
        <ul class="list-none p-0 m-0 flex flex-col gap-2">
          {signals.map((signal, index) => (
            <li
              key={`${signal.kind}-${index}`}
              class="grid grid-cols-1 sm:grid-cols-[132px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]"
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
    return "Built and held by a GitHub workflow gate.";
  }
  if (envelope.tier === "declared") {
    return "Repository declared · unverified";
  }
  return "No repository binding — the artifact cannot be tied to reviewed source.";
}

export function sourceBindingSignals(envelope: IntentEnvelope): IntentEnvelope["signals"] {
  // Only remove the exact standard declaration already represented above.
  // Other manifest details may describe conflicting or additional evidence.
  const duplicate = `manifest declares ${envelope.repository} — claimed by the package, not verified`;
  return envelope.signals.filter(
    (signal) =>
      !(
        envelope.tier === "declared" &&
        envelope.repository &&
        signal.kind === "manifest-repository" &&
        signal.detail === duplicate
      ),
  );
}

function RepositoryLink({ repository }: { repository: string }) {
  const href = repositoryLinkHref(repository);
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      class="text-[13px] text-accent hover:underline break-all"
    >
      {repositoryDisplayName(repository)}
    </a>
  ) : (
    <span class="text-[13px] text-ink-muted break-all">{repository}</span>
  );
}

export function repositoryLinkHref(repository: string): string | undefined {
  try {
    const url = new URL(repository);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function repositoryDisplayName(repository: string): string {
  return repository.replace(/^https:\/\//, "");
}
