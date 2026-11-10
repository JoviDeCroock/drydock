# Design system

Source of truth for visual decisions: fonts, colors, spacing, glyphs, charts, states, and marketing constraints. **Authority:** internal (do not deviate without explicit approval). **Owner:** `src/style.css` (tokens) and `src/components/` (primitives).

Implementation map: [ui.md](./ui.md). Lint rules enforcing this file: [tooling.md](./tooling.md#lint-rules). Dated rationale: [design-decisions.md](./design-decisions.md).

## Product context

- **What it is:** a second pair of eyes before a release is published, with authority stated by mode. Drydock never publishes.
- **`Workflow Gate — enforced`:** a GitHub deployment-protection rule holds the configured protected publish job until Drydock answers; GitHub enforces the hold, for that job only.
- **`Stage Watchtower — advisory`:** reviews and records npm staged artifacts; npm maintainers independently approve or reject and manual publication remains possible.
- **atpm staging:** reviews a public, content-addressed candidate with verified build provenance.
- **One review surface:** every path renders the same report; ecosystem and path change evidence and authority, never layout.
- **Surfaces:** authenticated scan workbench (dashboard, scan detail, settings); public docs learning path; marketing landing; `/diff`, an anonymous diff of two published npm, PyPI, or atpm versions reusing the review UI.
- **Audience:** package authors, security-conscious maintainers, reviewers at companies publishing to public registries. Category: supply-chain security / developer tooling (adjacent: Socket, Snyk Advisor, Aikido, GitHub Advisory Database, vlt.sh). Web app first.

## Aesthetic

- Restrained dev-tool: confident sans type, one sharp accent, severity carries the chromatic weight; between an operations dashboard and a security advisory document.
- Minimal decoration: type and one mono detail line (scan ID · timestamp · file count). No gradients, icon-in-circle motifs, or decorative chrome.
- Sober, fast, trustworthy: a tool kept open during a publish, not a marketing splash.
- Orange replaces the violet peer tools converge on; each scan gets a focused report, not a sprawling dashboard.

## Typography

| Item | Rule |
| --- | --- |
| Display & body | Geist 400/500/600; `font-feature-settings: "ss01", "cv11"`. |
| Mono | Geist Mono 400/500/600, first-class; `"ss01", "tnum"` (tabular numbers). |
| Mono is for | File paths, severity labels, scan IDs, timestamps, code, section labels. |
| Loading | `@fontsource-variable/geist`, `@fontsource-variable/geist-mono` in `src/style.css`. |

Never reintroduce the Google Fonts CDN `@import`: fonts are self-hosted same-origin (families `"Geist Variable"` / `"Geist Mono Variable"`) so no visitor IP reaches a third-party font CDN (GDPR).

### Scale

| Role | Size | Weight | Letter-spacing | Line-height |
| --- | --- | --- | --- | --- |
| Display 1 (hero) | 44–56px | 600 | -0.03em | 1.05 |
| Display 2 | 32px | 600 | -0.02em | 1.15 |
| Heading 1 | 24px | 600 | -0.015em | 1.25 |
| Heading 2 | 18px | 500 | -0.01em | 1.35 |
| Body | 14px | 400 | 0 | 1.55 |
| Body sm | 13px | 400 | 0 | 1.5 |
| Mono code | 13px | 400/500 | 0 | 1.5 |
| Mono label | 11px uppercase | 500 | 0.1em | 1.4 |

### Minimum size and contrast

| Size | Role | Colors |
| --- | --- | --- |
| 10px | Scanning only, never a label the user reads | `--fg-subtle` |
| 11px | Floor for every read label | `--fg-subtle` (AA) or `--fg-muted` |
| 12px | Compact helper copy and inline code where 13px overpowers controls | `--fg`, `--fg-muted`, `--fg-subtle` |

- **10px roles:** DiffView header strip, SeverityBar legend, FileTree folder marker (`▸`), mockup structural metadata, gutter line numbers.
- **11px roles:** Badges, field labels, table headers, metadata rows (`InlineMeta`, `MetadataField`, `ChangeList` title), SummaryCard labels, finding captions and rule IDs, mono detail lines, StatusStrip labels, VersionPicker prefixes, Menu group headers, sponsor links, OrgSwitcher annotations, and page-local copies of these.

1. Text below 11px is never a label the user reads.
2. `--fg-subtle` is AA at all sizes (6.2:1 on `--bg`); never pair sub-11px text with anything lower contrast.
3. White on `--accent` (Button primary) needs 13px / 500 minimum (`--accent` is 4.97:1). Smaller controls (view-switcher pills) use `bg-accent-soft` + `text-accent` + accent border, never white-on-accent below 13px. Danger buttons use `--danger-on` (white in light, dark ink in dark mode, where white on `#f87171` is 2.8:1).
4. Severity as text uses `-text` variants (`text-warn-text`, `text-ok-text`); saturated tokens are for shapes (chart segments, borders, alert discs).
5. Machine-checked in `src/`: `design-local/no-off-system-color` and `design-local/no-sub-floor-text`. `text-xs` is 10.5px on the 14px root, so use `text-[12px]` or `text-[11px]`. Whether a 10px string is a glyph or a label stays a review call.

## Color

Restrained: one brand accent for action; severity does the rest. Light and dark are both first-class and auto-follow `prefers-color-scheme`.

### Light mode (default surface)

| Token | Hex | Contrast on `--bg` | Usage |
| --- | --- | --- | --- |
| `--bg` | `#fafafa` | — | Page background (neutral off-white) |
| `--bg-elev` | `#ffffff` | — | Cards, inputs |
| `--bg-elev-2` | `#f4f4f5` | — | Secondary surfaces, button-secondary |
| `--border` | `#e4e4e7` | — | Default borders |
| `--border-strong` | `#d4d4d8` | — | Hover borders, dividers |
| `--fg` | `#18181b` | 16.5:1 (AAA) | Primary text |
| `--fg-muted` | `#52525b` | 7.4:1 (AAA) | Secondary text |
| `--fg-subtle` | `#5d5d65` | 6.2:1 (AA) | Tertiary text, mono labels |

### Dark mode

| Token | Hex | Usage |
| --- | --- | --- |
| `--bg` | `#0a0a0a` | Page background |
| `--bg-elev` | `#141414` | Cards |
| `--bg-elev-2` | `#1c1c1c` | Secondary surfaces |
| `--border` | `#27272a` | Default borders |
| `--border-strong` | `#3f3f46` | Hover borders |
| `--fg` | `#fafafa` | Primary text |
| `--fg-muted` | `#a1a1aa` | Secondary text |
| `--fg-subtle` | `#8b8b94` | Tertiary text, mono labels |

1. Dark `--fg-subtle` clears AA (≥5:1) on `--bg`, `--surface`, and `--surface-2`; never lower it toward `#71717a` (3.8:1 on cards).
2. Dark tokens sit on a plain `:root` inside `@media (prefers-color-scheme: dark)` in `src/style.css`, **never** in a nested `@theme`: Tailwind v4 hoists every `@theme` to one unconditional `:root` and strands everyone in dark mode.
3. Don't invert naively: surfaces darken (true neutrals, no warm tint); accent and severity lighten one tone and drop ~10% saturation; soft fills become low-opacity overlays of the same hue; borders stay visible, never pure black.

### Accent (brand action)

| Token | Light | Dark | Usage |
| --- | --- | --- | --- |
| `--accent` | `#c2410c` (orange-700) | `#fb923c` (orange-400) | Primary buttons, focus rings, active nav, brand mark, accent text |
| `--accent-hover` | `#9a3412` (orange-800) | `#fdba74` | Hover |
| `--accent-soft` | `#fff7ed` | `rgba(251, 146, 60, 0.12)` | Focus ring background, soft fills |
| `--accent-on` | `#ffffff` | `#18181b` | Text on accent |

1. Orange, not violet: peers (Socket, Snyk, Aikido) lean violet; orange keeps a "caution / pre-flight" connotation. It is not a severity color.
2. Orange-700, not orange-600: `#ea580c` gave 3.58:1 for white-on-accent and 3.5:1 for `text-accent`; orange-700 reaches 4.97:1 in both roles with one token.

### Severity (semantic)

Saturated tokens are for shapes (chart bars, badge fills, alert discs, borders); `*-text` tokens are for text. In dark mode the two are identical.

| Token | Light | Dark | Soft (light / dark) | Usage |
| --- | --- | --- | --- | --- |
| `--danger` | `#dc2626` | `#f87171` | `#fee2e2` / `rgba(239, 68, 68, 0.14)` | Critical/High shapes |
| `--danger-text` | `#b91c1c` (5.3:1 on soft) | `#f87171` | — | Critical/High text |
| `--warn` | `#d97706` | `#fbbf24` | `#fef3c7` / `rgba(251, 191, 36, 0.14)` | Medium shapes |
| `--warn-text` | `#b45309` (4.9:1 AA) | `#fbbf24` | — | Medium text (AA on white, `--warn-soft`) |
| `--info` | `#2563eb` | `#60a5fa` | `#dbeafe` / `rgba(96, 165, 250, 0.14)` | Low/Info shapes |
| `--info-text` | `#1d4ed8` (5.5:1 on soft) | `#60a5fa` | — | Low/Info text |
| `--ok` | `#16a34a` | `#4ade80` | `#dcfce7` / `rgba(74, 222, 128, 0.14)` | Passed shapes |
| `--ok-text` | `#15803d` (4.5:1 AA) | `#4ade80` | — | Passed text (AA on white, `--ok-soft`) |

1. Color = signal: severity colors only mean severity; never red as decoration, never the accent to flag a finding.
2. Tailwind: `text-warn-text` not `text-warn`; `bg-warn-soft` not `bg-warn-soft-text`. Saturated amber and green fail AA as text on white (3.8:1, 3.0:1).

## Spacing and layout

| Item | Rule |
| --- | --- |
| Base unit | 4px. Scale `2xs(2) xs(4) sm(8) md(12) lg(16) xl(24) 2xl(32) 3xl(48) 4xl(64) 5xl(96)`. |
| Density | Comfortable for forms and report sections; dense for diff rows and finding lists. |
| Grid | 12 columns, 24px gutters; app max `1160px` shared by public pages; docs article ~`880px`; hero copy `760px`. |
| Radius `0` | Severity badges, document-style elements (not pills). |
| Radius `3–4px` | Small chrome: inline mono pills, file-path tags. |
| Radius `6px` | Buttons, inputs. |
| Radius `8px` | Cards, alerts, larger surfaces. |
| Radius `10px` | Mockup/window shells. |
| Radius `999px` | True circles only (avatars, toggle handles); never badges. |

### Page structure (`PageShell`)

1. Every page is a min-height flex column: header → `main` (grows) → site footer pinned to the bottom at the page's content width.
2. Footer identity block: brand mark; mono `11px / --fg-subtle` lines `Pre-publish review for npm, PyPI, and VS Code` / `© Drydock`; the Aikido sponsor line (outside the nav: it is not navigation).
3. Footer links: four `MonoLabel`-headed columns, each a `<ul aria-labelledby>` in one `Footer` nav: `Product` (`Package diff`, `Docs`), `Trust` (`Security model`, `Benchmarks`, `Privacy`), `Project` (`Open source`, GitHub repository), `Contact` (`Feedback`, `Report security`).
4. The footer is the only trust/legal surface and appears on every route, marketing and app.
5. GitHub uses the official high-contrast Invertocat mark beside a visible `GitHub` label (marks are `alt=""`, so the accessible name is the text).
6. The footer's `Package diff` is the only entry to `/diff` from app routes.
7. `width="narrow"` pages (auth, 404, invite) are single short cards, vertically centered with `my-auto` (never clips tall content).

## Marketing surfaces

Same primitives as the app. It relaxes only here:

| Relaxes | Rule |
| --- | --- |
| Hero headline | Display 1 (`44–56px / 600 / -0.03em / 1.05`), max `760px`. |
| Hero subhead | `17px / leading 1.6 / --fg-muted`, max `620px`; the only body type above 14px. |
| Section gap | `40–64px` (app: `24–32px`). |
| Hero context | No tracked uppercase label above the title; use title, lead, breadcrumb, or `MonoDetail`. |

It stays disciplined everywhere else:

1. No gradients; the brand mark is the only saturated orange above the fold.
2. No icon-in-circle feature grids. Feature rows: `Card padding="compact"`, `gap-2`, `h2: 16px / 500 / -0.005em`, body `13px / --fg-muted / 1.55`.
3. No stock photo or illustrated hero: type + brand mark + Cards.
4. No extra brand colors; the accent stays orange.

### Landing blocks

- **Status strip** (canonical headline-supporting unit, also on the dashboard): three Cards in a row, each with a mono `11px / 0.1em uppercase` label (`credentials`, `retention`, `approval`), a trailing `Badge` (`ok`, `info`, `neutral`), one sentence `13px / --fg-muted / 1.55`, and `min-height: 112px`.
- **Dependency-PR block:** below "Open a live diff", compact `DependencyPrIntegrations` in one split Card: 24px heading, setup copy, secondary `Add to Renovate` / `Add the PR comment` links; a `--surface-2` PR excerpt naming the demo package above a two-column Change / Drydock table; `Read the diff` opens the public demo pair; a closing note says what the PR comment adds beyond Renovate's table. Stacks below `lg`; text on the ink scale. `/diff` keeps the full integration cards.
- **Project logos:** after the hero, `Sponsored by` Aikido then `Used by` (Keyv, Cacheable, Preact, Apollo, PostCSS), each a `SectionLabel` over centered marks; locally bundled, linked, monochrome (inverted in dark).
  - Preact's wordmark is from the [official site](https://preactjs.com/); orbit and nucleus are transparent cutouts.
  - Apollo's PNG is uncropped and undistorted; its approval covers monochrome and the `Used by` listing only, with no sponsorship, partnership, or testimonial attribution.
  - PostCSS approved its listing; its unmodified logo is from the [official brand repository](https://github.com/postcss/brand/blob/master/dist/postcss-logo-horizontal-black.svg), with CC BY 4.0 attribution and license in `src/assets/postcss-LICENSE.txt`.
- **Review preview** ("What a review looks like"): a hand-authored condensed report after the logos; the first product demonstration.
  - Changed-file tree rows are real `<button>`s (`aria-current` on the selection) that swap the diff and its pinned finding, mirroring the workbench; nothing is invented for marketing.
  - Findings use DiffView's annotation (soft fill ~60%, saturated `border-l-2`); tree Badges carry counts; one selectable file has **no** finding.
  - One `13px / --fg-muted` hint ("Select a file…") is the only affordance copy; no tooltips or pulsing highlights.
- **Incident log** ("Why review a publish"): real named incidents (event-stream, ua-parser-js, node-ipc, chalk & debug) in `Card padding="none"` with `border-b` rows: mono `13px` name + `MonoDetail` (`year · vector`) left, one `13px / --fg-muted` sentence right (`220px / 1fr`, stacks on mobile). Ink scale only, **no severity colors**; closes with one `13px / --fg` takeaway. Never invent or embellish an incident.
- **Closing CTA** (`Get started`): `SectionLabel`, `32px / 600 / -0.02em` heading (the only Display 2 outside the hero), one `14px / --fg-muted` sentence, `Create account` / `Read the docs` pair, `MonoDetail` trust line (`read-only tokens · you keep the final approval`). No banner, fill, or extra `border-t`. The hero trio is `Read a diff` (primary, no-account front door), `Create account` (secondary), `Sign in` (ghost): prove value before asking for signup.

### Short public content pages

`/npm-staged-publishing`, `/security`, `/incidents/*`, `/benchmarks/shai-hulud-nx` and siblings are one document type, rendered by `src/features/public-content/ContentArticle.tsx`. Never re-declare the hero scale in a page directory.

| Part | Rule |
| --- | --- |
| `ContentArticleHero` | Display 1, `17px` lead, optional `MonoDetail`, primary/secondary `LinkButton`; ends `pb-2`, not `py-12`. |
| `ContentArticleSections` | Each `SectionLabel` carries a zero-padded index in its trailing slot. |
| `ContentArticleEvidence` | `Card padding="none"` of mono label/value rows; ink scale, **no** `Badge`; no `border-t` on row one. |
| `ContentArticleCta` | Every page ends on a next step (landing `Get started` shape). |
| `ContentArticleLinks` | Peer grid with `→` and accent hover border; not the numbered docs `JourneyCard`. |

### Sponsor recommendation on package diffs

1. Successful published npm and PyPI diffs end with a compact `InstallProtection` card after the review evidence and Drydock's release CTA: Aikido identity, Safe Chain's install-time checks, secondary `Set up Safe Chain →`.
2. It appears regardless of findings or risk and never implies compromise or changes the verdict.
3. npm preview builds, atpm results, the landing, and empty diff pages keep the generic sponsor strip.
4. The destination is constant per placement and opens with `noopener` only, so the site `Referrer-Policy` sends Aikido our origin, never the path. Aikido links carry static `utm_source=drydock`, `utm_medium=referral`, and `utm_content=<placement>` (`footer`, `landing`, `diff`, `diff-install-protection`) and never package, version, scan, or share-token context; install commands stay in Aikido's docs.
5. No browser tracking; outbound clicks and conversion stay outside Drydock's product analytics.

### Canonical widths

| Surface | Max width |
| --- | --- |
| Hero headline | `760px` |
| Hero subhead | `620px` |
| Marketing content column | `880px` |
| App content | `1160px` |
| Report body (document-shaped) | `880px` |
| Prose measure (running copy) | `680px` |

Do not add widths. `test/canonical-content-widths.test.ts` enforces the set on public reading surfaces; SeverityBar is exempt because it sizes itself.

## Documentation surfaces

Learning path first, configuration reference second.

1. **Order:** artifact gap → three-step review loop → report anatomy → safety model → release-path choice → setup. Never lead with credentials or workflow YAML.
2. **Wayfinding:** sticky `200px` desktop rail and native mobile `<details>` jump list; a hero three-card path links into the same page, never parallel navigation.
3. **Concept flow:** `Hold → Review → Decide` in one document-shaped Card with internal dividers, then label/question/evidence rows in the same shell; no Card per step.
4. **Report anatomy:** one compact Card of label/value/evidence rows; severity tones only for the example's real risk.
5. **Setup comparison:** three equal Cards with the same fields (`Best for`, `Held by`, `Decision`).
6. **Long code:** blocks over 14 lines fold. The toolbar (name + copy) is the `<details>` summary with `▸`/`▾`; collapsed shows a six-line peek and a full-width `⋯ N more lines · show more` expander (`bg-surface-2`, mono 11px). ≤14 lines never fold. At most one example open by default; the longest stays collapsed.
7. **Callouts:** `2px` accent left rule on `--accent-soft`, only for a key question, decision rule, trust boundary, or fail-closed note.
8. **Copy:** define terms on first use; prose under `680px`; steps numbered, one action each.
9. **Two edges:** rail `200px` + `40px` gap leaves an ~`880px` article column that every container spans (section rules, card grids, document Cards, step lists, requirement rows, callouts, code). All running copy, including inside callouts and steps, stops at `680px`. The hero rides the article track (`lg:col-start-2`) so the `h1` starts where every `h2` does; only its rule is full-bleed. A block is either a filled container or running text.

## Publisher workflow setup

Settings → GitHub App shows `Prepare a release workflow` before the manual release-target form. Behavior contract: [publisher-setup.md](./publisher-setup.md).

1. Three numbered steps on a rail (mono `01`–`03`, `✓` in `--ok-text` when done): **Choose the release** (repository, ecosystem, environment; installation select only when more than one is linked; choosing a repository inspects it), **Update the publishing workflow** (optional), **Protect the environment and verify**.
2. A step's controls render only once reachable; an error renders inside the step whose operation failed.
3. `Prepare draft pull request` authorizes generation, validation, independent review, and automatic draft PR creation; no extra in-product checkbox blocks it. While it runs, step 1 and the workflow select are locked; `Cancel preparation` stops the server job.
4. Completed state leads with the GitHub review link and remaining environment steps. Changes sit under a native `View workflow changes` disclosure, each file with its own copy action: new files as additions, modified files with real before/after, contents as source text.
5. Only the current step's action is primary: `Prepare draft pull request` turns secondary once a PR exists; `Check setup status` leads then or when there is nothing to draft; the manual form uses a secondary submit.
6. Progress names queueing, source reads, drafting, validation, second review, PR creation. The second review is labelled advisory, separate from the maintainer's GitHub review; a rejected attempt shows no PR link; a blocked attempt shows missing-evidence feedback as escaped text under `Agent feedback`.
7. Polling is bounded and pauses with a resume action on prolonged or repeated failures. A pending job resumes after refresh from its ID and authorized request scope in organization-keyed session storage; workflow source, generated content, and proposal tokens are never persisted in the browser.
8. Selection changes, hiding a job, and disposal stop local polling; the server job continues.
9. `Check setup status` reports release-target mapping, GitHub protection, administrator bypass, and first observed pre-publish review separately. A completed published-package review does not complete them; creating a PR never renders a protected-release success state.
10. Missing permissions, AI availability, or an unsupported workflow are actionable errors. Changing organization, repository, workflow, environment, or ecosystem clears the stale job result.

## Iconography

Typography-first: type, severity color, and a small set of Unicode glyphs. **No SVG icons.**

| Glyph | Role | Used in |
| --- | --- | --- |
| `▸` | Collapsed folder | FileTree |
| `▾` | Expanded folder | FileTree |
| `→` | Relation / flow | `previous → staged` captions, VersionPicker |
| `←` | Back link | Page header back-links |
| `·` | Metadata separator | Mono detail line |
| `✓` | Passed / connected | Inline status |
| `✕` | Failed / disconnected | Inline status |
| `•` | Badge dot | `Badge dot` prop |
| `⋯` | More actions / overflow | Row menus, DiffView "show more" |

1. Glyphs render in the surrounding font; color `--fg-subtle` unless they carry severity (then `currentColor`).
2. Never larger than `1em`; never a "display icon"; never decorative.
3. Status indicator: a `6px` round span with `background: currentColor` inside an element with the severity text color (the `Badge dot`); the only status-indicator shape.
4. Alert disc: a `16px` filled circle in the alert's color; the only exception to "no shapes". No other filled shapes (squares, triangles, rings).

## Data visualization

One chart pattern, applied consistently; no charting library.

### Severity bar

The only chart in v1 (`src/components/SeverityBar.tsx`).

| Part | Rule |
| --- | --- |
| Bar | One element, `8px` tall, `4px` radius, `overflow: hidden`, `--bg-elev-2`; max `480px` centered, else `100%`. |
| Order | `critical → high → medium → low → info → ok`, solid tokens. |
| Tiers | `high` = `--danger` at `opacity: 0.78`; `info` = `--info` at `opacity: 0.5`. |
| Widths | Percentage of findings; zero buckets are `width: 0`. |
| Labels | `findings by severity` mono label left; `N total` mono `11px / --fg-subtle` right. |
| Legend | Mono `10px / 0.1em uppercase / --fg-subtle`; per non-zero bucket an `8px×8px` square + `severity · count`. |

No axis, grid, or tooltip.

### Count tiles

The dashboard `OverviewStrip` tiles (`src/features/overview/tiles.ts`).

| Part | Rule |
| --- | --- |
| Wrapper | `--surface`, `1px --border`, `8px` radius, `12px 14px` padding, `4px` vertical gap. |
| Label | Mono `11px / 0.1em uppercase / --fg-subtle`. |
| Value | `14px / --fg` (sentences), mono `13px / --fg` (identifiers), `18px / 500 / -0.01em` (metrics). |
| Tone | `danger`, `warn`, `ok` tint **only the value**, never label or border. |

### Chart limits

1. Forbidden: pie, donut, line, area, scatter, radar, sankey.
2. Activity over time may only be a sparkline: thin SVG path in `--accent` on `--bg-elev`, no axis or labels, inside a SummaryCard. Anything more needs a `docs/design.md` update first.
3. Charts use solid severity tokens; soft tokens are for DiffView rows, Badges, Alerts. Never mix; no decorative palettes.

## States

Pick by what the user can do next.

| State | Trigger | Pattern | Visual |
| --- | --- | --- | --- |
| Empty | No data; action elsewhere | `Muted` line in the parent Card; one sentence, no CTA | `text-[13px] / --fg-muted / 1.55` |
| Loading inline | Transient, by a control | `Muted` mono line | `text-[12px] / --fg-muted / mono`, trailing `…` |
| Loading full | Transient, card or page | `Muted` line, pulsing counter for progress | `text-[14px] / --fg-muted` |
| Async system | Resolves on its own | `Alert tone="info"` | "scan running, page will refresh"; never plain loading |
| Error, recoverable | Page still works | `Alert tone="warn"` | "couldn't load comparison version" |
| Error, blocking | Action can't complete | `Alert tone="critical"` | Failed scan, auth error; optional `mono 12px` + `code:` line |

1. No spinners anywhere. Long operations show a pulsing mono counter or one mono line updated in place. Skeleton bones are deprecated; use a `Muted` loading line.
2. State copy: one sentence, capitalized, ends with a period. Loading ends with `…` (not `...`). Empty describes the state; it never promises action ("we'll show…") or holds a CTA. Errors name what failed before what to do, debug detail on a second mono line.

### Product writing

1. Lead with the reader's task and a concrete benefit; name the package, file, command, or job.
2. One main point per sentence; cut filler, dramatic contrasts, and capability lists; keep technical detail that helps the reader act.
3. Buttons say what they do. Advisory actions are `Record approval` / `Record rejection`; only a Workflow Gate decision makes GitHub continue or block the protected job.
4. `approved` / `rejected` for recorded decisions; `blocked` only for an observed npm status or a protected GitHub job that cannot continue.
5. Page titles and search descriptions match visible copy. Findings point to evidence with file and line when available; a review never guarantees a safe release.
6. Keep mode names (`Workflow Gate — enforced`, `Stage Watchtower — advisory`) and useful technical terms; drop decorative punctuation and unexplained jargon. Marketing copy rules: `.agents/product-marketing.md`.

## Motion

| Item | Rule |
| --- | --- |
| Easing | Enter `ease-out`, exit `ease-in`, move `ease-in-out`. |
| Duration | Micro `100ms` (hover/focus), short `150ms` (default), medium `250ms` (entrance); avoid long. |
| Hover/focus | 150ms color and border transitions. |
| Findings appear | Opacity fade, no slide. |
| Scan progress | Indeterminate bar or pulsing mono counter. |
| Theme change | Instant, no transition. |

## Components

- **Badge:** 3px radius, uppercase Geist Mono 11px / 600, 0.08–0.1em tracking; severity = soft fill + saturated text. Pills (`999px`) are deprecated.
- **Button:** 6px radius, 8–12px vertical / 14–18px horizontal padding. Primary `--accent`; secondary `--bg-elev-2` + border; ghost text-only on hover; danger `--danger` only for destructive actions (e.g. Reject publish).
- **Input:** 6px radius, `--bg` background (lighter than its card, for affordance); focus = 3px `--accent-soft` halo + accent border; no inner shadow or glow.
- **Alert:** 6px radius, 1px colored border, soft fill, 16px filled disc (see Iconography); inline strong keeps body color.
- **SectionLabel:** mono uppercase label with a trailing rule. Callers choose `h2`, `h3`, or `p` so reports keep a navigable outline; the `aside` slot holds trailing metadata (e.g. a count). Disclosure summaries that label a section contain the heading as their single direct child. For a bare 11px label without the rule use `MonoLabel` (page-local copies drift).
- **SectionLabel divider rule:** the trailing rule **is** the divider. Never add `border-b` or `<hr>` on that edge (on the label or the summary/header containing it), and never a `border-t` on the label (it boxes the label between hairlines). This regressed repeatedly; `design-local/no-stacked-section-rule` enforces it. Separate with spacing.
- **Mono detail line:** one mono caption under a title (`scan_01HXY... · 2026-05-21 · 17 files`), the signature treatment. Generated metadata, plain text: no Badges and no fact the section below already states.
- **Primary vs supplementary:** most sections (Risk signals, Manifest changes, Reviewer notes) share the flat `SectionLabel` altitude. The verdict (scan-detail Recommendation) is the one primary section: a `Card` led by an `18px / 600` severity `-text` headline. Diff workbench cards share that elevated tier. One primary answer per report, never competing cards.
- **Review notes:** group findings by rule, severity, and source; each occurrence under a native disclosure with a file/line action into the diff; show the shared explanation once with sans titles and severity badges. Keep release-change counts apart from risk evidence and release memory beside the verdict evidence. Draw the severity bar only for two or more findings.
- **AI assessment:** label model output **AI assessment · advisory**, keep the package-text warning visible, fold the full narrative under its own disclosure. The structured AI assessment never clears deterministic findings; say so when findings exist. Declared source binding needs one unverified repository row, preserving additional evidence. Expanded text uses the `680px` measure.
- **Manifest dependency links (`PackageJsonDiffView`, `src/components/`):** each added or bumped dependency row ends with a right-aligned mono 11px underlined `view diff` text link (no glyph: `↗` is not allowed) opening in a new tab. Bumps between exact published versions link that pair; ranges never link (a semver bound is not proof of publication). Added dependencies use the package-only `/diff/<name>` route (latest published pair). PyPI scans suppress the links (their dependencies are not npm packages).
- **Component ownership:** a component owns its appearance; the caller owns placement (`class` = margin, `flex`/`grid`, width, position). Everything else is a prop, because `cn` is a plain joiner, not `tailwind-merge` (`<Card class="p-5">` once rendered at `p-6`). Enforced by `shadcn/no-restyle` ([tooling.md](./tooling.md#lint-rules)).
- **Ownership props:** `Card` takes `padding` (`default` 24px, `compact` 20px, `tight` 16px, `roomy` 24px rising to 32px at `md`, `none`), `emphasis="strong"`, `hover` (`accent` for a card to open, `strong` for one that only needs to look reachable) and `hoverWithin` for an ancestor `group`. `Input`/`Select` take `mono` for machine values (URL, token, digest). `Muted` takes `tone="danger"` for field errors. `Menu` takes `triggerVariant="icon"` for the square overflow trigger.

### DiffView

Split view inside an 8px-radius border shell (`src/components/DiffView.tsx`).

| Part | Rule |
| --- | --- |
| Header strip | `bg-surface-2`, mono `10px / 0.1em uppercase / ink-subtle`; before left, after right. |
| Body | Mono `12px / 1.55`; two `44px` gutters (right-aligned `ink-subtle` numbers, right divider), wider only for more digits; `20px` sign column. |
| Wrapping | Fixed table layout with explicit column widths; text wraps with `whitespace-pre-wrap` and `overflow-wrap: anywhere`, so an unbreakable token wraps inside the pane instead of clipping on a phone. |
| Rows | Added `--ok-soft`, removed `--danger-soft`, unchanged transparent; soft tokens only. |
| Scroll | Body max `560px`; shorter diffs size to content; header outside the scroll region. |
| Single-sided | Added-only, removed-only, unchanged-only: one labeled `<pre>` with header styling and matching soft fill. |
| Display options | `Reformat`, `Word differences`, `Ignore whitespace` are `aria-pressed` toggles; pressed is `--accent` border, `--accent-soft` fill, `--ink` text. |
| Binary / missing | Muted `text-[13px]` explainer, never a graphic; truncation and binary flags as neutral Badges. |

1. **Highlighting:** only bundled grammars (`EXT_TO_LANG` in `src/components/highlight.ts` is canonical: JS/TS incl. `.mjs/.cjs/.mts/.cts`, Python, JSON, TOML, YAML, Markdown, HTML, CSS/SCSS, shell, Dockerfile, Vue, Svelte); everything else plain mono. Keywords/constants/functions `--ink`, identifiers/params `--ink-muted`, punctuation/comments `--ink-subtle`, one muted teal for strings; palette is `--sh-*` in `src/style.css` (light/dark aware). Severity hues and the accent are never token colors. Lazy, best-effort, plain-text fallback.
2. **Scroll pane:** keyboard-reachable `role="region"` (`tabIndex=0`, labeled with the path) with an inset `--accent-soft` focus ring (an outer halo clips against `overflow-hidden`), `overscroll-behavior: contain`, `overflow-anchor: none` so gap expansion behaves the same in every browser. A newly opened file starts at its first change, unless the first pinned finding would then sit outside the pane; then the pane's own `scrollTop` (never the page) opens a few rows above it.
3. **Collapsed gaps:** full-width expander (`bg-surface-2`, mono 11px, left-aligned `⋯ N unchanged lines · show more`) revealing from both edges; a right-aligned `show all` (`border-l` divider) appears only while the gap hides ≤ 5,000 rows, so a bulk reveal never rebuilds a megabyte-scale render. Rows with changes or pinned findings never collapse.
4. **Overview strip:** a 6px `aria-hidden`, non-interactive rail overlaid inside the pane's right edge (row fills run edge to edge; the text cell and gap button carry the padding that keeps text clear) showing change/finding density; hidden when the pane has nothing to scroll. It maps scroll space, not file lines: a collapsed gap counts as its one expander row and markers reflow as gaps expand (wrapped lines and callouts count as one index). A `bg-ink/15` thumb tracks the viewport. Finding markers: saturated tokens with `ring-surface`; change markers: ok/danger at reduced opacity.
5. **Inline findings:** deterministic findings pin to the staged line they reference as a full-width row beneath it (the diff is the headline; no separate list). Callout: `border-l-2`, severity `Badge`, mono `11px / 0.1em uppercase` `ruleId · line N`, reason `13px / --ink`, optional mono evidence. Fill: soft token at ~60% opacity; bar: saturated token. Groups: critical/high → `danger`, medium → `warn`, low/info → `info`, ok → `ok`.
6. Findings with no line, or a line past a truncated sample, show in a banner between header and scroll region, so a clipped sample never hides a signal. The same callout body serves the binary / no-sample fallback and mirrors the landing preview.

### FileTree

Document-shaped `<details>` + `<ul>`, not a custom widget (`src/components/FileTree.tsx`).

| Part | Rule |
| --- | --- |
| Type | Geist Mono `13px`. |
| Indent | `8px` base + `20px` per depth as `padding-left`, so hover/selection reaches the left edge. |
| Folder marker | `▸` / `▾`, `10px / ink-subtle`; files get none. |
| Auto-expand | When `status ≠ unchanged` and `depth < 2`. |
| Name color | `added → text-ok`, `removed → text-danger`, `modified → text-warn`, `mixed → text-accent`, `unchanged → text-ink-muted`. |
| Selection | `bg-surface-2` row, `text-ink`, `aria-current="true"`, `4px` radius (shared with the landing preview). |
| Status for AT | Visually hidden `(status)` suffix; no trailing status Badge. |
| Truncation | `truncate` on the name only; Badges stay visible. |

Finding count: a severity-toned count `Badge` (text, **no SVG icon**) trails the name, toned by the highest severity; folders sum descendant counts and take the max severity (same bubble-up as `status`); `aria-label="N findings"`. The same finding set feeds inline annotations, this count, and the risk-signals index.

### VersionPicker

The canonical labeled-control-with-metadata row; reuse it for any control with a mono prefix and result caption.

| Part | Rule |
| --- | --- |
| Layout | `flex flex-wrap items-center gap-3`. |
| Prefix | Mono `11px / 0.1em uppercase / ink-subtle` ("Compare against"). |
| Control | Native `<select>`, never a custom combobox; border + 6px radius, mono `13px`, `min-w 200px`, `8px 12px`. |
| Focus | Standard 3px `--accent-soft` halo + accent border (matches `Input`). |
| Caption | Mono `11px / ink-muted`, `→ staged X.Y.Z`; in a from/to pair the `→` wraps with the "to" control. |
| Status | Loading line in the same row after the caption; a failure is one `Alert tone="warn"` under the row. |
| Dist-tags | In the option text (`1.0.0 [latest] (default)`), never a trailing chip. |
| Disabled | `opacity-60 cursor-not-allowed`, no fades. |

## Anti-patterns

| Never | Instead |
| --- | --- |
| Violet/purple accent (`#7c5cff` is retired) | Orange accent |
| Orange-600 `#ea580c` accent | Orange-700 `#c2410c` (600 fails AA in both roles) |
| `text-warn`, `text-ok` as text | `-text` variants |
| Sub-11px labels | 10px only for scanning glyphs and metadata |
| Gradient buttons or hero backgrounds | Flat fills |
| `9999px` radius on badges or buttons | Squarish badges, 6px buttons |
| Icon-in-circle feature grids, stock-photo heroes | Type + Cards |
| Decorative "AI" / "AI-powered" badges | Nothing |
| Decorative severity color | Color = signal |
| SVG icons | Text glyphs |
| Spinners, skeleton bones | Mono line, pulsing counter, `Muted` line |
| Pie, donut, line, area, scatter, radar, sankey | Severity bar; future sparkline |
| Custom comboboxes | Native `<select>` |
| CTA inside an empty-state message | Action elsewhere on the page |

## Change checklist

| If you change | Also |
| --- | --- |
| A token in `src/style.css` | The token tables; contrast numbers; `pnpm run lint`. |
| A content width | Canonical widths and `test/canonical-content-widths.test.ts`. |
| A design rule worth recording | A dated row in [design-decisions.md](./design-decisions.md). |
| A heading code cites | `Canonical widths`, `Severity bar`, `Count tiles`, `Iconography`: update the `docs/design.md` comments in `src/`, `server/`, `test/`. |
