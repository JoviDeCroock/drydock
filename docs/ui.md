# UI implementation map

Where each Preact surface lives and the behavioral contracts its components keep. **Authority:** internal (UI state is never authority; the server re-checks every role and organization). **Owner:** `src/index.tsx` (routes).

Visual rules (type, color, glyphs, states) live in [design.md](./design.md). Lint rules for signals and design tokens: [tooling.md](./tooling.md#lint-rules).

## At a glance

| Route | Page | Main components | Files |
| --- | --- | --- | --- |
| `/` | Landing | hero, review preview, incident diffs, integrations | `src/pages/Landing/`, `src/features/incident-diffs/`, `src/features/dependency-pr-integrations/` |
| `/docs`, `/agents` | Docs, agent guide | `CodeBlock`, learning path | `src/pages/Docs/`, `src/pages/Agents/`, `src/features/agent-quickstart/` |
| `/npm-staged-publishing`, `/security`, other guides | Discovery guides | `ContentArticle` shell | `src/pages/Guides/`, `src/features/public-content/ContentArticle.tsx` |
| `/incidents/*`, `/benchmarks/shai-hulud-nx` | Incident analyses, benchmark | `ContentArticle` shell | `src/pages/Incidents/`, `src/pages/Benchmarks/` |
| `/diff`, `/diff/*` | Public package diff (anonymous) | `ReviewWorkbench`, `TrustEvidence` | `src/pages/Diff/` ([public-diff.md](./public-diff.md)) |
| `/reports`, `/reports/:token` | Shared public report | `ReviewWorkbench`, `ReportDiffPanel` | `src/pages/PublicReport/` ([public-reports.md](./public-reports.md)) |
| `/login`, `/register`, `/verify-email`, `/forgot-password`, `/reset-password` | Auth | narrow `PageShell` cards | `src/pages/Auth/` |
| `/dashboard` | Reviews list | `OverviewStrip`, `PublicationMonitor`, `GettingStarted`, `BatchApprovalDialog` | `src/pages/Dashboard/`, `src/features/overview/`, `src/features/publication-monitor/` |
| `/dashboard/scans/:id` | Scan detail | verdict strip, `DiffWorkbench`, `ReleaseTimeline` | `src/pages/Dashboard/ScanDetail/` |
| `/dashboard/packages/:name+` | Package release view | `PublicBadgeSection`, `PackagePublicationSection` | `src/pages/Dashboard/PackageReleases/` |
| `/dashboard/settings` | Settings | npm, GitHub App, Slack, members, audit sections | `src/pages/Dashboard/Settings/` |
| `/dashboard/account`, `/dashboard/invite`, `/dashboard/settings/github-app/callback` | Account, invite, GitHub callback | — | `src/pages/Dashboard/Account/`, `src/pages/Dashboard/Invite/`, `src/pages/Dashboard/GithubAppCallback.tsx` |

## Stack and routing invariants

1. Preact 11 + `preact-iso`; Tailwind v4 via `@tailwindcss/vite`; tokens under `@theme` in `src/style.css`; dark follows `prefers-color-scheme`. State is `@preact/signals`; `useState`/`useReducer` are banned by oxlint.
2. Routes use `ScopedRoute` (`src/features/routing/ScopedRoute.tsx`), not `Route`. The Router keeps the departing page mounted until the next chunk loads; inside a `ScopedRoute`, `useLocation()` keeps the URL the page was last current for and its `route()` (so every `useQuerySignal` write) is dropped once the browser is on another path. Code reading the URL after an `await` reads `location.url`, not `window.location`.
3. Async work whose result must be dropped on unmount runs through `useCancellableEffect` (`src/lib/use-cancellable-effect.ts`). Preact 11 defers `useEffect` cleanup past the next paint, so a `cancelled` flag set there still lets a late response write the unmounted page's signals or `route()` from a keyed remount on the same path (`PackageReleasesView` keyed on `?org=`).
4. Links to Worker routes (`/public/*`, `/api/*`) need `target="_blank"` + `rel="noreferrer"`, or `download`: `preact-iso` intercepts same-origin anchors and those paths have no `<Route>`. `test/server-route-links.test.ts` guards literal hrefs.
5. `src/features/error-report/AppErrorBoundary.tsx` wraps the router: a render error (or a failed `lazyRoute` chunk load after a deploy) shows a recovery card (reload, `mailto:` bug report, copyable details) that clears on the next navigation. `src/features/error-report/bug-report.ts` drops query and hash and redacts a `/reports/:token` token; nothing is sent automatically. Contacts: `src/lib/contact.ts`.
6. Public page metadata lives in `src/lib/seo-metadata.ts`; static pages are prerendered by `src/index.tsx`. The Worker rewrites diff-page title, description, canonical, and social metadata in `server/lib/public-diff/page.ts` before JavaScript runs. Package-only npm/PyPI pages keep the static social card; version pairs use a generated card.
7. The homepage has one fixed hero and public-diff action in both prerendered HTML and client render (description shared with `homePageSeo`); no variant assignment or copy swap during hydration. Keep the initial canonical aligned with client metadata and `public/sitemap.xml`.
8. Pages never import another page's directory; code shared by two surfaces moves to `src/features/` (lint: `boundaries-local/no-cross-page-import`).

## Primitives

Prefer `src/components/` before one-off classes.

| Group | Primitives |
| --- | --- |
| Layout / content | `PageShell`, `Card` (`CollapsibleCard`, `SettingsCard`), `SectionLabel` and other `Typography` exports, `StatusStrip` |
| Buttons | `Button`, `LinkButton`, `LoadMoreButton`, `CopyButton`, `CloseButton` |
| Inputs and overlays | `Input`, `Field`, `Select`, `VersionPicker`/`VersionPairPicker`, `Menu`, `Dialog`, `ConfirmDialog` |
| Docs / code | `CodeBlock` (highlighting, copy, folding; shared by Docs and the agent guide) |
| Feedback | `Badge`, `Alert`, `Toast`, `LoadingState`/`LoadingLine`/`IndeterminateBar`, `SeverityBar` |
| Review data | `FileTree`, `DiffView`, `DiffOverview`, `FindingCard`, `PackageJsonDiffView` |

A primitive whose `open`/`status`/`error` changes at round-trip rate (`Dialog`, `ConfirmDialog`, `LoadMoreButton`, scan-detail dialogs) accepts a value or a signal; `readSignalProp` (`src/components/signal-props.ts`) unwraps it inside, so the primitive subscribes, not the page.

## Shared review surface

Scan detail, `/diff`, and the public report render one review from `src/features/review/`.

| File | Contract |
| --- | --- |
| `types.ts` | `ReviewFinding` (only rendered fields) and `FindingWithDiffStatus`; narrower than a persisted finding so `/diff`, which persists nothing, invents no `scanId`/`ruleVersion`. |
| `diff-entries.ts` | `filterDiffEntries`, `findingCountsByPath`; `hasNoLoadableBody` is the one place that decides a binary or content-skipped file has nothing to fetch. |
| `RiskSignalsSection.tsx` | Risk index: each finding stated once (rules below). |
| `risk-index.ts` | Index grouping and the description built from what it holds. |
| `useSelectedDiffFile.ts` | Entry and findings for the open path. |
| `ReviewWorkbench.tsx` | Tree + diff pair (rules below). |
| `initial-path.ts` | `findingFirstPath`: open on the changed file with the most severe finding; fallback is first change (scan detail, report) or the ecosystem manifest then status order (`/diff`). |

`ReviewWorkbench` rules:

1. Filter state arrives as signals read inside the component, so a keystroke re-renders the tree, not the page body (which on scan detail also renders the risk index).
2. The diff panel is the caller's `children`, because "previous side" differs per surface; a surface-wide caveat about that side goes in `diffAside` (the File diff label's trailing slot), not above every file.
3. A surface whose entries are not yet the comparison on screen passes `treeNotice` (`loading` or `unavailable`) instead of a stale or empty tree.
4. The notice is state only: the surface reports version, progress, failure reason, and "Try again" once, beside its picker (scan detail: a loading line in the picker row, one warn `Alert` under it for any failed comparison, baseline or picked); the diff panel only says it is waiting or has no comparison loaded. A version's compare failure is reported only while that version is the comparison shown.
5. Below `lg` the tree card caps at 360px and scrolls inside itself, so a large tree does not push the diff down a phone screen.

