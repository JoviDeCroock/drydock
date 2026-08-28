import type { ComponentChildren } from "preact";
import { useComputed } from "@preact/signals";
import githubMarkBlack from "../assets/github-mark-black.png";
import githubMarkWhite from "../assets/github-mark-white.png";
import { sessionModel } from "../models/auth";
import { cn } from "./cn";
import { BrandMark } from "./BrandMark";
import { LinkButton } from "./Button";
import { AikidoFootnote } from "./AikidoPartner";
import { MonoLabel } from "./Typography";

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

const GITHUB_REPO_URL = "https://github.com/JoviDeCroock/drydock";

const FOOTER_LINK_CLASS =
  "text-ink-muted no-underline transition-colors hover:text-ink focus-visible:text-ink";

// Grouped so the destinations read as intents rather than one undifferentiated
// link run: what you can use, what you can verify, what you can read, who to
// reach.
const FOOTER_GROUPS = [
  {
    id: "footer-product",
    title: "Product",
    links: [
      { label: "Package diff", href: "/diff" },
      { label: "Docs", href: "/docs" },
    ],
  },
  {
    id: "footer-trust",
    title: "Trust",
    links: [
      { label: "Security model", href: "/security" },
      { label: "Privacy", href: "/privacy" },
    ],
  },
  {
    id: "footer-project",
    title: "Project",
    links: [
      { label: "Open source", href: "/open-source" },
      { label: "GitHub", href: GITHUB_REPO_URL, mark: "github" },
    ],
  },
  {
    id: "footer-contact",
    title: "Contact",
    links: [
      { label: "Feedback", href: FEEDBACK_MAILTO },
      { label: "Report security", href: SECURITY_MAILTO },
    ],
  },
] as const;

function SiteFooter({ maxWidth }: { maxWidth: string }) {
  return (
    <footer class="border-t border-border">
      <div
        class={cn(
          "mx-auto flex w-full flex-col gap-10 px-6 py-10 md:flex-row md:justify-between md:gap-12",
          maxWidth,
        )}
      >
        <div class="flex flex-col items-start gap-3">
          <BrandMark href="/" size="sm" />
          <p class="m-0 font-mono text-[11px] leading-[1.6] text-ink-subtle">
            Pre-publish review for npm, PyPI, and VS Code
            <br />© 2026 Drydock
          </p>
          <AikidoFootnote class="text-[13px]" />
        </div>
        <nav class="flex flex-wrap gap-x-12 gap-y-8 text-[13px]" aria-label="Footer">
          {FOOTER_GROUPS.map((group) => (
            <FooterGroup key={group.id} id={group.id} title={group.title}>
              {group.links.map((link) =>
                "mark" in link ? (
                  <li key={link.href}>
                    <GithubRepoLink label={link.label} href={link.href} />
                  </li>
                ) : (
                  <li key={link.href}>
                    <a href={link.href} class={FOOTER_LINK_CLASS}>
                      {link.label}
                    </a>
                  </li>
                ),
              )}
            </FooterGroup>
          ))}
        </nav>
      </div>
    </footer>
  );
}

function FooterGroup({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ComponentChildren;
}) {
  return (
    <div class="flex min-w-[104px] flex-col gap-3">
      <MonoLabel as="p" id={id}>
        {title}
      </MonoLabel>
      <ul aria-labelledby={id} class="m-0 flex list-none flex-col gap-2 p-0">
        {children}
      </ul>
    </div>
  );
}

function GithubRepoLink({ label, href }: { label: string; href: string }) {
  // alt="" on both marks so the accessible name is the visible label text.
  return (
    <a
      href={href}
      class={cn(FOOTER_LINK_CLASS, "group inline-flex items-center gap-2")}
      target="_blank"
      rel="noopener noreferrer"
    >
      <img
        src={githubMarkBlack}
        alt=""
        class="h-4 w-auto opacity-70 transition-opacity group-hover:opacity-100 dark:hidden"
        width="294"
        height="288"
      />
      <img
        src={githubMarkWhite}
        alt=""
        class="hidden h-4 w-auto opacity-70 transition-opacity group-hover:opacity-100 dark:inline-block"
        width="294"
        height="288"
      />
      {label}
    </a>
  );
}
