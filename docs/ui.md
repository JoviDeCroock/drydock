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

- Syntax highlighting is skipped per side above `HIGHLIGHT_MAX_LINES` (3,000 lines, ~1.7s of main-thread tokenization for bundled JS) or `HIGHLIGHT_MAX_CHARS` (256 KiB, guards minified few-enormous-lines samples) in `src/components/highlight.ts`. The meta row notes "syntax highlighting off (large file)".
- Two-sided diffs collapse long unchanged runs into expandable gap rows (`src/components/diff-hunks.ts`, 3 context lines); rows carrying pinned findings never collapse.
- Single-sided views render 1,000 lines initially with a "show more" expander; findings pinned past the rendered window fall back to the banner above the diff.
- Word-diff pairing bails out for changed blocks beyond 10,000 line-pair combinations to avoid quadratic scoring.

## Signals reminder

Render signals directly or derive with `useComputed`; do not eagerly unwrap `.value` in component bodies for conditional JSX. See `docs/tooling.md` and `.claude/skills/preact-signals-*` for the detailed rules.
