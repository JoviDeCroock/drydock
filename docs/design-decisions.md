# Design decisions

Dated log of design-system decisions. **Authority:** internal. **Owner:** [design.md](./design.md), which holds every current rule; this file records only why rules changed.

Rows are append-only history. Add one when a design rule changes.

| Date | Decision | Why |
| --- | --- | --- |
| 2026-05-21 | Initial system via `/design-consultation`. | Replaced the ad-hoc `src/style.css` palette; Geist + Geist Mono official; severity semantics locked. |
| 2026-05-21 | Accent orange `#ea580c` over violet. | Differs from Socket/Snyk/Aikido violet; "caution / pre-flight"; no overlap with severity. Superseded by orange-700 (2026-06-03). |
| 2026-05-21 | Light default; dark first-class via `prefers-color-scheme`. | Owner chose auto mode; both modes designed, not derived. |
| 2026-05-21 | Squarish 3px badges, not pills. | Terminal/document feel; pills read as generic dashboard chrome. |
| 2026-05-21 | Specced DiffView, FileTree, VersionPicker. | Shipped without spec; locked mono labels, soft row fills, native `<select>`, document-shaped tree. |
| 2026-05-21 | Marketing extends the system; status strip is the headline unit. | Same primitives with hero-only relaxations; one unit from dashboard to marketing keeps visitors oriented. |
| 2026-05-21 | Zero SVG icons; text glyphs only. | Type and severity color carry identity; the glyph list gives an alternative; Alert disc is the one exception. |
| 2026-05-21 | One chart (severity stacked bar); sparkline reserved. | Avoids dashboard fatigue; solid tokens for charts, soft for rows/Badges/Alerts. |
| 2026-05-21 | State patterns codified. | Removed per-page improvisation; no spinners or skeleton bones. |
| 2026-05-30 | DiffView highlighting via a restrained `--sh-*` palette. | Readable code without breaking "color = signal"; shiki client-side, lazy, plain-text fallback. |
| 2026-06-03 | Contrast pass: darker `--fg-subtle`, orange-700 accent, `*-text` severity, small-text floor. | `--fg-subtle` `#a8a29e` was 2.4:1 (then `#6b6660`, 5.9:1); accent roles were 3.5–3.6:1; light `text-warn`/`text-ok` failed AA. |
| 2026-06-05 | Findings pinned inline on hunks; Recommendation the one primary section; landing npm + PyPI parity. | Findings lived in a separate grid and sections shared one altitude. Also: `lg:`-only fixed panels, Status as Badge, mono freshness text. |
| 2026-06-10 | Problem-first landing and docs copy; "Why review a publish"; "How it works"; closing CTA; docs mode chooser. | Pages led with mechanism. Fixed `last:pb-0` zeroing inter-step padding. |
| 2026-06-10 | Light mode un-stranded; dark `--fg-subtle` to AA; site footer; narrow pages centered. | A nested dark `@theme` was hoisted to `:root` for everyone. Dark `#71717a` (3.8:1) → `#8b8b94`. Mockup tree column `200px → 220px`. |
| 2026-07-07 | Docs "On this page": desktop scrollspy rail, mobile `<details>` list, stable anchors. | Gate onboarding was buried; rail fits `200px` + 40px gap inside 1160px, no new widths. |
| 2026-07-14 | Docs become a concept-first learning guide. | Setup-first copy forced an integration choice before understanding; YAML moved into disclosures. |
| 2026-07-19 | Added/bumped dependencies link to their own `/diff`; public diff gains Manifest changes. | `dependency.added` / `dependency.major-bump` findings had no path to the dependency's releases. |
| 2026-07-22 | Overview strip maps scroll space; capped `show all`; keyboard scroll region. | Markers mapped file lines while the scrollbar maps rows; bulk reveal could freeze; the pane was mouse-only. |
| 2026-07-22 | Component-gap pass: keyboard/AT fixes, primitives pinned. | Focus ring, Menu focus return, persistent critical Toasts, Dialog scroll lock, skip link, real `SectionLabel` headings, div-based SeverityBar. |
| 2026-07-22 | `Package diff` in the marketing header and footer. | `/diff` had no navigation entry; same label on both; no active state (never used in that header). |
| 2026-08-08 | `/diff` is the front door: hero leads with `Read a diff`; live incident diffs; report conversion close. | Signup came before value. `Before it shipped` sits after `Verify this report` so proof outranks pitch. |
| 2026-08-11 | Docs `Diffs in dependency PRs` section. | Consumer setup ([dependency-pr-diff-links.md](./dependency-pr-diff-links.md)) had no user-facing instructions. |
| 2026-08-11 | Share dialog offers README badge markdown once feed-listed. | Only when the badge resolves (feed-listed + known ecosystem), never markdown rendering `not reviewed`. |
| 2026-08-21 | Dependabot example covers grouped PRs with one upserted comment. | Grouped PRs (Dependabot's default) never fired the old snippet; lines held to 71 characters. |
| 2026-08-23 | Positioning names Drydock Package Review and pre-publish package security. | The bare name collides with deployment and container tools. |
| 2026-08-23 | Landing and `/diff` share one Renovate/Dependabot integration block. | Integrations were buried in Docs; plain links only, no new anonymous traffic path. |
| 2026-08-23 | Focused public guides per release path, diff utility, security model. | One URL could not serve several intents; seven prerendered pages link back to the learning guide. |
| 2026-08-23 | Incident cards lead to prerendered analyses with scope notes. | A live diff proves changed bytes, not history; evidence and context stay separate. |
| 2026-08-23 | Guides and incidents share `ContentArticle`. | Duplicated hero scale in two directories; shell moved to `src/features/public-content/`. |
| 2026-08-28 | Footer regrouped into identity block + four labelled columns. | Eight flat links and a bare glyph read as one run; sponsor line was mistaken for a link. |
| 2026-08-28 | Title eyebrows removed; 11px floor restored; neutral zinc light palette. | Titles carry their own context; warm stone replaced by neutral zinc. |
| 2026-08-28 | Code blocks over 14 lines fold to a six-line peek. | YAML dominated the docs; reuses the DiffView gap-row expander. |
| 2026-08-29 | Docs reduced to two edges; copy stops at `680px`. | Five competing widths and ~130-character step lines; `560px` CTA removed; guard test added. |
| 2026-09-02 | Every review surface leads with the diff. | The workbench sat sixth on scan detail; tree/diff shared as `src/features/review/ReviewWorkbench.tsx`. |
| 2026-09-08 | Reviewer section aside `advisory · may quote package text`. | Model prose is shaped by hostile package input and must not read as a verdict. |
| 2026-09-22 | Hero names the reader's gap; Workflow Gate leads and drops `Preview`; CTAs ask for the release. | `Review my next release` closes; copy rules moved to `.agents/product-marketing.md`. |
| 2026-10-08 | One signed-in header; ownership choice demoted; findings stated once; nav labels unified. | Four headers, a primary ownership button outranking the verdict, findings stated three times, seven labels for `/diff`. |
| 2026-10-09 | `Feedback` after navigation, before account controls, everywhere. | A mailto is neither navigation nor account; tab order matches drawn order. |
| 2026-10-18 | Docs `Pull request comment` imports the repo workflow file. | Serves Dependabot and Renovate; 100-column width plus code-block fold. |
| 2026-10-24 | That snippet becomes a ~20-line caller of the reusable workflow, shown open. | The 750-line snippet was a chore; the caller fits 71 columns except its pinned `uses:` line. |
