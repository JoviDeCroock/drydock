import aikidoLight from "../assets/aikido-wordmark.svg";
import aikidoDark from "../assets/aikido-wordmark-inverted.svg";
import auditBadgeLight from "../assets/aikido-audit-badge.svg";
import auditBadgeDark from "../assets/aikido-audit-badge-inverted.svg";
import { cn } from "./cn";
import { SectionLabel } from "./Typography";

const AIKIDO_URL = "https://www.aikido.dev";

const AIKIDO_AUDIT_URL =
  "https://app.aikido.dev/audit-report/external/CZk2iewoH6nxS5KNb3erdMV2/request";

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

export function AikidoAuditBadge({ class: className }: { class?: string }) {
  const imgProps = {
    alt: "Aikido Security audit report",
    loading: "lazy",
    decoding: "async",
  } as const;
  const imageClass = "h-5 w-auto";
  return (
    <a
      href={AIKIDO_AUDIT_URL}
      target="_blank"
      rel="noopener noreferrer"
      class={cn(
        "inline-flex items-center opacity-80 hover:opacity-100 transition-opacity duration-150 ease-out",
        className,
      )}
      aria-label="View Aikido Security audit report"
    >
      {/* Theme-matched badge swapped via the same prefers-color-scheme query the
          tokens use, so it can never disagree with the page theme. */}
      <img src={auditBadgeLight} {...imgProps} class={cn(imageClass, "dark:hidden")} />
      <img src={auditBadgeDark} {...imgProps} class={cn(imageClass, "hidden dark:inline-block")} />
    </a>
  );
}

export function AikidoPartnerStrip({ class: className }: { class?: string }) {
  return (
    <section aria-label="Sponsored by Aikido Security" class={cn("flex flex-col gap-4", className)}>
      <SectionLabel>Sponsored by</SectionLabel>
      <a
        href={AIKIDO_URL}
        target="_blank"
        rel="noopener noreferrer"
        class="group self-center inline-flex flex-col items-center gap-2"
        aria-label="Visit Aikido Security"
      >
        <AikidoMark
          size="lg"
          class="opacity-80 transition-opacity duration-150 ease-out group-hover:opacity-100"
        />
        <span class="font-mono text-[10px] tracking-[0.05em] text-ink-subtle transition-colors duration-150 ease-out group-hover:text-ink-muted">
          aikido.dev →
        </span>
      </a>
    </section>
  );
}
