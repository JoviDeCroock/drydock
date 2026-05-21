import type { JSX } from "preact";
import { cn } from "./cn";

type InputProps = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "class"> & {
  class?: string;
};

export function Input({ class: className, ...props }: InputProps) {
  return (
    <input
      class={cn(
        "w-full bg-bg border border-border rounded-md text-[13px] text-ink px-3 py-2 outline-none transition-[border-color,box-shadow] duration-150 ease-out",
        "placeholder:text-ink-subtle",
        "focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)]",
        "disabled:opacity-60 disabled:cursor-not-allowed",
        className,
      )}
      {...props}
    />
  );
}
