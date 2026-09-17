import type { JSX } from "preact";
import { cn } from "./cn";

type CloseButtonProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "class" | "children"> & {
  class?: string;
  ariaLabel?: string;
  // `icon` is the square target that sits in a corner of a surface and tints on
  // hover; `bare` is the inline ✕ that rides along with a line of text.
  variant?: "bare" | "icon";
};

// No focus suppression here: the global `:focus-visible` accent outline
// (src/style.css) is the system focus indicator, and removing it left keyboard
// users with no visible focus on toast/dialog dismiss buttons.
const base =
  "inline-flex items-center justify-center rounded-md leading-none text-ink-subtle hover:text-ink transition-colors duration-150 ease-out cursor-pointer disabled:cursor-not-allowed disabled:opacity-50";

const iconVariant = "w-7 h-7 hover:bg-surface-2";

export function CloseButton({
  class: className,
  ariaLabel = "Close",
  type = "button",
  variant = "bare",
  ...props
}: CloseButtonProps) {
  return (
    <button
      type={type}
      aria-label={ariaLabel}
      class={cn(base, variant === "icon" && iconVariant, className)}
      {...props}
    >
      ✕
    </button>
  );
}
