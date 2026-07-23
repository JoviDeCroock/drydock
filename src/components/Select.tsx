import type { ComponentChildren, JSX } from "preact";
import type { ReadonlySignal, Signal } from "@preact/signals";
import { cn } from "./cn";

type SelectSize = "sm" | "md";

const sizeStyles: Record<SelectSize, string> = {
  sm: "text-xs leading-none pl-2.5 pr-8 py-1.5",
  md: "text-[13px] pl-3 pr-9 py-2",
};

const arrowStyles: Record<SelectSize, string> = {
  sm: "right-2.5",
  md: "right-3",
};

// Rest props (aria-label and friends) forward to the native <select> — the
// wrapper div is purely presentational, so accessibility attributes must not
// end up on it.
type SelectProps = Omit<
  JSX.SelectHTMLAttributes<HTMLSelectElement>,
  "class" | "size" | "value" | "disabled" | "onChange"
> & {
  // ReadonlySignal so narrower signals (union-typed values, computeds) can be
  // passed directly; the component only ever reads the value.
  value: string | ReadonlySignal<string>;
  disabled?: boolean | Signal<boolean>;
  onChange: (value: string) => void;
  children: ComponentChildren;
  size?: SelectSize;
  class?: string;
};

export function Select({
  id,
  value,
  disabled,
  onChange,
  children,
  size = "md",
  class: className,
  ...rest
}: SelectProps) {
  return (
    <div class="relative inline-block w-full">
      <select
        {...rest}
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange((event.currentTarget as HTMLSelectElement).value)}
        class={cn(
          "appearance-none w-full bg-bg border border-border rounded-md text-ink outline-none transition-[border-color,box-shadow] duration-150 ease-out focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)] disabled:opacity-60 disabled:cursor-not-allowed",
          sizeStyles[size],
          className,
        )}
      >
        {children}
      </select>
      <span
        aria-hidden="true"
        class={cn(
          "pointer-events-none absolute top-1/2 -translate-y-1/2 text-[10px] text-ink-muted",
          arrowStyles[size],
        )}
      >
        ▾
      </span>
    </div>
  );
}
