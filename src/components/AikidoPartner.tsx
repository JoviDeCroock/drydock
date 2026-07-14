import aikidoLight from "../assets/aikido-wordmark.svg";
import aikidoDark from "../assets/aikido-wordmark-inverted.svg";
import { cn } from "./cn";
import { SectionLabel } from "./Typography";

const AIKIDO_URL = "https://www.aikido.dev";

const markSizeClass = {
  xs: "h-[14px]",
  sm: "h-[18px]",
  md: "h-6",
  lg: "h-8",
} as const;

type MarkSize = keyof typeof markSizeClass;

export function AikidoMark({ size = "sm", class: className }: { size?: MarkSize; class?: string }) {
  const imageClass = cn("w-auto", markSizeClass[size]);
  const imgProps = {
    alt: "Aikido Security",
    loading: "lazy",
    decoding: "async",
  } as const;
  return (
    // Swapped via the same prefers-color-scheme media query the theme tokens
    // use (Tailwind `dark:`), so the mark can never disagree with the page
    // theme — <picture> source selection is evaluated separately from CSS.
    <span class={cn("inline-flex items-center leading-none", className)}>
      <img src={aikidoLight} {...imgProps} class={cn(imageClass, "dark:hidden")} />
      <img src={aikidoDark} {...imgProps} class={cn(imageClass, "hidden dark:inline-block")} />
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
        "text-ink-muted inline-flex items-center opacity-80 hover:opacity-100 transition-opacity duration-150 ease-out",
        className,
      )}
      aria-label="Aikido Security"
    >
      <span class="mr-2">Sponsored by</span> <AikidoMark size="xs" />
    </a>
  );
}

export function AikidoPartnerStrip({ class: className }: { class?: string }) {
  return (
    <section aria-label="Sponsored by Aikido Security" class={cn("flex flex-col gap-4", className)}>
      <SectionLabel>Supported by security builders</SectionLabel>
      <div class="flex flex-col gap-5 rounded-lg border border-border bg-surface p-5 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex max-w-[620px] flex-col gap-1.5">
          <h2 class="m-0 text-base font-medium tracking-[-0.005em]">
            Sponsored by Aikido Security
          </h2>
          <p class="m-0 text-[13px] leading-[1.55] text-ink-muted">
            Aikido supports Drydock's work on practical, artifact-level supply-chain review for
            package maintainers.
          </p>
        </div>
        <a
          href={AIKIDO_URL}
          target="_blank"
          rel="noopener noreferrer"
          class="group inline-flex shrink-0 items-center gap-3 self-start sm:self-auto"
          aria-label="Visit Aikido Security"
        >
          <AikidoMark
            size="md"
            class="opacity-80 transition-opacity duration-150 ease-out group-hover:opacity-100"
          />
          <span class="font-mono text-[11px] text-ink-subtle transition-colors duration-150 ease-out group-hover:text-ink-muted">
            aikido.dev →
          </span>
        </a>
      </div>
    </section>
  );
}