Surface-specific code stays with its page: `src/pages/Dashboard/ScanDetail/diff-helpers.ts` holds `scanFilesToFileRecords`, `annotatePersistedFindings`, `selectReleaseTree`, and the `DiffWorkbench` state machine.

## Headers and session

1. Every signed-in page uses `AppHeaderActions` (`src/features/account/AppHeaderActions.tsx`): `Reviews`, `Dependencies` (only for an organization the `dependency-review` rollout flag covers, or on its own pages), and `Settings` (current one `aria-current="page"`, accent text), `Feedback`, the organization switcher where org-scoped, the user menu. `/dashboard` is "Reviews" in every link.
2. Marketing header: `Package diff` · `Docs` · `Feedback` · `Sign in`. Feedback always sits after navigation and before account controls; header actions render `HeaderFeedback` (`src/components/PageShell.tsx`) themselves so DOM and tab order match. Without header actions Feedback shows alone; at phone width beside header actions it hides (header max two rows) and the footer Contact column carries it.
3. Every `/dashboard*` page runs `useAuthedDashboardSession` on mount: load session, redirect signed-out visitors to `/login?returnTo=<page>`, remember list surfaces as the back link, then run page loads.
4. A page whose model is built from a route param (scan detail, package releases) renders under `key={param}` so a new param remounts with a fresh model and guard.
5. Links into a review use `scanDetailPath` (`src/lib/scan-detail-path.ts`), which carries `?org=`. A link without it (the workflow-gate GitHub comment is capped at 140 characters) is resolved via `GET /api/v1/scans/:id/organization`, which names which of the reader's organizations holds the review; the page pins it and writes it to the URL. If none does or the lookup fails, the remembered organization is used; anything else is the same not-found. Switching organization on scan detail leaves for that organization's reviews.
6. Scan detail composes computeds and handlers in `src/pages/Dashboard/ScanDetail/hooks/useScanDetailView.ts`; sections subscribe to what they show. `useNow(intervalMs)` (`src/lib/use-now.ts`) drives "checked 2 minutes ago".

