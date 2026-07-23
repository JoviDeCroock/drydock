import type { Signal } from "@preact/signals";
import { cn } from "./cn";

type Size = "sm" | "md" | "lg";

const SIZE_CLASS: Record<Size, string> = {
  sm: "text-[15px] tracking-[-0.025em]",
  md: "text-[20px] tracking-[-0.03em]",
  lg: "text-[28px] tracking-[-0.04em] leading-none",
};

export function BrandMark({
  href,
  size = "sm",
  class: className,
  ariaLabel,
}: {
  href?: string | Signal<string>;
  size?: Size;
  class?: string;
  ariaLabel?: string | Signal<string>;
}) {
  const classes = cn(
    "inline-block font-semibold text-accent select-none",
    SIZE_CLASS[size],
    href ? "no-underline transition-colors hover:text-accent-hover" : "",
    className,
  );
  if (href) {
    return (
      <a href={href} class={classes} aria-label={ariaLabel ?? "Drydock home"}>
        drydock
      </a>
    );
  }
  // No aria-label: it is prohibited ARIA on a generic role, and the visible
  // text already names the brand.
  return <span class={classes}>drydock</span>;
}
