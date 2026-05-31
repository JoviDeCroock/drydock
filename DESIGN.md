# Design System — staged-publish-review

Source of truth for visual decisions in this repo. Read this before changing fonts, colors, spacing, or aesthetics. Do not deviate without explicit approval.

## Product Context

- **What this is:** A second pair of eyes before `npm publish`. A staged npm tarball is scanned, deterministic rules flag risky content, AI reviews changed files, and a human approves or rejects the publish.
- **Who it's for:** Package authors, security-conscious maintainers, and reviewers at companies that publish packages to the public registry.
- **Space/industry:** Supply-chain security / developer tooling. Adjacent products: Socket, Snyk Advisor, Aikido, GitHub Advisory Database, vlt.sh.
- **Project type:** Web app first (the scan workbench), marketing landing layered on the same system later.

## Aesthetic Direction

- **Direction:** Restrained dev-tool — confident sans typography, a single sharp accent color, severity carries the chromatic weight. Sits between a SaaS dashboard and a security advisory document.
- **Decoration level:** Minimal. Type and a single mono detail line (scan ID · timestamp · file count) do the work. No gradients, no icon-in-circle motifs, no decorative chrome.
- **Mood:** Sober, fast, trustworthy. Looks like a tool an engineer would keep open during a publish — not a marketing splash.
- **Reference observation:** Peer security tools converge on violet gradients + dashboard grids. This system breaks from the pack by replacing violet with orange and by giving each scan its own focused report layout rather than a sprawling dashboard.

## Typography

- **Display & Body:** Geist (weights 400, 500, 600). Loaded from Google Fonts. Modern, neutral, developer-readable, no licensing concerns.
- **Mono:** Geist Mono (weights 400, 500, 600). Used for file paths, severity labels, scan IDs, timestamps, code, and section labels — mono is a first-class typeface here, not just a code fallback.
- **Loading:** `https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap`. Self-host if the marketing site needs it.
- **Feature settings:** `font-feature-settings: "ss01", "cv11"` for Geist (humanist alts), `"ss01", "tnum"` for Geist Mono (tabular numbers — essential for data rows).

### Scale

| Role             | Size             | Weight  | Letter-spacing | Line-height |
| ---------------- | ---------------- | ------- | -------------- | ----------- |
| Display 1 (hero) | 44–56px          | 600     | -0.03em        | 1.05        |
| Display 2        | 32px             | 600     | -0.02em        | 1.15        |
| Heading 1        | 24px             | 600     | -0.015em       | 1.25        |
| Heading 2        | 18px             | 500     | -0.01em        | 1.35        |
| Body             | 14px             | 400     | 0              | 1.55        |
| Body sm          | 13px             | 400     | 0              | 1.5         |
| Mono code        | 13px             | 400/500 | 0              | 1.5         |
| Mono label       | 11px (uppercase) | 500     | 0.1em          | 1.4         |

## Color

- **Approach:** Restrained. One brand accent for action, severity colors do the rest. Light and dark are both first-class — auto-follow `prefers-color-scheme` by default.

### Light mode (default surface)

| Token             | Hex       | Usage                                |
| ----------------- | --------- | ------------------------------------ |
| `--bg`            | `#fafaf9` | Page background (warm paper-ish)     |
| `--bg-elev`       | `#ffffff` | Cards, inputs                        |
| `--bg-elev-2`     | `#f4f4f5` | Secondary surfaces, button-secondary |
| `--border`        | `#e7e5e4` | Default borders                      |
| `--border-strong` | `#d6d3d1` | Hover borders, dividers              |
| `--fg`            | `#18181b` | Primary text                         |
| `--fg-muted`      | `#57534e` | Secondary text                       |
| `--fg-subtle`     | `#a8a29e` | Tertiary text, labels                |

### Dark mode

| Token             | Hex       | Usage              |
| ----------------- | --------- | ------------------ |
| `--bg`            | `#0a0a0a` | Page background    |
| `--bg-elev`       | `#141414` | Cards              |
| `--bg-elev-2`     | `#1c1c1c` | Secondary surfaces |
| `--border`        | `#27272a` | Default borders    |
| `--border-strong` | `#3f3f46` | Hover borders      |
| `--fg`            | `#fafafa` | Primary text       |
| `--fg-muted`      | `#a1a1aa` | Secondary text     |
| `--fg-subtle`     | `#71717a` | Tertiary text      |

