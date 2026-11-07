import type { IntentEnvelope } from "../../../../server/types";
import { SectionLabel } from "../../../components/Typography";

// Advisory source-binding row rendered under the recommendation. The envelope
// never changes risk and asks nothing of the reader, so the tier is stated once
// in plain text beside the repository rather than as a chip that repeats it.
// Scans persisted before the envelope existed render nothing (the parent
// passes null).
export function IntentEnvelopeSection({ envelope }: { envelope: IntentEnvelope }) {
  const signals = sourceBindingSignals(envelope);
  return (
    <section class="flex flex-col gap-3 min-w-0">
      <SectionLabel as="h3">Source binding</SectionLabel>
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {envelope.repository ? <RepositoryLink repository={envelope.repository} /> : null}
        <span class="text-[13px] leading-[1.55] text-ink-muted min-w-0">
          {tierDescription(envelope)}
        </span>
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

export function tierDescription(envelope: Pick<IntentEnvelope, "tier">): string {
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