## Review page order

| Surface | Order |
| --- | --- |
| Scan detail | Identity header → verdict strip → dependency readiness notice (when applicable) → version picker → workbench → review notes (`CollapsibleCard`) → risk index → manifest sections → pending package-management row → `ReleaseTimeline`. |
| Public report | Identity header → verdict card (risk grade, not the approver recommendation) → workbench → full risk index → closing block. |

Scan detail rules:

1. Header is identity only: package, a plain-text metadata line (staged version, npm state with observation time, other releases) with no Badges, and Share / Export JSON. Risk and comparison are not repeated there.
2. Verdict strip: recommendation with risk grade and any assistant note in one mono caption; a `manual review` Badge only when the assistant asks; the recorded decision beside its button. On a completed review the decision lives in the strip; otherwise (e.g. a failed gate review, which has no strip) in the header.
3. Review notes cover why the verdict reads that way, release memory, release changes, the advisory AI assessment, source binding. They open themselves only when something has something to say (findings, manifest changes, diverged release memory, an assistant reading that flags the release); source binding, matching memory, and "nothing unusual" never open them. The disclosure header does not repeat nested section names.
4. The risk index states each finding once: a release finding the diff shows is counted, not repeated (the notes list it); a pre-existing finding the diff shows gets a one-line row keeping its reason; only what the diff cannot show (AI findings, release-process signals, files outside the comparison, package context) gets a card.
5. The package-management choice, when pending, is a compact row under a `Package management` SectionLabel at the end; it gates monitoring and the badge, not this review.
6. Quiet terminal npm states (published, removed) get no separate notice row.
7. A failed staged or published-pair review offers `Review again` (fresh `POST /api/v1/scans`), except when a restart can only fail: npm already published, blocked, or deleted the candidate, or the npm connection is missing or unvalidated (the alert points to settings). A published-pair restart names the original baseline and the start route re-confirms it with the registry.
8. Findings in notes are grouped by rule, severity, source; file/line actions clear a conflicting tree filter and focus the annotation; unavailable lines keep the unpinned banner. Synthetic release-process and AI paths are not file actions. Script, dependency, and entrypoint changes are a separate summary linking to manifest details.
9. AI assessment leads with its structured assessment and risk and reminds that deterministic findings keep their severity. Model prose stays inert under **Read full AI assessment**, labeled advisory and potentially quoting package text. The severity bar renders only for two or more findings. Declared source binding shows one unverified repository link; only an exact duplicate manifest declaration is omitted.

