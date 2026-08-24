import type { ComponentChildren } from "preact";
import { useComputed } from "@preact/signals";
import githubMarkBlack from "../assets/github-mark-black.png";
import githubMarkWhite from "../assets/github-mark-white.png";
import { sessionModel } from "../models/auth";
import { cn } from "./cn";
import { BrandMark } from "./BrandMark";
import { LinkButton } from "./Button";
import { AikidoFootnote } from "./AikidoPartner";

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
      <SkipLink />
      {brand ? (
        // A real banner landmark outside <main>, so landmark navigation and
        // the skip link can bypass the header actions on every route. The
        // pt-6 here plus main's pt-6 reproduces the former in-main gap-6.
        <header class={cn("mx-auto w-full px-6 pt-6", maxWidth)}>
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
        </header>
      ) : null}
      <main
        id="main-content"
        class={cn("mx-auto w-full grow px-6 pt-6 pb-16 flex flex-col gap-6", maxWidth, className)}
      >
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

// Visually hidden until keyboard-focused; the first tab stop on every page.
function SkipLink() {
  return (
    <a
      href="#main-content"
      class="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:border focus:border-border focus:bg-surface focus:px-3 focus:py-2 focus:text-[13px] focus:text-ink focus:no-underline focus:shadow-md"
    >
      Skip to content
    </a>
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
        <div class="flex flex-col gap-1">
          <BrandMark href="/" size="sm" />
          <p class="m-0 font-mono text-[11px] text-ink-subtle">
            Pre-publish review for npm, PyPI, and VS Code · © 2026 Drydock
          </p>
        </div>
        <nav class="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]" aria-label="Footer">
          <a href="/diff" class={linkClass}>
            Package diff
          </a>
          <a href="/docs" class={linkClass}>
            Docs
          </a>
          <a
            href="https://github.com/JoviDeCroock/drydock"
            class="inline-flex size-5 items-center justify-center rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View Drydock source code on GitHub"
            title="View Drydock source code on GitHub"
          >
            <img
              src={githubMarkBlack}
              alt=""
              class="h-4 w-auto dark:hidden"
              width="294"
              height="288"
            />
            <img
              src={githubMarkWhite}
              alt=""
              class="hidden h-4 w-auto dark:inline-block"
              width="294"
              height="288"
            />
          </a>
          <a href="/privacy" class={linkClass}>
            Privacy
          </a>
          <a href="/security" class={linkClass}>
            Security model
          </a>
          <a href="/open-source" class={linkClass}>
            Open source
          </a>
          <a href={FEEDBACK_MAILTO} class={linkClass}>
            Feedback
          </a>
          <a href={SECURITY_MAILTO} class={linkClass}>
            Report security
          </a>
          <AikidoFootnote />
        </nav>
      </div>
    </footer>
  );
}
