import type { ComponentChildren } from "preact";
import { cn } from "./cn";

export function PageShell({
  class: className,
  children,
  width = "wide",
}: {
  class?: string;
  children: ComponentChildren;
  width?: "narrow" | "wide";
}) {
  return (
    <main
      class={cn(
        "mx-auto w-full px-6 py-12 pb-24 flex flex-col gap-6",
        width === "narrow" ? "max-w-[640px]" : "max-w-[1160px]",
        className,
      )}
    >
      {children}
    </main>
  );
}
