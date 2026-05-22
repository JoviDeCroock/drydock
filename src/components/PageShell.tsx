import type { ComponentChildren } from "preact";
import { cn } from "./cn";
import { BrandMark } from "./BrandMark";

export function PageShell({
  class: className,
  children,
  width = "wide",
  brand = true,
  headerActions,
}: {
  class?: string;
  children: ComponentChildren;
  width?: "narrow" | "wide";
  brand?: boolean;
  headerActions?: ComponentChildren;
}) {
  return (
    <main
      class={cn(
        "mx-auto w-full px-6 pt-6 pb-24 flex flex-col gap-6",
        width === "narrow" ? "max-w-[640px]" : "max-w-[1160px]",
        className,
      )}
    >
      {brand ? (
        <div class="flex flex-wrap items-center justify-between gap-3">
          <BrandMark href="/" size="sm" />
          {headerActions ? <div class="flex items-center gap-2">{headerActions}</div> : null}
        </div>
      ) : null}
      {children}
    </main>
  );
}