### Accent (brand action)

| Token            | Light                  | Dark                       | Usage                                                |
| ---------------- | ---------------------- | -------------------------- | ---------------------------------------------------- |
| `--accent`       | `#ea580c` (orange-600) | `#fb923c` (orange-400)     | Primary buttons, focus rings, active nav, brand mark |
| `--accent-hover` | `#c2410c`              | `#fdba74`                  | Hover state                                          |
| `--accent-soft`  | `#fff7ed`              | `rgba(251, 146, 60, 0.12)` | Focus ring background, soft fills                    |
| `--accent-on`    | `#ffffff`              | `#18181b`                  | Text on accent background                            |

**Why orange, not purple:** Every peer security tool (Socket, Snyk, Aikido) leans on violet. Orange differentiates without sacrificing the "caution / pre-flight" connotation. It is _not_ a severity color — severity stays red/amber/blue/green.

### Severity (semantic)

| Token      | Light     | Dark      | Soft (light / dark)                    | Usage               |
| ---------- | --------- | --------- | -------------------------------------- | ------------------- |
| `--danger` | `#dc2626` | `#f87171` | `#fee2e2` / `rgba(239, 68, 68, 0.14)`  | Critical, High      |
| `--warn`   | `#d97706` | `#fbbf24` | `#fef3c7` / `rgba(251, 191, 36, 0.14)` | Medium              |
| `--info`   | `#2563eb` | `#60a5fa` | `#dbeafe` / `rgba(96, 165, 250, 0.14)` | Low, Info           |
| `--ok`     | `#16a34a` | `#4ade80` | `#dcfce7` / `rgba(74, 222, 128, 0.14)` | Passed, no findings |

**Rule:** Severity colors are reserved for severity meaning. Never use red for a decorative accent, never use the orange accent to flag a finding. Color = signal.

### Dark mode strategy

Don't naively invert. Surfaces darken (true neutrals, no warm tint), accent + severity colors lighten by one tone and drop saturation ~10%, soft fills become low-opacity overlays of the same hue. Borders remain visible — never collapse to pure black.

## Spacing

- **Base unit:** 4px.
- **Density:** Comfortable for forms and report sections; dense for diff rows and finding lists.
- **Scale:** `2xs(2) xs(4) sm(8) md(12) lg(16) xl(24) 2xl(32) 3xl(48) 4xl(64) 5xl(96)`.

## Layout

- **Approach:** Grid-disciplined for app surfaces. Marketing pages get more whitespace and a deliberate single-column hero column.
- **Grid:** 12-column, 24px gutters. App content max-width `1160px`. Report bodies sit comfortably inside `~880px`. Marketing hero copy capped at `760px` so headings remain typographically scaled.
- **Border radius:**
  - `0` — Severity badges and document-style elements (squarish, terminal-adjacent — not pills).
  - `3–4px` — Small chrome (inline mono pills, file-path tags).
  - `6px` — Buttons, inputs.
  - `8px` — Cards, alerts, larger surfaces.
  - `10px` — Mockup/window shells.
  - `999px` — Reserved for true circle elements (avatars, toggle handles). Avoid for badges.

## Marketing surfaces

The marketing landing page sits on the same primitives as the app. The system _relaxes_ in a few specific places and _stays disciplined_ everywhere else.

### Where it relaxes

