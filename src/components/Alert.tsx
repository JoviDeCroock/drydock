import type { ComponentChildren } from "preact";
import { cn } from "./cn";

export type AlertTone = "critical" | "warn" | "info" | "ok";

const toneStyles: Record<AlertTone, string> = {
  critical: "bg-danger-soft border-danger text-danger",
  warn: "bg-warn-soft border-warn text-warn",
  info: "bg-info-soft border-info text-info",
  ok: "bg-ok-soft border-ok text-ok",
};

export function Alert({
  tone = "info",
  class: className,
  children,
}: {
  tone?: AlertTone;
  class?: string;
  children: ComponentChildren;
}) {
  return (
    <div
      role="alert"
      class={cn(
        "flex items-start gap-2.5 px-3.5 py-3 rounded-md border text-[13px]",
        toneStyles[tone],
        className,
      )}
    >
      <span
        class="w-4 h-4 rounded-full bg-current shrink-0 mt-0.5 opacity-90"
        aria-hidden
      />
      <div class="text-ink flex-1">{children}</div>
    </div>
  );
}
