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
  sm: "text-xs px-2.5 py-1.5",
  md: "text-[13px] px-3.5 py-2",
};

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
      class={cn(base, variantStyles[variant], sizeStyles[size], className)}
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
      class={cn(base, "no-underline", variantStyles[variant], sizeStyles[size], className)}
      {...props}
    >
      {children}
    </a>
  );
}
