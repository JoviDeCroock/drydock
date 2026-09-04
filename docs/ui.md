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

- layout/content: `PageShell`, `Card`, `SectionLabel`, `Toolbar`;
- controls: `Button`, `LinkButton`, `Input`, `Field`, `Select`, `Tabs`;
- feedback/status: `Badge`, `Alert`, `Progress`, `EmptyState`, `Skeleton`;
- data/review: table, diff, finding, and risk-summary components colocated with their surfaces.

## Shared review surface

Three surfaces render the same review: the authenticated scan workbench
(`src/pages/Dashboard/ScanDetail/`), the anonymous public diff
(`src/pages/Diff/`), and the shared public report (`src/pages/PublicReport/`).
What they use lives in `src/features/review/`:

- `types.ts` — `ReviewFinding` (only the fields the review UI renders) and
  `FindingWithDiffStatus`. Deliberately narrower than a persisted scan finding
  so the public diff, which persists nothing, does not have to invent
  `scanId`/`ruleVersion` values to satisfy a shared component.
- `diff-entries.ts` — `filterDiffEntries` and `findingCountsByPath`.
- `RiskSignalsSection.tsx` — the changed-file/package-context findings split.
- `ReviewWorkbench.tsx` — the release tree + file diff pair. Filter state
  arrives as signals and is read inside the component, so a keystroke in the
  filter box re-renders the tree and not the page body (which on the scan
  detail also renders the per-finding risk index). The diff panel itself is the
  caller's `children`, because what a "previous side" is differs per surface.

Surface-specific code stays with its page. `ScanDetail/diff-helpers.ts` keeps
what is tied to the persisted scan model (`scanFilesToFileRecords`,
`annotatePersistedFindings`, the `DiffWorkbench` state machine). Pages must not
import from another page's directory — if a second surface needs something,
move it into `src/features/` instead.

## Review page order

Both review pages lead with the diff:

