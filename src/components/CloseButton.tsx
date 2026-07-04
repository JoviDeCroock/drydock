import type { JSX } from "preact";
import { cn } from "./cn";

type CloseButtonProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "class" | "children"> & {
  class?: string;
  ariaLabel?: string;
};

const base =
  "inline-flex items-center justify-center rounded-md leading-none text-ink-subtle transition-colors duration-150 ease-out cursor-pointer focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";

export function CloseButton({
  class: className,
  ariaLabel = "Close",
  type = "button",
  ...props
}: CloseButtonProps) {
  return (
    <button type={type} aria-label={ariaLabel} class={cn(base, className)} {...props}>
      ✕
    </button>
  );
}
