import type { ComponentChildren, JSX } from "preact";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

type ButtonBaseProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  class?: string;
  children?: ComponentChildren;
};

type ButtonProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "class"> & ButtonBaseProps;
type AnchorProps = Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "class"> & ButtonBaseProps;

const base =
  "inline-flex items-center justify-center gap-1.5 font-medium leading-none rounded-md border border-transparent transition-colors duration-150 ease-out cursor-pointer disabled:cursor-not-allowed disabled:opacity-50";

const variantStyles: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-on hover:bg-accent-hover",
  secondary: "bg-surface-2 text-ink border-border hover:border-border-strong",
  ghost: "bg-transparent text-ink-muted hover:bg-surface-2 hover:text-ink",
  danger: "bg-danger text-white hover:brightness-95",
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1.5",
  md: "px-3.5 py-2",
};

// White-on-accent (and white-on-danger) requires 13px/500 minimum per
// DESIGN.md's contrast rules, so small primary/danger buttons keep the md
// text size; the quieter variants may drop to 12px at size sm.
function textSize(variant: ButtonVariant, size: ButtonSize): string {
  if (size === "md") return "text-[13px]";
  return variant === "primary" || variant === "danger" ? "text-[13px]" : "text-xs";
}

export function Button({
  variant = "primary",
  size = "md",
  class: className,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      class={cn(base, variantStyles[variant], sizeStyles[size], textSize(variant, size), className)}
      {...props}
    >
      {children}
    </button>
  );
}

export function LinkButton({
  variant = "primary",
  size = "md",
  class: className,
  children,
  ...props
}: AnchorProps) {
  return (
    <a
      class={cn(
        base,
        "no-underline",
        variantStyles[variant],
        sizeStyles[size],
        textSize(variant, size),
        className,
      )}
      {...props}
    >
      {children}
    </a>
  );
}
