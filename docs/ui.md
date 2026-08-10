# UI styling and primitives

`docs/design.md` is the source of truth for Drydock UI decisions: fonts, colors, spacing, iconography, chart rules, interaction density, dark/light behavior, and marketing-surface constraints. Read it before visual work.

This file is only a compact implementation map.

## Stack

- Preact + `preact-iso` routes under `src/pages/`.
- Cross-surface feature code lives in `src/features/`; see "Shared review surface" below.
- Tailwind CSS v4 via `@tailwindcss/vite`.
- Tokens live in `src/style.css` under `@theme`; dark mode follows `prefers-color-scheme`.
- State uses `@preact/signals`; `useState`/`useReducer` are banned by oxlint.
- Links to Worker routes (`/public/*`, `/api/*`) need `target="_blank"` (plus
  `rel="noreferrer"`) or `download`. `preact-iso` intercepts same-origin anchor
  clicks, and those paths have no `<Route>`, so a plain anchor renders the SPA
  404 instead of reaching the server. `test/server-route-links.test.ts` guards
  the literal-href case.

## Primitives

Prefer existing primitives in `src/components/` before adding one-off classes:

- layout/content: `PageShell`, `Card`, `SectionLabel`, `Eyebrow`, `Toolbar`;
- controls: `Button`, `LinkButton`, `Input`, `Field`, `Select`, `Tabs`;
- feedback/status: `Badge`, `Alert`, `Progress`, `EmptyState`, `Skeleton`;
- data/review: table, diff, finding, and risk-summary components colocated with their surfaces.

## Shared review surface

Two surfaces render the same review: the authenticated scan workbench
(`src/pages/Dashboard/ScanDetail/`) and the anonymous public diff
(`src/pages/Diff/`). What both use lives in `src/features/review/`:

- `types.ts` — `ReviewFinding` (only the fields the review UI renders) and
  `FindingWithDiffStatus`. Deliberately narrower than a persisted scan finding
  so the public diff, which persists nothing, does not have to invent
  `scanId`/`ruleVersion` values to satisfy a shared component.
- `diff-entries.ts` — `filterDiffEntries` and `findingCountsByPath`.
- `RiskSignalsSection.tsx` — the changed-file/package-context findings split.

Surface-specific code stays with its page. `ScanDetail/diff-helpers.ts` keeps
what is tied to the persisted scan model (`scanFilesToFileRecords`,
`annotatePersistedFindings`, the `DiffWorkbench` state machine). Pages must not
import from another page's directory — if a second surface needs something,
move it into `src/features/` instead.

## Copy and density

- Lead with maintainer action and release risk, not internal pipeline detail.
- Keep dense review surfaces scannable: short headings, compact metadata, and findings pinned to evidence.
- Use severity stacked bars for risk distribution; avoid decorative charts.
- Icons are text glyphs only; no SVG icon libraries.

## Large diffs

`DiffView` must stay responsive on megabyte-scale bundled artifacts (e.g. vite's 1.3 MiB `dist/node/chunks/node.js`):

- Syntax highlighting is skipped per side above `HIGHLIGHT_MAX_LINES` (3,000 lines, ~1.7s of main-thread tokenization for bundled JS) or `HIGHLIGHT_MAX_CHARS` (256 KiB, guards minified few-enormous-lines samples) in `src/components/highlight.ts`. The meta row notes "syntax highlighting off (large file)". The cap applies to the text handed to shiki, so a reformatted side is measured after re-flow: shiki's cost is per-line, and a 128 KiB bundle re-flows to ~5,700 lines and ~1.9s per side, so exempting it would blow the budget the cap exists to hold.
- Two-sided diffs collapse long unchanged runs into expandable gap rows (`src/components/diff-hunks.ts`, 3 context lines); rows carrying pinned findings never collapse.
- Single-sided views render 1,000 lines initially with a "show more" expander; findings pinned past the rendered window fall back to the banner above the diff.
- Word-diff pairing bails out for changed blocks beyond 10,000 line-pair combinations to avoid quadratic scoring.
- Line pairing is bounded by `LINE_DIFF_TIMEOUT_MS` (1.5s). Past it the baseline and staged samples render independently through the single-sided 1,000-line incremental window, with a notice saying pairing was abandoned. This avoids both dishonest line pairing and an unbounded DOM commit for tens of thousands of manufactured changed rows. `buildRows` takes the budget as an option so the give-up path is testable without a genuinely slow diff.

## Minified files

A minified bundle is one line, so `diffLines` reports one removed and one added line for any change at all. `src/components/format-source.ts` re-flows both sides at statement and block boundaries first, which is what makes the line diff, hunk collapse, and finding pinning work on `dist/` artifacts. On preact's `dist/preact.min.js`, a patch release goes from 2 changed lines of 11 KB each to 39 changed lines out of 464.

- It runs client-side as a display transform. Scan artifacts, report exports, and the AI reviewer keep seeing the shipped bytes; nothing persisted is reformatted.
- It only inserts whitespace between tokens. The token stream round-trips (asserted in `test/format-source.test.ts`, including under fast-check), so the view can never show bytes the artifact does not contain. Breaks land only after `;`, `{`, `,` and around `}` — never automatic-semicolon-insertion sites — so the reformatted text stays semantically the source it came from. A break is also skipped wherever the source already ends the line, so re-flowing a hand-written file adds no blank rows.
- JavaScript, TypeScript, and JSON go through the shared lexer in `server/lib/platform/js-lexer.ts` (also used by the deterministic scanner's constant folder); CSS uses a character scanner because `//` is not a comment in CSS and `url(//cdn…)` would swallow the file. JSX/TSX and SCSS deliberately stay unformatted: JSX text nodes and SCSS `//` comments make inserted whitespace meaningful, and the small scanners do not claim to understand those grammars. The CSS scanner skips escaped code points both generally and inside `url(…)`, and is held to its own invariants in `test/format-source.test.ts` (non-whitespace characters preserved, no blank rows, line map in range) since it shares nothing with the lexer.
- Whether a `/` opens a regex literal decides where a token ends, so `js-lexer.ts` tracks bracket kinds: a `)` that closed an `if`/`for`/`while`/`with` head and a `}` that closed a statement block are followed by a statement, where `/` starts a regex; a call's `)` and an object literal's `}` are values, where it divides. Class bodies and bindingless `catch {}` blocks are tracked explicitly. Template interpolation uses the same comment/string/template/regex boundaries before counting braces, so literal `}` and backticks cannot terminate `${…}` early. `test/js-lexer.test.ts` pins the corpus both ways.
- It is on by default when a side `looksMinified` (any line ≥ 500 chars) and off otherwise, with a "Reformat" toggle in the diff options. The "reformatted for review" note in the meta row appears only when a side actually changed, not merely when the toggle is on.
- Findings are re-pinned through the formatter's source-line map (`remapFindingLines`). A finding only ever lands on a row that came from the line the rule reported; a line this side does not have is unpinned to the banner rather than left pointing at a raw line number, since reformatting multiplies the row count. The annotation caption keeps naming the artifact's line, never the reformatted row — a reviewer taking a line number back to the package must get the real one.
- Findings carry no column, so a rule that matched halfway through a bundle still pins to the top of its source line. That is exactly as precise as the unformatted view. Recording match offsets server-side is the follow-up that would make it exact.

## Signals reminder

Render signals directly or derive with `useComputed`; do not eagerly unwrap `.value` in component bodies for conditional JSX. See `docs/tooling.md` and `.claude/skills/preact-signals-*` for the detailed rules.
