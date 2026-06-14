import type { ComponentChildren } from "preact";
import { cn } from "./cn";
import { BrandMark } from "./BrandMark";
import { LinkButton } from "./Button";
import { AikidoFootnote, AikidoMark } from "./AikidoPartner";
import { BRAND_NAME, CONTACT_EMAIL, TAGLINE } from "../brand";

const FEEDBACK_MAILTO = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(
  `${BRAND_NAME} feedback`,
)}&body=${encodeURIComponent("Tell us what's broken, confusing, or missing:\n\n")}`;

const SECURITY_MAILTO = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(
  `${BRAND_NAME} security report`,
)}&body=${encodeURIComponent("Describe the issue and how to reproduce it:\n\n")}`;

const AIKIDO_URL = "https://www.aikido.dev";

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
}: {
  class?: string;
  children: ComponentChildren;
  width?: "narrow" | "doc" | "wide";
  brand?: boolean;
  headerActions?: ComponentChildren;
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
              <BrandMark href="/" size="sm" />
              <span aria-hidden class="h-3.5 w-px bg-border-strong" />
              <a
                href={AIKIDO_URL}
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center opacity-90 hover:opacity-100 transition-opacity duration-150 ease-out"
                title="Aikido Security"
              >
                <AikidoMark size="xs" />
              </a>
            </div>
            <div class="flex items-center gap-2">
              <LinkButton
                href={FEEDBACK_MAILTO}
                variant="ghost"
                size="sm"
                title={`Email ${CONTACT_EMAIL} with any issues`}
              >
                Feedback
              </LinkButton>
              {headerActions}
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
        <div class="flex flex-col gap-1">
          <BrandMark href="/" size="sm" />
          <p class="m-0 font-mono text-[11px] text-ink-subtle">
            {TAGLINE} · © 2026 {BRAND_NAME}
          </p>
        </div>
        <nav class="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]" aria-label="Footer">
          <a href="/docs" class={linkClass}>
            Docs
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
