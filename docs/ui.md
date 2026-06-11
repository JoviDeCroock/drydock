# UI styling and primitives

`DESIGN.md` is the source of truth for Drydock UI decisions: fonts, colors, spacing, iconography, chart rules, interaction density, dark/light behavior, and marketing-surface constraints. Read it before visual work.

This file is only a compact implementation map.

## Stack

- Preact + `preact-iso` routes under `src/pages/`.
- Tailwind CSS v4 via `@tailwindcss/vite`.
- Tokens live in `src/style.css` under `@theme`; dark mode follows `prefers-color-scheme`.
- State uses `@preact/signals`; `useState`/`useReducer` are banned by oxlint.

## Primitives

Prefer existing primitives in `src/components/` before adding one-off classes:

- layout/content: `PageShell`, `Card`, `SectionLabel`, `Eyebrow`, `Toolbar`;
- controls: `Button`, `LinkButton`, `Input`, `Field`, `Select`, `Tabs`;
- feedback/status: `Badge`, `Alert`, `Progress`, `EmptyState`, `Skeleton`;
- data/review: table, diff, finding, and risk-summary components colocated with their surfaces.

## Copy and density

- Lead with maintainer action and release risk, not internal pipeline detail.
- Keep dense review surfaces scannable: short headings, compact metadata, and findings pinned to evidence.
- On scan detail, persisted report sections show report provenance, manifest changes, and reviewer notes as section-label blocks, not cards.
- Use severity stacked bars for risk distribution; avoid decorative charts.
- Icons are text glyphs only; no SVG icon libraries.

## Signals reminder

Render signals directly or derive with `useComputed`; do not eagerly unwrap `.value` in component bodies for conditional JSX. See `docs/tooling.md` and `.claude/skills/preact-signals-*` for the detailed rules.