- **Scan detail** — a one-row verdict strip (recommendation, qualifying risk
  badges, the version picker, and the decision button), then the workbench,
  then a `CollapsibleCard` of review notes (why the verdict reads that way, the
  AI reviewer's summary, release memory, source binding), then the risk index
  and the manifest sections. The notes open themselves when any of those has
  something to say and stay shut when the release is clean. The decision button
  lives in the strip on a completed review and in the page header otherwise,
  since a failed gate review renders no strip.
- **Public report** — verdict card, then the same workbench, then the risk
  index. Its diff is single-sided: a share token buys the staged artifact's
  redacted samples (`GET /public/reports/:token/file`) and never a baseline,
  which would cost the organization's npm credentials. `singleSidedTone` in
  `DiffView` keeps a `modified` file rendered from one side neutral instead of
  tinting every row as an insertion.

## Dashboard overview strip

`src/features/overview/OverviewStrip.tsx` sits above Recent reviews and answers
"what is waiting on me, and is it approvable yet" for the active organization.
npm now stages every trusted-publishing release and holds stage approval until
its own malware scan settles, so every release sits in a window; the strip is
that window as four tiles, each a link into the matching `?filter=` on the
list: **Waiting on you** (completed npm reviews with no decision whose npm
status is unknown, `staged`, or `validating`, with the age of the oldest),
**npm still scanning** (`validating`, with how many already have a finished
Drydock review), **Published, no decision** (the list's
`published_without_decision` semantics, limited to scans created in the last 30
days), and **Decided · 30d** (approved vs rejected plus the median
completion-to-decision time). The first three count only npm staged-publish
sources (`manual`, `auto_discovery`); workflow-gate and published-pair scans
carry no npm stage. `ScanOverviewModel` (`src/models/scan-overview.ts`) reads
`GET /api/v1/scans/overview`, one aggregate D1 statement in
`server/db/scan-overview.ts`; the dashboard re-reads it whenever the list
changes and joins an in-flight request rather than repeating it. The strip is
absent for an organization with no scans, keeps its previous figures while a
refresh is in flight, and renders a mono loading or error line otherwise. Tiles
are mono tabular numbers under an 11px mono label, on a 2x2 grid below `lg`.

## Dashboard onboarding funnel

`src/pages/Dashboard/GettingStarted.tsx` tracks three steps: npm connected, a
first release reaching Drydock for review, a first decision recorded. `DashboardOnboarding`
in `src/pages/Dashboard/index.tsx` decides when it opens and latches that
against the organization it opened for in `src/models/getting-started.ts`; the
session-scoped latch survives a visit to the scan detail route, and nothing but
the reader's dismiss control (or an organization switch) closes it. That latch
is what lets the third step be seen ticking — a panel that unmounted the moment
the funnel completed would take the tick with it. Only the first two steps are
free: the list defaults to the
`undecided` filter, so `ScanListModel.hasAnyDecision` stays `null` until
`resolveHasAnyDecision()` runs two one-row probes, and the dashboard asks only
while the panel could still open. Completion and dismissal are both recorded per
organization in `src/models/getting-started.ts` (localStorage) as "do not open
again", which is also what stops the probe from repeating on later visits. An
unresolved (`null`) answer opens nothing — neither onboarding surface appears on
a guess. Switching organizations immediately resets both progress answers to
`null`, so the new organization cannot inherit a panel latch or completion tick
from the previous one while its list request is in flight.

## Package release view

`/dashboard/packages/:name` (`src/pages/Dashboard/PackageReleases/`) lists one
package's reviews for the active organization, grouped by channel (dist-tag)
and newest first, over `GET /api/v1/packages/:name/releases`. A scoped name
keeps its slash in both paths (`/dashboard/packages/@scope/name`, as `/diff`
does — the asset layer redirects an encoded slash to a literal one, so a
single encoded segment does not survive a hard load); both routes take the
name as a rest parameter and `src/lib/package-releases-path.ts` builds the
URLs. The ecosystem rides in `?ecosystem=` only when it is not npm. Each row shows the version, what it was compared against
(`describeBaseline` in `src/features/package-releases.ts` turns the persisted
baseline selection into "2.0.0-beta.1 (beta)" / "(previous version)" /
"(highest published)" / "no baseline"), release risk, the decision with who
and when, npm's lifecycle badge with its observation time, the scan source,
and the review link. `releaseAttention` marks the two disagreements the page
exists to surface — npm published a version nobody here decided on (warn
fill), and npm published a version Drydock blocked (danger fill) — and the
summary strip counts both alongside total reviews, channels, and the last
release. Package names in the dashboard list and the `all releases →` link in
the scan header open it; the scan header's back link returns to whichever
list surface the review was opened from (`getDashboardReturnUrl`).

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
- It only inserts whitespace between tokens. The token stream round-trips (asserted in `test/format-source.test.ts`, including under fast-check), so the view can never show bytes the artifact does not contain. JavaScript and TypeScript breaks land only after `;`, `{`, `,` and around `}`; JSON additionally expands `[` / `]` and array commas. None are automatic-semicolon-insertion sites, so the reformatted text stays semantically the source it came from. A break is also skipped wherever the source already ends the line, so re-flowing a hand-written file adds no blank rows.
- JavaScript, TypeScript, and JSON go through the shared lexer in `server/lib/platform/js-lexer.ts` (also used by the deterministic scanner's constant folder); CSS uses a character scanner because `//` is not a comment in CSS and `url(//cdn…)` would swallow the file. `.cjs`/`.cts` samples use the Script lexical goal so top-level `await` and `yield` remain identifier-shaped, while `.mjs`/`.mts` use the Module goal. For ambiguous `.js`/`.ts` samples containing those contextual keywords, Script and Module token streams must agree or reformatting fails closed to the raw bytes; choosing one goal could otherwise turn division into a fake regex token and hide executable evidence inside it. JSX/TSX and SCSS deliberately stay unformatted: JSX text nodes and SCSS `//` comments make inserted whitespace meaningful, and the small scanners do not claim to understand those grammars. Because extensions are only hints, JavaScript and TypeScript samples are checked for unambiguous JSX fragments and closing/self-closing tags before re-flow; JavaScript also uses expression-position opener checks, while TypeScript keeps angle-bracket assertions eligible. The CSS scanner decodes escaped identifier code points when recognizing `url(…)` (including spellings such as `u\72l(…)`) and keeps the whole payload opaque across leading whitespace, newlines, comments, strings, and escapes; it is held to its own invariants in `test/format-source.test.ts` (non-whitespace characters preserved, no blank rows, line map in range) since it shares nothing with the lexer.
- Whether a `/` opens a regex literal decides where a token ends, so `js-lexer.ts` tracks bracket kinds: a `)` that closed an `if`/`for`/`while`/`with` head and a `}` that closed a statement block are followed by a statement, where `/` starts a regex; a call's `)` and an object literal's `}` are values, where it divides. Keyword-shaped member calls and contextual identifiers remain values outside their grammar roles. Ordinary function, method, and arrow bodies keep `await`/`yield` identifier-shaped through nested syntax, parameter initializers, destructuring, and template interpolation, while nested async and generator bodies restore their keyword roles; computed, generic, and private method heads, TypeScript generic async arrows, and ASI after concise arrow bodies preserve the same scope boundary. Instance field initializers reset an enclosing async/generator mode while computed member names retain it. Catch, for-head, destructured declaration, function/class declaration, and function-scoped `var` bindings retain their owning lexical scope. Typed and ambient variable declarations retain their ASI boundary, semicolonless ambient function signatures terminate before a following regex statement, and typed arrows cannot leak a pending body marker into a later object expression. Class static initialization blocks retain their inner statement context. Class bodies, TypeScript block declarations and typed function/method bodies, type-alias continuation operators, import-equals declarations, bindingless `catch {}` blocks, labels, and braced `case` clauses are tracked explicitly. Function/class expression bodies are values at their closing brace but statement lists inside — minified bundles are IIFE wrappers, so labels and nested declarations sit directly in one. Pending bodies are kept in ordered, depth-keyed stacks so same-depth class heritage expressions pair with the right body and hostile truncated headers remain linear to clean up. Hashbangs and Annex B HTML-like line comments remain opaque, including inside template interpolation; interpolation otherwise uses the same comment/string/template/regex boundaries before counting braces, so literal `}` and backticks cannot terminate `${…}` early. An explicit frame stack handles excessive nesting without risking a call-stack overflow. `test/js-lexer.test.ts` pins the corpus both ways.
- It is on by default when a side `looksMinified` (any line ≥ 500 chars) and off otherwise, with a "Reformat" toggle in the diff options. The "reformatted for review" note in the meta row appears only when a side actually changed, not merely when the toggle is on.
- A two-sided diff never mixes a safely rejected raw side with a reformatted opposite side. If JSX, an oversized sample, or the token-stream guard rejects either side, both stay raw; a side that simply has no useful break points can still pair with a reformatted side because its raw text is already in the formatter's target shape.
- Findings are re-pinned through the formatter's source-line map (`remapFindingLines`). A finding only ever lands on a row that came from the line the rule reported; a line this side does not have is unpinned to the banner rather than left pointing at a raw line number, since reformatting multiplies the row count. The annotation caption keeps naming the artifact's line, never the reformatted row — a reviewer taking a line number back to the package must get the real one.
- Findings carry no column, so a rule that matched halfway through a bundle still pins to the top of its source line. That is exactly as precise as the unformatted view. Recording match offsets server-side is the follow-up that would make it exact.

## Signals reminder

Render signals directly or derive with `useComputed`; do not eagerly unwrap `.value` in component bodies for conditional JSX. See `docs/tooling.md` and `.claude/skills/preact-signals-*` for the detailed rules.
