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
  const imgProps = {
    alt: "Aikido Security",
    height,
    style: { height: `${height}px`, width: "auto" },
    loading: "lazy",
    decoding: "async",
  } as const;
  return (
    // Swapped via the same prefers-color-scheme media query the theme tokens
    // use (Tailwind `dark:`), so the mark can never disagree with the page
    // theme — <picture> source selection is evaluated separately from CSS.
    <span class={cn("inline-flex items-center leading-none", className)}>
      <img src={aikidoLight} class="dark:hidden" {...imgProps} />
      <img src={aikidoDark} class="hidden dark:inline-block" {...imgProps} />
    </span>
  );
}

export function AikidoFootnote({ class: className }: { class?: string }) {
  return (
    <a
      href={AIKIDO_URL}
      target="_blank"
      rel="noopener noreferrer"
      class={cn(
        "inline-flex items-center opacity-80 hover:opacity-100 transition-opacity duration-150 ease-out",
        className,
      )}
      aria-label="Aikido Security"
    >
      <AikidoMark size="xs" />
    </a>
  );
}

export function AikidoPartnerStrip({ class: className }: { class?: string }) {
  return (
    <section
      aria-label="Aikido Security"
      class={cn("flex items-center gap-6 md:gap-10 pb-6", className)}
    >
      <span aria-hidden class="h-px flex-1 bg-border" />
      {/* Caption hangs below the link so the flanking hairlines align with the
          wordmark's center, not the center of mark + caption combined. */}
      <a
        href={AIKIDO_URL}
        target="_blank"
        rel="noopener noreferrer"
        class="group relative inline-flex flex-col items-center"
        aria-label="Visit Aikido Security"
      >
        <AikidoMark
          size="lg"
          class="opacity-80 transition-opacity duration-150 ease-out group-hover:opacity-100"
        />
        <span class="absolute top-full mt-2 whitespace-nowrap font-mono text-[10px] tracking-[0.05em] text-ink-subtle transition-colors duration-150 ease-out group-hover:text-ink-muted">
          aikido.dev →
        </span>
      </a>
      <span aria-hidden class="h-px flex-1 bg-border" />
    </section>
  );
}