- **Hero headline:** Display 1 scale (`44–56px / 600 / -0.03em / 1.05`). Max-width `760px`.
- **Hero subhead:** body `17px / leading 1.6`, color `--fg-muted`. Max-width `620px`. This is the only place body type goes above 14px.
- **Section gap:** marketing pages use `40–64px` between sections (vs. app surfaces' `24–32px`).
- **Eyebrow:** marketing pages may render the section label as `mono 10px / 0.1em uppercase / --accent` (the only place mono labels use the accent color directly).

### Where it stays disciplined

- No gradients (hero or otherwise). The brand mark is the only saturated orange element above the fold.
- No icon-in-colored-circle three-column feature grids. Marketing feature rows use the same `Card` primitive: `p-5`, `gap-2`, `h2: 16px / 500 / -0.005em`, body `13px / --fg-muted / 1.55`.
- No stock-photo or illustrated hero. The hero is type + brand mark + Cards.
- The accent stays orange. No additional brand colors are added for marketing.

### The status strip (canonical headline-supporting unit)

Three short Card panels in a row, each containing:

- A mono `10px / 0.1em uppercase` label (`credentials`, `retention`, `approval`).
- A trailing `Badge` (`ok`, `info`, `neutral`) communicating the claim's state.
- One sentence of body copy, `13px / --fg-muted / 1.55`.
- `min-height: 112px` so the three cards align even when copy lengths differ.

This pattern is used both on the dashboard (above the scan form) _and_ as the headline-supporting unit on marketing pages. Visitors landing on the dashboard feel oriented because the same primitive carries.

### Canonical widths

| Surface                       | Max width |
| ----------------------------- | --------- |
| Hero headline                 | `760px`   |
| Hero subhead                  | `620px`   |
| Marketing content column      | `880px`   |
| App content                   | `1160px`  |
| Report body (document-shaped) | `880px`   |

Do not introduce additional content widths.

## Iconography

The system is typography-first. It communicates through type, severity color, and a small allowed set of Unicode glyphs. **No SVG icons.**

### Allowed glyphs

| Glyph | Role                  | Used in                                     |
| ----- | --------------------- | ------------------------------------------- |
| `▸`   | Collapsed folder      | FileTree                                    |
| `▾`   | Expanded folder       | FileTree (when needed)                      |
| `→`   | Relation / flow       | `previous → staged` captions, VersionPicker |
| `←`   | Back link             | Page header back-links                      |
| `·`   | Metadata separator    | Mono detail line                            |
| `✓`   | Passed / connected    | Inline status                               |
| `✕`   | Failed / disconnected | Inline status                               |
| `•`   | Badge dot             | `Badge dot` prop                            |

### Glyph treatment

- Rendered in the surrounding font (Geist for body, Geist Mono for mono lines).
- Color is `--fg-subtle` unless the glyph carries severity meaning, in which case it inherits the severity text color via `currentColor`.
- Never larger than `1em` of the surrounding text. Glyphs never scale into a "display icon."
- Glyphs are never decorative. If a glyph would only be visual flourish, remove it.

### Status indicator

When a state needs a visual cue without a full Badge, use a `6px round span` with `background: currentColor` inside an element styled with the target severity text color. This is the `Badge dot` implementation — document it as the only allowed status-indicator shape.

### The Alert disc

Alerts include a `16px filled circle` in the alert's color. This is a _colored disc_, not an icon. It is the only exception to "no shapes." Do not introduce other filled shapes (squares, triangles, rings) anywhere in the system.

## Data visualization

The product surfaces severity counts, file counts, and version metadata. It does not need a charting library — it needs **one** chart pattern, applied consistently.

### Severity distribution (stacked bar)

The only chart in the v1 product.

- **Bar:** single horizontal element, `8px` tall, `4px` radius, `overflow: hidden`. Background `--bg-elev-2`. Max-width `480px` on a centered layout, `100%` of column otherwise.
- **Segments:** ordered left-to-right `critical → high → medium → low → info → ok`. Segments use the **solid** severity tokens (`--danger`, `--warn`, `--info`, `--ok`). The two danger-tier segments use `--danger` with `high` at `opacity: 0.78` so they're distinguishable. The two info-tier segments use `--info` with `info` at `opacity: 0.5`.
- **Widths:** percentage of total findings; zero buckets render `width: 0` (collapsed, not visible).
- **Total label:** mono `11px / --fg-subtle`, sits to the right of the bar (`findings by severity` mono-label on the left, `N total` on the right).
- **Legend:** mono `10px / 0.1em uppercase / --fg-subtle`, one entry per non-zero bucket, `8px×8px` square swatch + `severity · count`. No axis, no grid, no tooltip.

### Count tiles (already in code as `SummaryCard`)

- Wrapper: `--surface` background, `1px --border`, `8px` radius, `12px 14px` padding, vertical `4px` gap.
- Label: mono `10px / 0.1em uppercase / --fg-subtle`.
- Value: either `body 14px / --fg` (sentence-like values) or mono `13px / --fg` (identifiers) or `18px / 500 / -0.01em` (when the value is a number presented as a metric).
- Tone variants: `danger`, `warn`, `ok` tint **only the value**, never the label or border.

### Forbidden chart types (v1)

- Pie, donut, line chart, area chart, scatter, radar, sankey.
- If activity-over-time becomes necessary, the only allowed form is a sparkline: a thin SVG path in `--accent` against `--bg-elev`, no axis, no labels, embedded inside a SummaryCard. Anything beyond a sparkline requires an explicit DESIGN.md update first.

### Color rule

Charts use **solid** severity tokens. Soft severity tokens are reserved for row fills (DiffView), Badges, and Alerts. Never mix the two roles. Do not introduce decorative chart palettes.

## States

Five patterns, picked by _what the user can do next_.

| State                   | Trigger                            | Pattern                                                                                 | Visual                                                                          |
| ----------------------- | ---------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Empty**               | No data, action lives elsewhere    | `Muted` line inside the parent Card's padding. One sentence. No CTA inside the message. | `text-[13px] / --fg-muted / 1.55`                                               |
| **Loading inline**      | Transient, next to a control       | `Muted` line, mono                                                                      | `text-[12px] / --fg-muted / mono`, trailing `…` (em-dash + ellipsis, not `...`) |
| **Loading full**        | Transient, full card or full page  | `Muted` line, body type, pulsing counter for progress                                   | `text-[14px] / --fg-muted`                                                      |
| **Async system**        | Resolves on its own, FYI not error | `Alert tone="info"`                                                                     | Used for "scan running, page will refresh." Never for plain loading.            |
| **Error — recoverable** | Page still works                   | `Alert tone="warn"`                                                                     | Used for "couldn't load comparison version" where the rest of the page works.   |
| **Error — blocking**    | Action can't complete              | `Alert tone="critical"`                                                                 | Failed scan, auth error. Body may include `mono 12px` detail + a `code:` line.  |

### Copy rules for state messages

- One sentence per state. No paragraphs.
- Capitalize first letter; period at the end.
- Loading messages end with `…` (the Unicode ellipsis), not `...`.
- Empty messages describe the current state. They do not promise action ("we'll show…") and do not contain a CTA — actions live elsewhere on the page.
- Error messages name what failed before what to do; debugging detail is on the second line in mono, not inline in the sentence.

### Progress

No spinners anywhere in the system. Long-running operations show a pulsing mono counter or a single line of mono text that updates in place. Skeleton-bone placeholders are deprecated — show a `Muted` loading line instead.

## Motion

- **Approach:** Minimal-functional. Animation supports comprehension; it does not entertain.
- **Easing:** enter `ease-out`, exit `ease-in`, move `ease-in-out`.
- **Duration:** micro `100ms` (hover/focus), short `150ms` (default), medium `250ms` (entrance), long — avoid.
- **Patterns:**
  - Hover/focus → 150ms color & border transitions.
  - Findings appear → fade-in via opacity, no slide.
  - Scan progress → indeterminate bar or pulsing mono counter, not a spinner.
  - Theme toggle → instant. No transition on color-scheme change.

## Components — non-obvious rules

- **Badges:** Squarish (3px radius), uppercase Geist Mono 10-11px, weight 600, letter-spacing 0.08–0.1em. Severity variants use the soft fill + saturated text color combo. Pill badges (`border-radius: 999px`) are deprecated in this repo.
- **Buttons:** 6px radius, 8–12px vertical / 14–18px horizontal padding. Primary uses `--accent`; secondary uses `--bg-elev-2` with a border; ghost is text-only on hover; danger uses `--danger` (only for destructive actions like Reject publish).
- **Inputs:** 6px radius, `--bg` background (intentionally lighter than the card it sits on for affordance), focus ring is a 3px `--accent-soft` halo + accent border. No inner shadow, no glow.
- **Section labels:** A small mono uppercase label with a trailing rule. Replaces the SaaS-default H1/H2 stack with something more document-shaped.
- **Mono detail line:** Many surfaces have a one-line mono caption directly under the title (`scan_01HXY... · 2026-05-21 · 17 files`). This is the system's signature treatment — treat it like a generated metadata line, not a subtitle.
- **Alerts:** 6px radius, 1px colored border, soft background fill, the indicator is a 16px filled disc in the alert's color (a _colored disc_, not an icon — see Iconography). Inline strong-tag retains body color.

### DiffView

Split-view diff inside an 8px-radius border shell.

- **Header strip:** `bg-surface-2`, mono `10px / 0.1em uppercase / ink-subtle`. Before label left-aligned, after label right-aligned.
- **Body:** monospace `12px / 1.55`. Two gutters of `44px` each (line numbers, right-aligned, `ink-subtle`, right divider border). Sign column `20px`. Text column wraps with `whitespace-pre-wrap break-words`.
- **Row backgrounds:** added → `--ok-soft`. Removed → `--danger-soft`. Unchanged → transparent. Soft severity tokens only (never solid).
- **Syntax highlighting:** `.py`, `.js(x)`, `.ts(x)`, `.json`, `.toml` only; everything else stays plain mono. Deliberately restrained so it never competes with the severity row fills (color = signal): code structure rides the ink scale (keywords/constants/functions → `--ink`, identifiers/params → `--ink-muted`, punctuation/comments → `--ink-subtle`) and a single muted teal marks string literals. The palette lives in `src/style.css` as the `--sh-*` CSS variables (light/dark aware). Severity-reserved hues (red/amber/blue/green) and the orange accent are never used as token colors. Highlighting is best-effort decoration: it loads lazily and falls back to plain text.
- **Scroll:** body capped at `560px` max-height then scrolls. Header stays outside the scroll region.
- **Single-sided modes:** added-only / removed-only / unchanged-only collapse to a single labeled `<pre>` pane that reuses the header strip styling and the matching soft fill.
- **Binary / missing sample:** muted explainer line (`text-[13px]`), never a placeholder graphic. Truncation and binary flags surface as neutral Badges next to the path.

### FileTree

Document-shaped tree, rendered with `<details>` + `<ul>`, not a custom widget.

- **Type:** Geist Mono `13px`.
- **Indent:** `8px base + 20px per depth`. Indent is expressed as `padding-left` so the hover/selection background reaches the leftmost edge. Children should read as clearly nested under their parent folder.
- **Folder marker:** the text glyph `▸` (collapsed) or `▾` (expanded), `10px / ink-subtle`. Files do not get a marker.
- **Auto-expand:** folders open by default when `status ≠ unchanged` and `depth < 2`.
- **Name color follows aggregate status:** `added → text-ok`, `removed → text-danger`, `modified → text-warn`, `mixed → text-accent`, `unchanged → text-ink-muted`. Selected file overrides to `text-ink`.
- **Selected file:** `bg-surface-2` row with `text-ink`. Border-radius `4px` on the row so the selection sits inside the tree padding.
- **Trailing Badge:** present only when `status ≠ unchanged`. Folder badges use the aggregated status.
- **Truncation:** `truncate` on the name span only; the trailing Badge stays visible.

### VersionPicker

The canonical "labeled control with metadata" row pattern. Re-use this composition any time a control needs a mono label prefix and a mono result caption.

- **Layout:** `flex flex-wrap items-center gap-3`.
- **Prefix label:** mono `10px / 0.1em uppercase / ink-subtle` reading "Compare against" (or analogous noun phrase).
- **Control:** native `<select>` — never a custom combobox. `border + 6px radius`, font-mono `13px`, `min-w 200px`, padding `8px 12px`. Focus state is the standard 3px `--accent-soft` halo + accent border (matches `Input`).
- **Result caption:** mono `11px / ink-muted` reading `→ staged X.Y.Z`. The `→` is the canonical relation glyph.
- **Tag chips:** `Badge tone="info"` for dist-tags. Multiple tags wrap on the same line.
- **Disabled:** `opacity-60 cursor-not-allowed`, no fade transitions.

## Anti-patterns — do not introduce

- Violet/purple as the primary accent. The previous `--accent: #7c5cff` is retired.
- Gradient buttons or gradient hero backgrounds.
- Bubbly border-radius (`9999px`) on badges or buttons.
- Icon-in-colored-circle three-column feature grids.
- "AI" / "AI-powered" badges as decorative flourish.
- Stock-photo hero treatments.
- Decorative use of severity colors (red as accent, etc.). Color = signal here.
- **SVG icons.** The system uses text glyphs (see Iconography). If you reach for an icon library, stop and find the typographic solution instead.
- **Spinners.** Loading is a mono line, optionally with a pulsing counter. No rotating glyphs.
- **Skeleton bones.** A `Muted` loading line replaces the placeholder content shape.
- **Chart variants.** Pie, donut, line, area, scatter, radar, sankey. The only chart in v1 is the severity stacked bar (and a future sparkline if needed).
- **Custom comboboxes.** Native `<select>` is the canonical control for picking from a list (see VersionPicker).
- **CTAs inside empty-state messages.** The action lives elsewhere on the page; the empty message only describes state.

## Decisions Log

| Date       | Decision                                                                                          | Rationale                                                                                                                                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-21 | Initial design system created via `/design-consultation`.                                         | Replaces ad-hoc `src/style.css` palette. Moves brand off the SaaS-default violet, makes Geist + Geist Mono official, and locks severity semantics so they cannot drift.                                                                                                                                                 |
| 2026-05-21 | Accent: orange `#ea580c` over violet.                                                             | Differentiates from Socket/Snyk/Aikido violet convergence; preserves "caution / pre-flight" semantics; non-overlapping with severity colors.                                                                                                                                                                            |
| 2026-05-21 | Light is the default surface; dark is first-class via `prefers-color-scheme`.                     | Auto-mode chosen by user. Both modes must be designed, not derived.                                                                                                                                                                                                                                                     |
| 2026-05-21 | Squarish badges (3px), not pills.                                                                 | Echoes terminal/document feel. Pill badges read as SaaS-generic.                                                                                                                                                                                                                                                        |
| 2026-05-21 | Specced DiffView, FileTree, VersionPicker.                                                        | New components shipped without DESIGN.md coverage; locked in mono-label conventions, severity-soft row fills, native `<select>` for version picking, and document-shaped tree styling so future contributors don't drift.                                                                                               |
| 2026-05-21 | Marketing surfaces extend the system; status strip is the canonical headline unit.                | Same primitives as the app, with hero-only relaxations (17px subhead, wider section gaps, accent-tinted eyebrow). Status strip carries from dashboard to marketing so visitors stay oriented.                                                                                                                           |
| 2026-05-21 | Zero SVG icons; text glyphs only.                                                                 | Risk taken deliberately: type and severity color carry identity. Allowed-glyph list closes the gap so contributors have a clear alternative to reaching for an icon library. The Alert disc is the only exception.                                                                                                      |
| 2026-05-21 | One chart pattern (severity stacked bar) for v1; sparkline reserved for future.                   | Avoids dashboard fatigue and keeps the product document-shaped. Solid severity tokens belong to charts; soft tokens stay for rows/Badges/Alerts — color = signal, never mixed roles.                                                                                                                                    |
| 2026-05-21 | State patterns codified (empty / loading inline / loading full / async / recoverable / blocking). | Per-page improvisation removed: mono sizes, copy rules, and trigger conditions now explicit. No spinners, no skeleton bones — `Muted` lines and pulsing counters only.                                                                                                                                                  |
| 2026-05-30 | DiffView syntax highlighting via a restrained `--sh-*` palette.                                   | Wanted readable code diffs without breaking "color = signal." Structure rides the ink scale; one muted teal marks strings; severity hues and the orange accent are off-limits as token colors so the green/red row fills stay the only saturated signal. shiki tokenizes client-side, lazy-loaded, plain-text fallback. |
