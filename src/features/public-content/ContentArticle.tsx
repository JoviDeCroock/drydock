/**
 * The shared shell for Drydock's short public content pages — the focused
 * discovery guides and the incident analyses.
 *
 * Both surfaces are the same document: an eyebrow/headline/lead hero, a small
 * number of label-led prose sections, and a way onward. Keeping the shell here
 * means the two page directories describe *content* and never re-derive the
 * marketing type scale, which is where the copies would drift first.
 */
import type { ComponentChildren } from "preact";
import { Card } from "../../components/Card";
import { Eyebrow, MonoDetail, SectionLabel } from "../../components/Typography";

export interface ContentArticleSection {
  label: string;
  heading: string;
  body: string;
}

export function ContentArticleHero({
  eyebrow,
  heading,
  lead,
  details,
  actions,
}: {
  eyebrow: string;
  heading: string;
  lead: string;
  details?: string[];
  actions: ComponentChildren;
}) {
  return (
    <header class="pt-8 pb-2 md:pt-12 border-t border-border flex flex-col gap-5">
      <Eyebrow tone="accent">{eyebrow}</Eyebrow>
      <h1 class="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] max-w-[760px] m-0">
        {heading}
      </h1>
      <p class="text-[17px] text-ink-muted max-w-[620px] leading-[1.6] m-0">{lead}</p>
      {details ? <MonoDetail parts={details} /> : null}
      <div class="flex flex-wrap gap-3 mt-1">{actions}</div>
    </header>
  );
}

/**
 * The prose body. Sections are numbered in the section label's trailing slot —
 * the same place a count sits elsewhere — because these read as an ordered
 * argument, and the number is what stops three identically-shaped blocks from
 * scanning as one undifferentiated wall.
 */
export function ContentArticleSections({ sections }: { sections: ContentArticleSection[] }) {
  return (
    <div class="flex flex-col gap-10">
      {sections.map((section, index) => (
        <section key={section.label} class="flex flex-col gap-3">
          <SectionLabel as="p" aside={String(index + 1).padStart(2, "0")}>
            {section.label}
          </SectionLabel>
          <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0 max-w-[680px]">
            {section.heading}
          </h2>
          <p class="m-0 max-w-[680px] text-[14px] text-ink-muted leading-[1.65]">{section.body}</p>
        </section>
      ))}
    </div>
  );
}

/**
 * The artifact facts an analysis rests on, as a document-shaped Card of
 * label/value rows — the same shell the docs page teaches report anatomy with.
 *
 * Values stay on the ink scale and carry no Badge: every row here is a
 * verifiable property of the compared releases, not a risk state, and colour is
 * reserved for signal.
 */
export function ContentArticleEvidence({
  label,
  rows,
}: {
  label: string;
  rows: Array<{ label: string; value: string }>;
}) {
  return (
    <Card as="section" padding="none" class="flex flex-col">
      <div class="px-5 py-4">
        <SectionLabel as="h2">{label}</SectionLabel>
      </div>
      <dl class="m-0 flex flex-col">
        {rows.map((row) => (
          <div
            key={row.label}
            /* The SectionLabel's trailing rule is already this card's header
               divider, so the first row must not draw a second hairline under
               it (docs/design.md). */
            class="grid grid-cols-1 sm:grid-cols-[160px_minmax(0,1fr)] gap-1 sm:gap-4 border-t border-border first:border-t-0 px-5 py-3"
          >
            <dt class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle sm:pt-0.5">
              {row.label}
            </dt>
            <dd class="m-0 font-mono text-[13px] text-ink break-words">{row.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/**
 * A grid of lateral links out of the article. Deliberately *not* the docs
 * page's numbered `JourneyCard`: those steps are ordered, these are peers, and
 * numbering peers invents a sequence the reader would then look for.
 */
export function ContentArticleLinks({
  label,
  links,
}: {
  label: string;
  links: Array<{ href: string; title: string; description: string }>;
}) {
  return (
    <section class="flex flex-col gap-4">
      <SectionLabel as="h2">{label}</SectionLabel>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {links.map((link) => (
          <a key={link.href} href={link.href} class="no-underline text-inherit group">
            <Card
              as="div"
              padding="none"
              class="p-4 h-full flex flex-col gap-1.5 transition-colors duration-150 group-hover:border-accent"
            >
              <h3 class="m-0 text-[14px] font-medium tracking-[-0.005em] flex items-baseline gap-1.5">
                <span>{link.title}</span>
                <span
                  aria-hidden
                  class="text-ink-subtle transition-colors duration-150 group-hover:text-accent"
                >
                  →
                </span>
              </h3>
              <p class="m-0 text-[12px] leading-[1.55] text-ink-muted">{link.description}</p>
            </Card>
          </a>
        ))}
      </div>
    </section>
  );
}

/**
 * The closing ask. Short content pages otherwise end on lateral links or on
 * nothing at all, leaving a reader who got to the bottom with no next step.
 */
export function ContentArticleCta({
  label,
  heading,
  body,
  actions,
  detail,
}: {
  label: string;
  heading: string;
  body: string;
  actions: ComponentChildren;
  detail?: string[];
}) {
  return (
    <section aria-label={label} class="flex flex-col gap-4">
      <SectionLabel as="p">{label}</SectionLabel>
      <h2 class="text-[32px] font-semibold tracking-[-0.02em] leading-[1.15] m-0 max-w-[680px]">
        {heading}
      </h2>
      <p class="m-0 max-w-[620px] text-[14px] text-ink-muted leading-[1.65]">{body}</p>
      <div class="flex flex-wrap gap-3 mt-1">{actions}</div>
      {detail ? <MonoDetail parts={detail} /> : null}
    </section>
  );
}
