import type { ComponentChildren } from "preact";
import { cn } from "./cn";
import { BrandMark } from "./BrandMark";
import { LinkButton } from "./Button";

const FEEDBACK_MAILTO =
  "mailto:drydock@resynapse.dev?subject=Drydock%20feedback&body=Tell%20us%20what%27s%20broken%2C%20confusing%2C%20or%20missing%3A%0A%0A";

export function PageShell({
  class: className,
  children,
  width = "wide",
  brand = true,
  headerActions,
}: {
  class?: string;
  children: ComponentChildren;
  width?: "narrow" | "doc" | "wide";
  brand?: boolean;
  headerActions?: ComponentChildren;
}) {
  const maxWidth =
    width === "narrow" ? "max-w-[640px]" : width === "doc" ? "max-w-[880px]" : "max-w-[1160px]";
  return (
    <main class={cn("mx-auto w-full px-6 pt-6 pb-24 flex flex-col gap-6", maxWidth, className)}>
      {brand ? (
        <div class="flex flex-wrap items-center justify-between gap-3">
          <BrandMark href="/" size="sm" />
          <div class="flex items-center gap-2">
            <LinkButton
              href={FEEDBACK_MAILTO}
              variant="ghost"
              size="sm"
              title="Email drydock@resynapse.dev with any issues"
            >
              Feedback
            </LinkButton>
            {headerActions}
          </div>
        </div>
      ) : null}
      {children}
    </main>
  );
}
