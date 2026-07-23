import type { ComponentChildren } from "preact";
import { cn } from "./cn";

export type AlertTone = "critical" | "warn" | "info" | "ok";

const toneStyles: Record<AlertTone, string> = {
  critical: "bg-danger-soft border-danger text-danger-text",
  warn: "bg-warn-soft border-warn text-warn-text",
  info: "bg-info-soft border-info text-info-text",
  ok: "bg-ok-soft border-ok text-ok-text",
};

// The disc is a shape, so it takes the saturated token — inheriting the text
// color via bg-current would render it in the -text variant (DESIGN.md lists
// alert discs under saturated shapes, like the border).
const toneDisc: Record<AlertTone, string> = {
  critical: "bg-danger",
  warn: "bg-warn",
  info: "bg-info",
  ok: "bg-ok",
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
  const role = tone === "critical" || tone === "warn" ? "alert" : "status";
  return (
    <div
      role={role}
      class={cn(
        "flex items-start gap-2.5 px-3.5 py-3 rounded-md border text-[13px]",
        toneStyles[tone],
        className,
      )}
    >
      <span
        class={cn("w-4 h-4 rounded-full shrink-0 mt-0.5 opacity-90", toneDisc[tone])}
        aria-hidden
      />
      <div class="text-ink flex-1">{children}</div>
    </div>
  );
}
