import type { ComponentChildren } from "preact";
import { cn } from "./cn";

export function Label({
  children,
  for: htmlFor,
  class: className,
}: {
  children: ComponentChildren;
  for?: string;
  class?: string;
}) {
  return (
    <label
      for={htmlFor}
      class={cn(
        "block font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-ink-subtle mb-1.5",
        className,
      )}
    >
      {children}
    </label>
  );
}

export function Field({
  label,
  for: htmlFor,
  children,
  class: className,
}: {
  label: ComponentChildren;
  for?: string;
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <div class={cn("w-full", className)}>
      <Label for={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
