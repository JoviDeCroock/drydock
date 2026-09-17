import type { JSX } from "preact";
import { cn } from "./cn";

type InputProps = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "class"> & {
  class?: string;
  // A field holding a machine value — a URL, a token, a digest. The mono face
  // reads a step smaller, so the size moves with it.
  mono?: boolean;
};

export function Input({ class: className, mono = false, ...props }: InputProps) {
  return (
    <input
      class={cn(
        "w-full bg-bg border border-border rounded-md text-ink px-3 py-2 outline-none transition-[border-color,box-shadow] duration-150 ease-out",
        mono ? "font-mono text-[12px]" : "text-[13px]",
        "placeholder:text-ink-subtle",
        "focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)]",
        "disabled:opacity-60 disabled:cursor-not-allowed",
        className,
      )}
      {...props}
    />
  );
}
