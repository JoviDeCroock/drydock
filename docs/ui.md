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

| Component                                      | Purpose                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`, `LinkButton`                         | Primary / secondary / ghost / danger; sizes `sm` and `md`.                                                                                                                                                                                                                                                                                                                    |
| `Input`                                        | Text input with focus ring driven by `--color-accent-soft`.                                                                                                                                                                                                                                                                                                                   |
| `Field`, `Label`                               | Mono uppercase label paired with an input.                                                                                                                                                                                                                                                                                                                                    |
| `Badge`                                        | Severity (`critical`/`high`/`medium`/`low`/`info`/`ok`) and status (`added`/`removed`/`modified`/`unchanged`/`mixed`) tones. Squarish (3px radius) — pill badges are deprecated. Use `severityTone()` / `statusTone()` helpers to map raw strings safely. The `mixed` status tone uses the accent color and represents folders whose descendants span multiple change states. |
| `Alert`                                        | Banner with tone-coded border + soft fill, used for inline errors and notices.                                                                                                                                                                                                                                                                                                |
| `Card`, `SummaryCard`                          | Bordered surfaces. `SummaryCard` is the small label-over-mono-value tile used in scan summaries.                                                                                                                                                                                                                                                                              |
| `PageShell`                                    | Top-level `<main>` wrapper with width (`wide` / `narrow`) and the standard padding.                                                                                                                                                                                                                                                                                           |
| `Eyebrow`, `SectionLabel`, `MonoLine`, `Muted` | Typographic helpers — mono uppercase eyebrows, mono labels with a trailing rule, the signature mono detail line, and a muted text helper.                                                                                                                                                                                                                                     |
| `FileTree`                                     | Recursive folder/file tree built from `DiffEntry[]`. Folders aggregate their descendant statuses: all added → green, all removed → red, all unchanged → neutral, anything else → `mixed` (accent orange). Files render as clickable buttons; selection is owned by the parent.                                                                                                |
| `DiffView`                                     | Unified before/after view. Uses the `diff` package's `diffLines` to compute hunks; rows are rendered as escaped text only (no `dangerouslySetInnerHTML`). Handles single-sided cases (added / removed) and falls back to a `Muted` placeholder for binary or missing samples.                                                                                                 |
| `VersionPicker`                                | Native `<select>` styled with the form tokens. Lists published versions, each with optional dist-tag chips, and marks the scan's default comparison.                                                                                                                                                                                                                          |
| `cn()`                                         | Tiny class-name joiner. Falsy values are dropped.                                                                                                                                                                                                                                                                                                                             |

## Product copy voice

- Favor maintainer outcomes over implementation mechanics: “review staged releases”, “release evidence”, “safety report”, and “risky changes” read better than route names, storage layers, model names, or Worker internals.
- Keep security promises concrete but user-facing. Say tokens are encrypted, hidden after save, and used only to retrieve release evidence; avoid naming internal gateways/sandboxes unless the screen is explicitly technical.
- Reserve implementation-specific labels such as D1, Dynamic Worker, Workers AI, Drizzle, and model names for docs, logs, or developer-facing diagnostics.
- Use “review” for the product workflow and “scan” only where it refers to API objects, code, or existing technical data models.

## Component prop conventions

- Always type `class?: string` explicitly (do not spread Preact's `Signalish<string>` into `cn`).
- Variants are string unions, not booleans (e.g. `variant: "primary" | "secondary"`), to keep call sites readable.
- New primitives go in `src/components/`, are re-exported from `src/components/index.ts`, and prefer composition over configuration sprawl.

## Release diff workbench

The scan detail page (`src/pages/Dashboard/ScanDetail.tsx`) hosts the release diff workbench. The layout is intentionally document-shaped rather than dashboard-card-heavy:

1. Completed reports lead with a compact recommendation block: block manual approval, review carefully, or likely safe. The recommendation is derived from persisted risk and the highest-impact deterministic evidence, and its copy keeps npm approval outside the product.
2. The report summary is a compact badge row plus mono metadata line. Summary tiles are avoided here so status, stage ID, file counts, assistant assessment, and report version do not compete with the diff.
3. A `VersionPicker` sits in a simple bordered toolbar. Default selection is `defaultPreviousVersion` returned by `GET /api/v1/scans/:id/versions` — the version the scan was originally diffed against. Switching the picker triggers an on-demand fetch of that version's tarball via `GET /api/v1/scans/:id/compare?version=...`. Results are cached per version in component state so toggling between two versions does not re-spin the sandbox Worker.
4. The main workbench is `FileTree` (left, 300px) + `DiffView` (center). The risk-signals column appears only when deterministic findings exist; otherwise the diff expands to use the available width and "no findings" is represented in the compact summary badges. The tree is built from either the persisted `summary.diff` (for the default comparison) or from `createPackageDiff(compare.files, stagedFiles)` recomputed client-side when the user picks a non-default version.
5. Persisted report sections (reviewer notes, fingerprint, manifest changes) follow as section-label blocks, not cards. The old "Changed files" table was retired — that information is now available in the tree.

The `compare` endpoint re-parses the chosen prior tarball inside the existing `downloadInSandbox()` Dynamic Worker (i.e. through `NpmStageGateway`) so the trust boundary in [`security-model.md`](./security-model.md) is preserved. Returned file samples are redacted with the same helpers used at scan time. No schema or scan-pipeline changes are involved — the feature is a read-through view on top of existing data.

## Surface-density guidance

Use cards for interactive containment and lists that need table-like edges. Prefer section labels, mono detail lines, and `border-y` separators for read-only metadata. In particular:

- Saved scan reports and immediate review results use badge rows + mono metadata instead of grids of `SummaryCard`s.
- Empty findings do not get full bordered panels; represent them as compact badges or `EmptyLine`s inside an existing section.
- Dashboard order follows user intent: request a review first, recent reviews second, workspace setup last.
- Open staged publishes are not displayed directly. Discovery starts scan records for newly found stage IDs, and those records appear in Recent reviews.
- The recent reviews list paginates with `GET /api/v1/scans?cursor=…&filter=…`. The default filter is `undecided`; filter chips (Undecided / Approved / Blocked / All) sit above the table and re-fetch on change. Retries appear as separate rows — the old "newest-per-stage" dedup is gone now that decisions and pagination both depend on a one-row-per-scan model.
- The scan detail page renders a publish decision panel above the diff workbench whenever the scan is `complete`. Approve / Block buttons record a decision via `POST /api/v1/scans/:id/decision`; a recorded decision is displayed with timestamp, optional reason, and a "Change decision" affordance that re-opens the form. The dashboard exposes the same decision as a badge column.
- When npm access is missing, the blocked request-review card links directly to workspace setup. Connected workspace setup is collapsed by default, but the closed row must look clickable and include an explicit “Open settings” affordance.
- Connection metadata is displayed as compact label/value rows, while the editable credential form remains inside a card.
- Marketing hero copy is unboxed; feature claims use cards below the headline.

## Anti-patterns

- The retired `#7c5cff` violet accent. The brand action color is `--color-accent` (`#ea580c`).
- Pill-shaped badges (`rounded-full`). Severity and status badges use 3px radius.
- Gradient buttons, gradient hero backgrounds, icon-in-colored-circle feature grids — see `DESIGN.md` for the full list.
- Decorative use of severity colors (red as an accent, etc.). Severity colors are reserved for severity meaning.
