# UI styling and primitives

The visual system is defined in [`DESIGN.md`](../DESIGN.md). This file documents how it is wired into the code.

## Stack

- **Tailwind CSS v4** via `@tailwindcss/vite` (registered in `vite.config.ts`).
- **Design tokens** declared in `src/style.css` with `@theme` — colors, fonts, shadows. Light is the default; dark mode is overridden inside `@media (prefers-color-scheme: dark) { @theme { … } }`. Every Tailwind utility that references a token (`bg-bg`, `text-ink`, `border-border`, `bg-accent`, `bg-danger-soft`, etc.) flips automatically with the system theme.
- **No CSS-in-JS.** No external utility libraries.

## Token names

Read `src/style.css` for the source of truth. Surface tokens use semantic names rather than scale numbers:

- Surfaces: `bg`, `surface`, `surface-2`
- Borders: `border`, `border-strong`
- Text: `ink`, `ink-muted`, `ink-subtle`
- Brand: `accent`, `accent-hover`, `accent-soft`, `accent-on`
- Severity: `danger`, `warn`, `info`, `ok` (each with a `-soft` variant for fills)
- Fonts: `font-sans` (Geist), `font-mono` (Geist Mono)

Avoid hard-coded hex values in components. If you need a value that does not exist, add it to `@theme` first.

## Primitives (`src/components/`)

Reach for these before writing one-off classes:

| Component | Purpose |
|---|---|
| `Button`, `LinkButton` | Primary / secondary / ghost / danger; sizes `sm` and `md`. |
| `Input` | Text input with focus ring driven by `--color-accent-soft`. |
| `Field`, `Label` | Mono uppercase label paired with an input. |
| `Badge` | Severity (`critical`/`high`/`medium`/`low`/`info`/`ok`) and status (`added`/`removed`/`modified`/`unchanged`) tones. Squarish (3px radius) — pill badges are deprecated. Use `severityTone()` / `statusTone()` helpers to map raw strings safely. |
| `Alert` | Banner with tone-coded border + soft fill, used for inline errors and notices. |
| `Card`, `SummaryCard` | Bordered surfaces. `SummaryCard` is the small label-over-mono-value tile used in scan summaries. |
| `PageShell` | Top-level `<main>` wrapper with width (`wide` / `narrow`) and the standard padding. |
| `Eyebrow`, `SectionLabel`, `MonoLine`, `Muted` | Typographic helpers — mono uppercase eyebrows, mono labels with a trailing rule, the signature mono detail line, and a muted text helper. |
| `cn()` | Tiny class-name joiner. Falsy values are dropped. |

## Component prop conventions

- Always type `class?: string` explicitly (do not spread Preact's `Signalish<string>` into `cn`).
- Variants are string unions, not booleans (e.g. `variant: "primary" | "secondary"`), to keep call sites readable.
- New primitives go in `src/components/`, are re-exported from `src/components/index.ts`, and prefer composition over configuration sprawl.

## Anti-patterns

- The retired `#7c5cff` violet accent. The brand action color is `--color-accent` (`#ea580c`).
- Pill-shaped badges (`rounded-full`). Severity and status badges use 3px radius.
- Gradient buttons, gradient hero backgrounds, icon-in-colored-circle feature grids — see `DESIGN.md` for the full list.
- Decorative use of severity colors (red as an accent, etc.). Severity colors are reserved for severity meaning.
