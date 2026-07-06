import type { ComponentChildren } from "preact";
import { useComputed } from "@preact/signals";
import { sessionModel } from "../models/auth";
import { cn } from "./cn";
import { BrandMark } from "./BrandMark";
import { LinkButton } from "./Button";
import { AikidoAuditBadge, AikidoFootnote } from "./AikidoPartner";

const FEEDBACK_MAILTO =
  "mailto:drydock@drydock.org?subject=Drydock%20feedback&body=Tell%20us%20what%27s%20broken%2C%20confusing%2C%20or%20missing%3A%0A%0A";

const SECURITY_MAILTO =
  "mailto:drydock@drydock.org?subject=Drydock%20security%20report&body=Describe%20the%20issue%20and%20how%20to%20reproduce%20it%3A%0A%0A";

const WIDTH_CLASS = {
  narrow: "max-w-[640px]",
  doc: "max-w-[880px]",
  wide: "max-w-[1160px]",
} as const;

export function PageShell({
  class: className,
  children,
  width = "wide",
  brand = true,
  headerActions,
  feedbackPosition = "start",
}: {
  class?: string;
  children: ComponentChildren;
  width?: "narrow" | "doc" | "wide";
  brand?: boolean;
  headerActions?: ComponentChildren;
  feedbackPosition?: "start" | "end";
}) {
  const maxWidth = WIDTH_CLASS[width];
  // Narrow pages are single short cards (auth, 404, invite). Center them in the
  // viewport instead of pinning them to the top with a large void below.
  const centered = width === "narrow";
  return (
    <div class="flex min-h-[100svh] flex-col">
      <main
        class={cn("mx-auto w-full grow px-6 pt-6 pb-16 flex flex-col gap-6", maxWidth, className)}
      >
        {brand ? (
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-2.5">
              <HeaderBrandMark />
            </div>
            <div class="flex items-center gap-2">
              {feedbackPosition === "start" ? <FeedbackButton /> : null}
              {headerActions}
              {feedbackPosition === "end" ? <FeedbackButton /> : null}
            </div>
          </div>
        ) : null}
        {centered ? (
          // `my-auto` (not justify-center) so over-tall content never clips off-screen.
          <div class="my-auto flex w-full flex-col gap-6">{children}</div>
        ) : (
          children
        )}
      </main>
      <SiteFooter maxWidth={maxWidth} />
    </div>
  );
}

function FeedbackButton() {
  return (
    <LinkButton
      href={FEEDBACK_MAILTO}
      variant="ghost"
      size="sm"
      title="Email drydock@drydock.org with any issues"
    >
      Feedback
    </LinkButton>
  );
}

function HeaderBrandMark() {
  const href = useComputed(() => (sessionModel.authenticated.value ? "/dashboard" : "/"));
  const ariaLabel = useComputed(() =>
    sessionModel.authenticated.value ? "Drydock dashboard" : "Drydock home",
  );
  return <BrandMark href={href} size="sm" ariaLabel={ariaLabel} />;
}

function SiteFooter({ maxWidth }: { maxWidth: string }) {
  const linkClass =
    "text-ink-muted no-underline transition-colors hover:text-ink focus-visible:text-ink";
  return (
    <footer class="border-t border-border">
      <div
        class={cn(
          "mx-auto flex w-full flex-col gap-4 px-6 py-8 sm:flex-row sm:items-center sm:justify-between",
          maxWidth,
        )}
      >
        <div class="flex flex-col gap-2">
          <BrandMark href="/" size="sm" />
          <p class="m-0 font-mono text-[11px] text-ink-subtle">
            Pre-publish review for npm and PyPI · © 2026 Drydock
          </p>
          <AikidoAuditBadge />
        </div>
        <nav class="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]" aria-label="Footer">
          <a href="/docs" class={linkClass}>
            Docs
          </a>
          <a href="/privacy" class={linkClass}>
            Privacy
          </a>
          <a href={FEEDBACK_MAILTO} class={linkClass}>
            Feedback
          </a>
          <a href={SECURITY_MAILTO} class={linkClass}>
            Security
          </a>
          <AikidoFootnote />
        </nav>
      </div>
    </footer>
  );
}