Public report rules: header is a `public release review` MonoDetail lead, package, compared pair, review time, changed-file count, and decision as plain `DecisionState` text. Its diff is single-sided: a share token buys the staged artifact's redacted samples (`GET /public/reports/:token/file`), never a baseline (that would spend the organization's npm credentials). `singleSidedTone` in `DiffView` keeps a one-sided `modified` file neutral.

The public report's closing block states only where the reviewed bytes came from (`reviewedFromLine`), never that the release was held or awaits a decision, and offers pre-publish review for the reader's next release. An evidence-only (pre-sample) link puts its recovery beside the notice: **Open reviews** when signed in, **Diff this package** when the report names its ecosystem.

### Dependency readiness

`DependencyReadinessNotice` (`src/pages/Dashboard/ScanDetail/DependencyReadinessNotice.tsx`) sits directly under the verdict strip, beside the decision it informs. Eligibility and wording: `src/features/dependency-readiness.ts`; pinned by `test/dependency-readiness-view.test.ts`. Registry contract: [npm-staged-publishing.md](./npm-staged-publishing.md#dependency-readiness).

| Condition | Presentation / action |
| --- | --- |
| Completed npm review with approval still ahead | Check only an actionable stage (`manual` / `auto_discovery`) or a `pending` npm workflow gate; other ecosystems and published-pair reviews show nothing. |
| Required dependency cannot be installed yet | One `warn` Alert lists each blocked dependency with its spec and consequence; a staged sibling gets a `review →` link scoped to the organization. |
| Only optional or peer dependencies affected | `info` Alert; mono `optional` / `peer` text rather than a Badge. npm may omit unresolved optional dependencies; a missing peer can fail installation. |
| Registry lookup failed | Muted line with the count; **Check again** retries. |
| Dependencies not reached within the read budget | Separate muted line with the count; **Check the rest** advances checks (a blocking dependency or failure takes precedence with **Check again**). |
| Unsupported spec, oversized registry document, or past the limit | Separate muted line with the count; no action when these are the only issues. |
| Whole check unavailable | One muted explanation; a failed request offers **Check again**. |
| Clean or inapplicable check | Render nothing. |

## Dashboard

### Overview strip

`src/features/overview/OverviewStrip.tsx` above Recent reviews: "what is waiting on me, and is it approvable yet". Data: `ScanOverviewModel` (`src/models/scan-overview.ts`) → `GET /api/v1/scans/overview` → one aggregate D1 statement in `server/db/scan-overview.ts`.

| Tile | Counts | Opens |
| --- | --- | --- |
| Waiting on you | Completed npm reviews, no decision, npm status unknown/`staged`/`validating`; detail: oldest age | its `?filter=` |
| npm still scanning | `validating`; detail: how many have a finished Drydock review | its `?filter=` |
| Published, no decision · 30d | `published_without_decision`, scans created in the last 30 days; `danger` text when above 0 (`warn-text` read as a brand link) | its `?filter=` |
| Decided · 30d | Approved vs rejected, median completion-to-decision time | `decided` (same window) |

1. The first three count only npm staged sources (`manual`, `auto_discovery`); workflow-gate and published-pair scans carry no npm stage.
2. Re-read whenever the list changes; join an in-flight request instead of repeating it; keep previous figures during refresh.
3. Only the Published tile takes a tone. Absent for an organization with no scans; otherwise a mono loading or error line. Mono tabular numbers under 11px mono labels; 2x2 below `lg`. A detail line appears only when it adds a figure.

### Review rows

1. One leading chip: release risk, or lifecycle status while there is none. A second chip only when `registryStatusBadge` (`src/features/registry-status.ts`) returns a tone (blocked; awaiting approval after an approval here; published with no decision or a rejection here). Quieter npm states end the mono meta line as text.
2. No "undecided" chip: the Decide button says it; gate or superseded rows without a button say `undecided` / `superseded` in text. A decision renders as `DecisionState` text beside Update. Row buttons are `secondary`.
3. The package name opens the package release view once the review has an outcome; while queued or running it opens the review (`scanRowPackageLink`, `src/pages/Dashboard/scan-row-link.ts`).
4. Name and version are styled apart, not one `name@version`: name in ink (accent on hover), then the mono accent version that always opens the review. The row menu names both (`Open review`, `Release history`).
5. The meta line names the origin only when not the default (`started in Drydock` is omitted). A failed review says `attempted` and offers a secondary `Open review`, where the failure and any `Review again` live; the list projection lacks the failure code.

### Batch approval

1. When **Undecided** holds two or more low-risk reviews, the header offers secondary `Record N approvals`; dialog: `src/pages/Dashboard/BatchApprovalDialog.tsx`, model: `ScanBatchApprovalModel` (`src/models/scan-batch-approval.ts`).
2. The server decides eligibility (`listBatchApprovableScans` in `server/db/scan-decisions.ts`: release and artifact risk both low, a compared baseline, no findings new since the last approved release, no AI flag, still undecided and actionable on npm) and re-checks as it writes.
3. The dialog lists what qualified when it opened (late completions are not ticked), one optional reason, one primary button. The result says how many were approved and how many changed and stayed undecided, then links npm's staged-packages page: approving here publishes nothing. Audit semantics: [audit-log.md](./audit-log.md).

### Onboarding

1. `src/pages/Dashboard/GettingStarted.tsx` lists three steps (first release reaches Drydock, npm connected, review and decide); only the first is the funnel's exit.
2. `DashboardOnboarding` (`src/pages/Dashboard/index.tsx`) opens the panel when `ScanListModel.hasAnyScan` resolves `false`, latched per organization in `src/models/getting-started.ts` (so visiting scan detail does not reset it). `true` marks the organization done and closes it. Done (first review or dismiss) is stored per organization in localStorage.
3. `null` opens nothing. Switching organization resets `hasAnyScan` to `null` immediately. Deleting an organization's only (failed) scan re-probes and can reopen the panel; a late delete or decision after a switch leaves the new organization alone.
4. Once closed, `PublishedReviewForm` renders in its own "Review a published release" card. Settings links name their section: npm `?tab=integrations#npm-access`, workflow gate `#github-app`.

### Publication monitor card

`src/features/publication-monitor/PublicationMonitor.tsx` over `src/models/publication-watches.ts`; scope, limits, and API in [publication-monitor.md](./publication-monitor.md).

1. Mirrors Recent reviews anatomy: header with the enrol form, edge-to-edge rows, per-row `⋯` menu (show releases; stop watching for owners and admins); observations expand inline.
2. Watches arrive whole and render 25 at a time behind **Show more**, server-ordered: unacknowledged alerts, then "not verified" or coverage gap, then the rest, newest first within each. Up to 100 observations show, unacknowledged alerts first.
3. One notice lists packages queued for scheduled enrollment and capacity deferrals. The advisory meta line says checks happen after publication; unknown evidence never gets an approval badge. Acknowledgment is audited and never changes release evidence. Requests are fenced across organization changes.
4. The card ends with **Unapproved publishes** (`src/features/publication-monitor/UnapprovedPublishLog.tsx` over `src/models/publication-alert-log.ts`), reloaded after a check, acknowledgment, enrollment, or stop.

## Dependency reviews

`/dashboard/dependency-reviews` lists the organization's dependency reviews; `/dashboard/dependency-reviews/:id` shows one, grouped as the check run is (Held, Approved, Not reviewed, New packages, Clear). The detail page reads `?org=` like scan detail because the check run's details link carries it.

| State | Detail page |
| --- | --- |
| Held, approvable | Filled `Approve on GitHub ↗` opens the check run (`checkRunUrl`; the PR's Checks tab without a run id); `Open pull request` turns ghost. The alert says to read the diffs, who can approve, and that merging waits only where the check is required. |
| Held, not approvable | The detail response's `approvable` is the approval handler's own `listsEveryHold` (`server/lib/dependency-review/approvable.ts`): no Approve link; the alert says to split the PR. |
| Held on coverage only | No update count; Approve is secondary, and the alert says it accepts the unread changes and that making them readable gets them reviewed. |
| Failed | Secondary `Re-run on GitHub ↗`; the alert names the App-permission cause. |
| No holds | Not reviewed and New packages groups say why they passed; the headline counts them. An incomplete review says so and suggests smaller PRs. |
| Running | `Alert tone="info"` that the page refreshes when the review is ready. |
| Superseded / stale | Superseded is a muted line: the commit was no longer the head of an open PR when Drydock ran. A held review with a newer review on the same PR (`newerReviewId`) gets an info alert linking it and no Approve, since GitHub refuses approvals off the head. |

The list stacks rows below `sm` (repo and state, then author, short head SHA, count, time); counts show only for finished reviews. A list for an organization with review on and no GitHub App shows a warn alert with the install link instead of the empty state. In settings, App permissions appear only in that missing-App alert, extra bot logins fold under a disclosure (open when set) and state the write-access check they skip, and an unsaved enable toggle is marked beside it.

While a review is queued or running, both pages poll on the running-scan cadence (`src/models/background-poll.ts`) and offer Resume refresh once it stalls; the settings page does not poll. Reason wording comes from `server/lib/dependency-review/wording.ts`, shared with the check run. The settings section is `src/pages/Dashboard/Settings/DependencyReviewSection.tsx`, shown with the header link only when the organization list says `dependencyReview` ([dependency-review.md](./dependency-review.md)).

## Package release view

`/dashboard/packages/:name+` (`src/pages/Dashboard/PackageReleases/`) over `GET /api/v1/packages/:name/releases`.

1. One package's reviews for the active organization, grouped by channel (dist-tag), newest first. Release history leads; for npm the package-management choice and publication monitor follow; Public badge closes the page.
2. Scoped names keep a literal slash (`/dashboard/packages/@scope/name`, like `/diff`): the asset layer redirects an encoded slash. Both routes take a rest parameter; `src/lib/package-releases-path.ts` builds URLs. `?ecosystem=` only when not npm.
3. `?org=` stays in the address and is pinned (`usePinnedOrganization`), so every request carries it strictly through `apiFetch`; a non-member sees an explicit error. A link without `?org=` is rewritten to the remembered organization before any read. Every link to the page includes it (dashboard rows, scan header, publication monitor, alert emails).
4. Row: version (links to its review, captioned with created date), baseline via `describeBaseline` ("2.0.0-beta.1 (beta)" / "(previous version)" / "(highest published)" / "no baseline"; rules in [diff-baseline.md](./diff-baseline.md)), release risk, `DecisionState` with who decided, npm state + observation time (Badge only when `registryStatusBadge` tones it), `scanSourceLabel`. Below `sm` rows stack (no sideways scroll): version and date; risk, decision and npm outcome; baseline (`from …`) and source as a caption.
5. `releaseAttention` marks npm-published-undecided (warn fill) and npm-published-but-rejected-here (danger fill). Header mono line: ecosystem, review and channel counts, last release; non-zero disagreements show as one Alert (`describeAttentionCounts`): critical once anything published with a rejection, else warn.
6. The scan header's `all releases →` opens it; its back link returns to the originating list (`getDashboardReturnUrl`).
7. npm, PyPI, VS Code: **Public badge** section (`src/pages/Dashboard/PackageReleases/PublicBadgeSection.tsx`, `GET|PUT /api/v1/packages/:name/badge`): current public answer, which switch has it off, this organization's candidate, README snippet, owner/admin switch for a registry-verified publisher ([public-badge.md](./public-badge.md)).
8. npm: **publication monitor** section (`src/features/publication-monitor/PackagePublicationSection.tsx`, `GET /api/v1/publication-watches/packages/:name`): watch state or why not (never seen public, stopped, gate suggestion, pending, waiting at the 250-watch limit), observed releases with reasons, "not verified" mark, coverage-gap notice, acknowledgment, check/start/stop; then ledger alerts the list omits (latest 50). Shares `ObservationList.tsx`, `CoverageGap.tsx`, `copy.ts` with the card. Stop is disabled with its reason for members, mirroring the server role check.

## Release timeline

`src/pages/Dashboard/ScanDetail/ReleaseTimeline.tsx` closes scan detail for every status: `SectionLabel` (event count in `aside`) over a left-ruled `<ol>`; rows show label, optional muted detail, mono 11px `formatDateTime` stamp (`formatDateTimeExact` on hover), and a mono `+delta`. Rows use `divide-y` (no second rule under the label). Renders nothing when no event has a timestamp. Pure logic: `src/pages/Dashboard/ScanDetail/release-timeline.ts`; wording: [registry-version-status.md](./registry-version-status.md).

## npm access settings

Without a valid connection, the token form and a short generic permissions guide stay visible, with validation failures above the form. A valid connection folds them into a collapsed "Rotate token" disclosure so a pending workspace choice is the only open task. Saved metadata sits in the collapsed "Connection details" disclosure; link to npm's token instructions.

## Large diffs

`DiffView` stays responsive on megabyte-scale bundles (e.g. vite's 1.3 MiB `dist/node/chunks/node.js`).

| Guard | Constant / file | Behavior |
| --- | --- | --- |
| Highlight cap | `HIGHLIGHT_MAX_LINES` (3,000), `HIGHLIGHT_MAX_CHARS` (256 KiB) in `src/components/highlight.ts` | Skip highlighting per side above either cap (note 1). |
| Gap collapse | `GAP_CONTEXT_LINES` (3) in `src/components/diff-hunks.ts` | Two-sided diffs collapse unchanged runs; rows with pinned findings never collapse. |
| Single-sided window | `SINGLE_SIDED_INITIAL_LINES` (1,000) in `src/components/DiffView.tsx` | Initial window with "show more"; findings past it fall back to the banner. |
| Word-diff bailout | `WORD_DIFF_MAX_PAIR_CELLS` (10,000 line-pair combinations) in `src/components/diff-rows.ts` | No word pairing beyond the line-pair budget (avoids quadratic scoring). |
| Line-pair timeout | `LINE_DIFF_TIMEOUT_MS` (1.5s) in `src/components/diff-rows.ts` | Past it both sides render independently via the single-sided window, with a notice (note 2). |

1. 3,000 lines is ~1.7s of main-thread tokenization for bundled JS; the char cap guards minified few-enormous-line samples. The cap applies to the text handed to shiki, after re-flow: shiki cost is per line, and a 128 KiB bundle re-flows to ~5,700 lines (~1.9s per side). The meta row notes "syntax highlighting off (large file)".
2. This avoids both dishonest line pairing and an unbounded DOM commit for tens of thousands of manufactured changed rows. `buildRows` takes the budget as an option so the give-up path is testable.

## Minified files

`src/components/format-source.ts` re-flows minified sides so line diff, hunk collapse, and finding pinning work on `dist/` artifacts (preact `dist/preact.min.js` patch: 2 changed 11 KB lines → 39 changed of 464).

1. Display transform only, client-side. Scan artifacts, report exports, and the AI reviewer see shipped bytes; nothing persisted is reformatted.
2. Inserts whitespace between tokens only; the token stream round-trips (`test/format-source.test.ts`, including fast-check), so the view never shows bytes the artifact lacks. JS/TS breaks only after `;`, `{`, `,` and around `}`; JSON also `[`/`]` and array commas (no ASI sites). No break where the source already ends a line.
3. JS, TS, JSON use `server/lib/platform/js-lexer.ts` (shared with the scanner's constant folder); CSS uses a character scanner (`//` is not a CSS comment). `.cjs`/`.cts` use the Script goal, `.mjs`/`.mts` Module; ambiguous `.js`/`.ts` with contextual `await`/`yield` must agree under both goals or the side fails closed to raw bytes.
4. JSX/TSX and SCSS stay unformatted (whitespace is meaningful). JS/TS samples are checked for JSX fragments and tags before re-flow; JS also uses expression-position opener checks; TS keeps angle-bracket assertions eligible.
5. The CSS scanner decodes escaped identifiers in `url(…)` (e.g. `u\72l(…)`) and keeps the payload opaque across whitespace, newlines, comments, strings, escapes; its invariants (non-whitespace preserved, no blank rows, line map in range) are in `test/format-source.test.ts`.
6. `js-lexer.ts` decides regex vs division by bracket kind (statement `)`/`}` vs value), tracks `await`/`yield` scope through functions, arrows, methods, class fields and static blocks, ASI boundaries, TypeScript declarations, labels and `case` clauses; hashbangs and Annex B HTML-like comments stay opaque; template interpolation uses the same boundaries. Pending bodies use depth-keyed stacks (linear on hostile truncated input); an explicit frame stack avoids call-stack overflow. Pinned both ways by `test/js-lexer.test.ts`.
7. On by default when a side `looksMinified` (any line ≥ `MINIFIED_LINE_CHARS`, 500 chars, in `src/components/format-source.ts`), with a "Reformat" toggle; the "reformatted for review" note appears only when a side actually changed.
8. A two-sided diff never mixes a rejected raw side with a reformatted side: JSX, an oversized sample, an exhausted lexer budget, or a failed token-stream guard on either side keeps both raw. A side with no break points may pair with a reformatted side.
9. Findings re-pin through `remapFindingLines`; a finding lands only on a row from its reported line, otherwise it moves to the banner. The caption always names the artifact's line, never the reformatted row.
10. Findings carry no column, so a match mid-bundle pins to the top of its source line (as precise as the raw view). Recording match offsets server-side would make it exact.

## Change checklist

| If you change | Also |
| --- | --- |
| A route in `src/index.tsx` | Update [At a glance](#at-a-glance); Worker-owned prefixes also need `test/e2e/worker-routes.mjs`. |
| A shared review component | Check all three surfaces (scan detail, `/diff`, public report). |
| A browser-visible flow | Verify with the `verify-live` skill against `pnpm run e2e:dev:seed`; add a mock to `test/e2e/smoke.spec.ts` for new scan-detail fetches. |
| Visual tokens or rules | [design.md](./design.md). |
