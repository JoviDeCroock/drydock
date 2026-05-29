import aikidoLight from "../assets/aikido-wordmark.svg";
import aikidoDark from "../assets/aikido-wordmark-inverted.svg";
import { cn } from "./cn";

const AIKIDO_URL = "https://www.aikido.dev";

const HEIGHTS = {
  xs: 14,
  sm: 18,
  md: 24,
  lg: 32,
} as const;

type MarkSize = keyof typeof HEIGHTS;

export function AikidoMark({ size = "sm", class: className }: { size?: MarkSize; class?: string }) {
  const height = HEIGHTS[size];
  return (
    <picture class={cn("inline-flex items-center leading-none", className)}>
      <source srcSet={aikidoDark} media="(prefers-color-scheme: dark)" />
      <img
        src={aikidoLight}
        alt="Aikido Security"
        height={height}
        style={{ height: `${height}px`, width: "auto" }}
        loading="lazy"
        decoding="async"
      />
    </picture>
  );
}

export function AikidoFootnote({ class: className }: { class?: string }) {
  return (
    <div
      class={cn(
        "flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle",
        className,
      )}
    >
      <span>Security partner</span>
      <span aria-hidden>·</span>
      <a
        href={AIKIDO_URL}
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center hover:opacity-80 transition-opacity duration-150 ease-out"
        aria-label="Aikido Security — Drydock's exclusive security vendor sponsor"
      >
        <AikidoMark size="xs" />
      </a>
    </div>
  );
}

export function AikidoPartnerStrip({ class: className }: { class?: string }) {
  return (
    <section
      aria-label="Security partner"
      class={cn(
        "rounded-lg border border-border bg-surface px-5 py-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-6",
        className,
      )}
    >
      <div class="flex flex-col gap-2 min-w-0">
        <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-accent">
          Exclusive security partner
        </span>
        <p class="text-[13px] leading-[1.55] text-ink-muted m-0 max-w-[560px]">
          Drydock partners with{" "}
          <a
            href={AIKIDO_URL}
            target="_blank"
            rel="noopener noreferrer"
            class="text-ink underline decoration-border-strong underline-offset-2 hover:decoration-accent"
          >
            Aikido Security
          </a>{" "}
          — our exclusive security vendor sponsor. Every release is reviewed with their backing.
        </p>
      </div>
      <a
        href={AIKIDO_URL}
        target="_blank"
        rel="noopener noreferrer"
        class="shrink-0 self-start md:self-center hover:opacity-80 transition-opacity duration-150 ease-out"
        aria-label="Visit Aikido Security"
      >
        <AikidoMark size="lg" />
      </a>
    </section>
  );
}
