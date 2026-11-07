# Commands and tooling

Every `package.json` script, lint rule, and static invariant test in one place. **Authority:** internal. **Owner:** `package.json`, `.oxlintrc.json`, `scripts/verify.mjs`.

`test/prose-command-references.test.mjs` fails if a script is missing from the tables below or a documented `pnpm` command does not exist. Test scope by change type: [release-safety.md](./release-safety.md).

## Stack

| Tool | Role | Config |
| --- | --- | --- |
| [oxlint](https://oxc.rs/docs/guide/usage/linter) v1 | Rust ESLint replacement | `.oxlintrc.json` |
| [oxfmt](https://oxc.rs/docs/guide/usage/formatter) v0 | Rust Prettier replacement (also Markdown, except `docs/**/*.md`: column padding doubled table bytes; `test/docs-shape.test.ts` guards doc shape instead) | `.oxfmtrc.json` |
| [@preact/eslint-plugin-signals](https://github.com/preactjs/signals/blob/main/packages/eslint-plugin-signals/README.md) | Signal rules via oxlint `jsPlugins` (alpha) | `.oxlintrc.json` |
| [@shadcn/lint](https://github.com/shadcn-ui/lint) | Tailwind design-system rules via `jsPlugins` (oxlint >= 1.80) | `.oxlintrc.json` |
| tsrs | Typecheck | `tsconfig.json`, `test/tsconfig.json`, `cli/tsconfig.json` |
| knip | Unused files, exports, dependencies | `tooling/knip.jsonc` |
| Vitest | `node` and `workers` projects | `vitest.config.ts` |
| Playwright | Browser e2e | `playwright.config.ts` |

`@shadcn/lint` reads this repo's own components and the `@theme` tokens in `src/style.css`; shadcn/ui itself is not used.

## Scripts

Always spell lint as `pnpm run lint`: bare `pnpm lint` can collide with workspace forwarding or shell wrappers.

### Checks and tests

| Command | What it does |
| --- | --- |
| `pnpm run lint` | oxlint over the repo; non-zero on errors. |
| `pnpm run lint:fix` | Apply oxlint autofixes. |
| `pnpm run format` | Rewrite files with oxfmt. |
| `pnpm run format:check` | Report files that would change. |
| `pnpm run typecheck` | `tsrs --noEmit` over `src/`, `server/`, `vite.config.ts`, then `tsrs -p test/tsconfig.json --noEmit`, then `tsrs -p cli/tsconfig.json` over the CLI's JSDoc (note 1). |
| `pnpm run knip` | Unused files, exports, dependencies. Part of `verify` and CI. |
| `pnpm run test` | Node (`test/**`) and D1-backed worker (`test/workers/**`) suites as two parallel Vitest processes (note 2). |
| `pnpm run test:node` | `vitest run --project node`. |
| `pnpm run test:workers` | `vitest run --project workers` (Miniflare D1 from `test/config/wrangler.jsonc` + `drizzle/`). |
| `pnpm run verify` | Lint, format check, typecheck, knip, tests **in parallel**; all five finish and every failure is reported. The commit gate. |
| `pnpm run verify:quick` | Iteration loop scoped to changes vs the `origin/main` merge base (note 3). Not the commit gate. |
| `pnpm run verify:file` | After editing one or two files: `--file <path...>` (note 4). No knip. |
| `pnpm run fuzz` | Archive-parser property fuzz (`FUZZ_RUNS=20000`, long timeout). Not in `verify`. |

1. Typecheck covers node, workers, e2e, and agent-tour tests, plus the CLI's checked JavaScript. Vitest only strips types, so this is where test files are typechecked.
2. `scripts/test.mjs` spawns the projects defined in `scripts/lib/vitest-commands.mjs` (shared with `verify`). `pnpm test -- <file>` runs one file; `pnpm test -- --project workers <file>` pins the suite.
3. `verify:quick`: oxlint and oxfmt on changed files (committed, staged, unstaged, untracked), full typecheck (cannot be scoped), whole-graph knip (removing the last import creates the unused export in another file), `vitest run --changed <merge-base>` for both projects. Skipped checks say so.
4. `verify:file`: oxlint and oxfmt on exactly those files, full typecheck, `vitest related` for both projects (a test relates to itself; a Markdown file also runs the prose checks). Faster than `verify:quick` when the change set is wide but the edit is narrow.

### Dev, build, deploy

| Command | What it does |
| --- | --- |
| `pnpm run drydock` | Run the checkout's CLI ([cli/README.md](../cli/README.md)); for example `pnpm run drydock scans list`. Reads reviews; scan access starts reviews; `decide_staged` access plus a fresh authenticator code records staged decisions and can run local npm approval. Workflow-gate decisions require a signed-in maintainer. |
| `pnpm run dev` | Vite + Worker at `http://localhost:5173` against your `.dev.vars`. Credential-free alternative: `pnpm run e2e:dev:seed`. |
| `pnpm run build` | Production build into `dist/`, including `dist/staged_publish_review/wrangler.json` that `deploy` reads. |
| `pnpm run preview` | Serve the last `build` locally. |
| `pnpm run deploy` | `build` then `wrangler deploy` with the generated config. Needs Cloudflare credentials ([self-hosting.md](./self-hosting.md#deploy-checklist)). |
| `pnpm run cf-typegen` | Regenerate `worker-configuration.d.ts` for reference only; declare bindings by hand in `server/env.d.ts`. |

### Database

| Command | What it does |
| --- | --- |
| `pnpm db:generate` | Generate a D1 migration under `drizzle/` from `server/db/schema.ts`. Never hand-write migration SQL. |
| `pnpm run db:migrate:local` | Apply pending migrations to local Miniflare. |
| `pnpm run db:migrate:remote` | Apply pending migrations to production. |
| `pnpm run db:backfill:scan-list-summaries:local` | One-off scan list summary backfill (`scripts/backfill-scan-list-summaries.sql`) for databases migrated before the column. |
| `pnpm run db:backfill:scan-list-summaries:remote` | Same, against production. |
| `pnpm run db:backfill:badge-package-key:local` | One-off `scans.badge_package_key` / `badge_public` backfill (`scripts/backfill-badge-package-key.sql`) (note 5). |
| `pnpm run db:backfill:badge-package-key:remote` | Same, against production. |

5. The badge backfill lets older reviews answer the default-on badge and be recognized as superseded, and withdraws listed badge keys whose manifest name disagrees with npm's. Read its header first: it lists read-only queries that check its assumptions and count what it withdraws.

### E2E and tour

| Command | What it does |
| --- | --- |
| `pnpm run e2e:fixtures` | Pack fixture packages and generate `.context/e2e-registry/registry.json`. |
| `pnpm run e2e:registry` | Start only the fake npm staging registry (`test/e2e/fake-registry.mjs`). |
| `pnpm run e2e:dev` | Fake registry + Vite/Worker dev server. |
| `pnpm run e2e:dev:seed` | `e2e:dev` + `e2e:seed`: the credential-free local path ([e2e-test-environment.md](./e2e-test-environment.md)). |
| `pnpm run e2e:seed` | Seed an already-running app (`scripts/e2e-seed.mjs`): account, registry connection, one scanned fixture. |
| `pnpm run test:e2e` | Playwright against the fake-registry harness. |
| `pnpm run agent:tour` | Product walkthrough into `agent-tour-output/` ([agent-tour.md](./agent-tour.md)). |

### Evals and operations

| Command | What it does |
| --- | --- |
| `pnpm run eval` | Deterministic detection eval over the security corpus ([detection-eval.md](./detection-eval.md)). |
| `pnpm run eval:npm-sweep` | Replay real npm release pairs through production rules for false positives (network-bound, report-only). |
| `pnpm run eval:ai` | Offline AI-review eval on recorded fixtures ([ai-review-eval.md](./ai-review-eval.md)). |
| `pnpm run eval:ai:live` | Paid live AI-review comparison. |
| `pnpm run eval:clef:live` | Paid Clef injection-screen eval. |
| `pnpm run benchmark:incidents` | Regenerate the Shai-Hulud/Nx benchmark; ordinary tests check committed results ([incident-benchmark.md](./incident-benchmark.md)). |
| `pnpm run ops:package-claims -- --query` | Print the read-only package-claim inventory query (note 6). |
| `pnpm run ops:snapshot` | Query production D1 for the ops feedback loop ([ops-snapshot.md](./ops-snapshot.md)). |
| `pnpm incident:post` | Fill incident-post templates and verify the `/diff` link resolves ([incident-content-playbook.md](./incident-content-playbook.md)). |

6. `--input`/`--output` build a private audit outside the repo; explicit `--approvals` generates guarded SQL without executing it; `--assume-public-npm-registry` records an operator-approved assumption for missing historical registry URLs ([package-claims.md](./package-claims.md)).

## Verification and CI

| When | Run |
| --- | --- |
| After editing a file | `pnpm run verify:file <path>` |
| While iterating | `pnpm run verify:quick` |
| Before every commit | `pnpm run verify` (no git hook enforces it) |
| CI | `.github/workflows/ci.yml`: same core checks, then Chromium + `pnpm run test:e2e` |

## Worker-suite performance

Importing the server graph into a fresh workerd isolate costs ~5s per test file (modules fetched one by one over the pool's module-fallback socket). Keep these settings.

| Setting | Where | Invariant |
| --- | --- | --- |
| `isolate: false`, `maxWorkers: 3` | `vitest.config.ts` | Graph imported once per pool worker; raising `maxWorkers` makes the suite slower. |
| Per-file reset | `test/workers/setup.ts` | `beforeAll` wipes D1 tables and R2 objects, then re-applies migrations. |
| `threads` pool for `node` | `vitest.config.ts` | Keeps per-file isolation (files `vi.mock` the same modules) without process spawns. |
| No `main` | `test/config/wrangler.jsonc` | Tests call `worker.fetch(req, env, ctx)` on an imported `server/index`. |
| Native scrypt | `server/lib/auth/index.ts` | Better Auth KDF on `node:crypto` scrypt: same params, byte-identical, ~10x faster. |
| Lazy AI SDK | `server/lib/scan/pipeline.ts` | `await import(...)` only after the `ai-review` check. |

1. A worker test must not assert on state it did not create in its own file; global sweeps (the discovery cron) rely on the per-file reset, which cannot race because a worker runs its files sequentially.
2. **Do not add `main` back** to `test/config/wrangler.jsonc`: Miniflare would evaluate the whole app in every isolate (~5s/file vs ~0.3s). If a test needs `SELF` or a Durable Object, give it a separate project.
3. Native scrypt is pinned by `test/workers/auth-password-hash.test.ts`; the pure-JS fallback runs synchronously in the isolate and slows logins and auth-heavy tests.
4. AI review is on by default and the org `ai-review` flag is a killswitch; the Vercel AI SDK stays out of the Worker boot graph until that check passes.

## Lint rules

All `error` unless noted. Local plugins live in `tooling/oxlint/`; each has a fixture under `test/fixtures/` (excluded via `ignorePatterns`) and a test that runs the real oxlint runtime.

| Rule | Enforces | Plugin | Pinned by |
| --- | --- | --- | --- |
| `no-restricted-imports` | No `useState`/`useReducer`; no `preact/compat` | core | lint |
| `@preact/signals/no-signal-write-in-computed` | No signal writes in computeds | signals | lint |
| `@preact/signals/no-value-after-await` | No `.value` read after `await` (breaks tracking) | signals | lint |
| `@preact/signals/no-signal-in-component-body` | No `signal`/`computed`/`effect` calls in a component body (use hooks) | signals | lint |
| `@preact/signals/no-conditional-value-read` | No `.value` read behind a non-reactive guard | signals | lint |
| `@preact/signals/no-signal-truthiness` | Truthiness on a signal object (`warn`) | signals | lint |
| `signals-local/no-signal-conditional-jsx` | Signal-driven conditional JSX children use `<Show>` | `signals-local/` | `test/oxlint-signal-conditional-jsx.test.mjs` |
| `boundaries-local/no-cross-page-import` | Pages never import another page's directory | `boundaries-local/` | `test/oxlint-cross-page-import.test.mjs` |
| `boundaries-local/no-platform-domain-import` | `server/lib/platform/` imports only platform modules and packages | `boundaries-local/` | `test/oxlint-platform-domain-import.test.mjs` |
| `typescript/no-explicit-any` | No `any`, repo-wide | core | lint |
| `no-console` | Only `emitOperationalEvent` logs in `server/**` | core override | lint |
| `design-local/no-stacked-section-rule` | No second hairline beside a `SectionLabel` | `design-local/` | `test/oxlint-stacked-section-rule.test.mjs` |
| `design-local/no-off-system-color` | Colors come only from `src/style.css` tokens (`src/**`) | `design-local/` | `test/oxlint-design-tokens.test.mjs` |
| `design-local/no-sub-floor-text` | No text under 11px except exactly 10px (`src/**`) | `design-local/` | `test/oxlint-design-tokens.test.mjs` |
| `shadcn/no-restyle` | Caller `class` never overrides what a component owns | shadcn | `test/oxlint-shadcn-restyle.test.mjs` |
| `shadcn/no-unknown-classes` | Every class generates CSS in the installed Tailwind | shadcn | same |
| `shadcn/require-static-classes` | Class values are statically readable | shadcn | same |
| `shadcn/no-inline-styles` | Dynamic geometry goes through a custom property | shadcn | same |
| `shadcn/no-raw-colors` | No raw palette colors; names the nearest token | shadcn | same |
| `react/immutability`, `react/purity`, `react-hooks/exhaustive-deps` | Off | core | — |

### Escape hatches and details

| Rule | Escape hatch / limit |
| --- | --- |
| `no-restricted-imports` | None. Use `useSignal`/`useComputed`/`useSignalEffect` or `createModel`/`useModel`. |
| `signals-local/no-signal-conditional-jsx` | Attribute positions (use `useComputed`) and single derivations (`{format(size.value)}`) pass; member-access signals (`model.count.value`) are not detected, fix by hand. |
| `boundaries-local/no-cross-page-import` | `src/pages/*.tsx` root files are unconstrained; a dynamic import built from a variable is not checked. Shared code goes in `src/features/`. |
| `boundaries-local/no-platform-domain-import` | None, type-only imports included. Take the dependency as an argument or move the module out of platform. |
| `typescript/no-explicit-any` | Use `unknown` and narrow, or a typed fixture builder. |
| `no-console` | `server/lib/platform/observability.ts` is excluded; frontend and scripts unaffected. |
| `design-local/no-stacked-section-rule` | A rule two elements away is a spacing question and is not reported. |
| `design-local/no-off-system-color` | `var(--color-…)`, `white`/`black`, and prose like `#123` pass; server images (OG card) are outside `src/**`. |
| `design-local/no-sub-floor-text` | `calc()`, `var()`, viewport units, keywords are not evaluated; glyph vs label at 10px is a review call. |
| `shadcn/no-restyle` | Per-component contracts in `.oxlintrc.json` (below). |
| `shadcn/require-static-classes` | `src/components/**` excluded (primitives forward `cn(base, className)`). |
| `no-irregular-whitespace` | `off` for `server/lib/tar-parser.js`: its comment carries a real zero-width space as the confusable-path example. |

1. `no-restricted-imports` bans `useState`/`useReducer` from `preact/hooks` and `react`, and `preact/compat` plus subpaths by pattern (it re-exports the React hook surface and adds a second component model).
2. `no-signal-conditional-jsx` flags a ternary or `&&`/`||`/`??` in JSX child position whose condition reads or derives from a signal's `.value` (text children count). Scope-based: catches `useSignal`/`useComputed` locals and `Signal<T>` props. See the [`preact-signals-no-eager-unwrap`](../.claude/skills/preact-signals-no-eager-unwrap/SKILL.md) skill.

   ```tsx
   {
     error.value ? <Alert>{error.value}</Alert> : null;
   } // flagged
   <Show when={error}>{(msg) => <Alert>{msg}</Alert>}</Show>; // ok
   ```

3. Boundary rules resolve relative static imports, re-exports, and literal `import("…")`. The platform rule rejects anything resolving to `server/db/`, `server/routes/`, `server/lib/<domain>/`, or `server/types.ts` (examples: `platform/rate-limit.ts` receives its D1 fallback from `server/lib/rate-limit.ts`; `server/lib/analytics.ts` owns the event schema). Fixtures: `test/fixtures/oxlint-boundaries/`.
4. `no-console` exists because `emitOperationalEvent` is where fields are redacted; a route `console.log` can put a token in logs.
5. `no-stacked-section-rule` reports a `border-t`/`border-b`/`border-y` or `<hr>` on the label itself, its direct wrapper (top for a leading label, bottom for a trailing one), an adjacent JSX sibling on the touching edge, and the wrapper's touching sibling. Only non-zero directional widths count (color utilities draw nothing, all-sides `border` is a box). Logical and conditional siblings are checked per branch; JSX comments do not break adjacency; classes are read from static strings and `cn(...)` args. Fixtures: `test/fixtures/oxlint-design/`.
6. `no-off-system-color` scans every static string and template quasi in `src/**` (so class maps in objects count): Tailwind palette utilities (`text-red-600`, `hover:bg-zinc-100`), raw colors in arbitrary values or color-carrying style values (`bg-[#fafafa]`, `style={{ boxShadow: "0 0 0 1px #e4e4e7" }}`), and saturated severity tokens as text (`text-warn`, `text-ok/80`). Fixtures: `test/fixtures/oxlint-design/src/off-system-color.tsx`, `test/fixtures/oxlint-design/src/tokens-clean.tsx`, and `test/fixtures/oxlint-design/server/card.ts` (must stay unreported).
7. `no-sub-floor-text` reports `text-[…]`, `text-[length:…]`, `[font-size:…]` under 11px other than exactly 10px, with or without `/leading` or important, plus `text-xs` (10.5px on the 14px root). Units are case-insensitive; `rem`/`em`/`%` convert at 14px, absolute units at 96px/in. Fixture: `test/fixtures/oxlint-design/src/sub-floor-text.tsx`.
8. `@shadcn/lint` resolves a JSX tag to its defining file, reads its props and variants, and treats Preact `class` like `className`. Components are recognized by import path via `settings.shadcn.componentImports`: `(^|/)components/[A-Z]` (pages, features) and `^\./[A-Z]` (sibling primitives), since there is no `components.json` or `@/` alias. `src/style.css` is the only stylesheet importing Tailwind, so the theme is found automatically.
9. `no-restyle` contracts: `Muted` leaves typography and spacing to the caller; `CloseButton` leaves typography; `Menu` has no `class` prop (its `triggerClass`/`panelClass` are the declared hatches); `Card`, `SettingsCard`, `PageShell` allow `gap-*` but not padding (use `padding`; a caller `p-*` collides in a plain `cn` join). See [design.md](./design.md#components).
10. `no-unknown-classes` fails `rounded-huge` and `hovr:flex` and keeps `w-(--segment-width)` honest. `no-inline-styles` wants `style={{ "--segment-width": … }}` plus `w-(--segment-width)` (Preact sets it via `setProperty` and renders it verbatim server-side). `no-raw-colors` is a second net under `no-off-system-color`.
11. `shadcn/no-arbitrary-values` is deliberately off: the type and tracking scale is arbitrary px (`text-[13px]`, `tracking-[0.1em]`) at ~730 sites; enabling it means moving that scale into `@theme`, a design decision.
12. `react/immutability` and `react/purity` (in `correctness` since oxlint 1.83) encode React's hook model: `immutability` flags every `count.value = 1` (155 sites), `purity` flags `useSignal(Date.now())`. No signals-safe narrowing exists.
13. `test/oxlint-shadcn-restyle.test.mjs` also fails if a JS plugin silently fails to load (oxlint exits 0 when one does). Fixture: `test/fixtures/oxlint-shadcn/`.

## Signal unboxing

Passing a signal through props, context, or a model does not subscribe; `.value` subscribes the current reactive scope. Unbox as late as correctness allows.

| Context | Result |
| --- | --- |
| Component render reads `signal.value` | Component rerenders on change. |
| `computed()` / `useComputed()` reads `.value` | Computed recomputes. |
| `effect()` / `useSignalEffect()` reads `.value` | Effect reruns. |
| JSX text renders `{signal}` | Text node updates without rerender. |
| DOM prop receives `{signal}` | DOM property updates without rerender. |
| Component prop or context carries `signal` | No subscription until a consumer unboxes or renders it. |

Pass `Signal<T>` to leaves, utilities, and context consumers. Read `.value` earlier only to branch, derive, run an effect, validate, or hand a snapshot to an API that cannot take a signal. A signal holds one value; a model holds state plus the writes that touch it (`loading + error + items + load()`).

## Invariant tests

Node tests pinning boundaries lint cannot express. Those marked (lexer) first blank comments, strings, and regexes via `test/helpers/sanitized-source.mjs`.

| Test | Pins |
| --- | --- |
| `test/ecosystem-branching-invariants.test.mjs` (lexer) | Routes and orchestrators never branch on ecosystem-name literals. |
| `test/sandbox-boundary-invariants.test.mjs` (lexer) | Sandbox config keys allowlisted; no credential lexemes; no execution primitives in parsing/review. |
| `test/api-auth-boundary-invariants.test.mjs` | Exact registrations allowed above the `/api/*` session guard. |
| `test/agent-context-budget.test.mjs` | Agent-file character ceilings; every `docs/` file reachable from `docs/README.md`. |
| `test/rate-limit-boundary-invariants.test.mjs` | `server/lib/platform/rate-limit.ts` is the only rate limiter. |
| `test/migration-integrity.test.mjs` | Migration indexes, journal, and snapshots agree. |
| `test/prose-path-references.test.mjs` | Every backticked repo path in prose and comments exists. |
| `test/prose-command-references.test.mjs` | Every `pnpm` command exists; every script is documented here. |
| `test/env-binding-parity.test.mjs` | Bindings agree across configs and `server/env.d.ts`. |
| `test/dev-server-route-parity.test.mjs` | e2e harness routes every Worker-owned prefix. |
| `test/bounded-read-deadline-invariants.test.mjs` | Every remote body read names a `deadlineMs`. |
| `test/sandbox-sample-retention-invariants.test.mjs` | Only allowlisted files originate a per-file text-sample cap. |
| `test/test-helper-invariants.test.mjs` | Worker fixtures (e.g. `seedUser`) come from shared helpers. |

1. Ecosystem branching covers `server/routes/`, `server/lib/scan/`, `server/lib/public-diff/`, `server/lib/workflow-gates/`; ecosystems arrive via `server/lib/ecosystems/`; justified branches are in the test's allowlist.
2. API auth: Hono runs handlers in registration order, so a route above `app.use("/api/*")` in `server/index.ts` ships anonymous, and an `app.use()` that returns without `next()` does the same. The test pins the real `getAuthSession` guard and every registration above it (including catch-alls and non-API bootstrap routes), blanks commented-out code, and checks no other `server/` module registers an absolute `/api` path.
3. Context budget: 6,000 characters combined for AGENTS.md + CLAUDE.md, 8,000 per SKILL.md, 200 per skill description; an unlinked doc goes stale unread.
4. Rate limits: nothing else names a `RATE_LIMIT_*` binding or queries `rate_limits`; `NATIVE_TIERS` matches `wrangler.jsonc` `ratelimits` and `server/env.d.ts` (a tier missing in one place silently degrades to D1). It walks the filesystem, so an untracked limiter fails `verify`.
5. Migrations: unique file indexes, dense ordered journal whose tags carry their own index, journal and `.sql` set agree, one snapshot per entry. Concurrent branches collide on indexes and git merges it silently; a migration missing from the journal never runs.
6. Prose paths: AGENTS.md, `docs/`, `.claude/skills/`, and source comments (via the JS lexer); tracked plus non-ignored untracked files. Any root resolving to exactly one file works; Markdown and comment paths may be relative to their file. Non-repo paths are in the test's exception list.
7. Prose commands: built-ins, `node_modules/.bin` binaries (`pnpm wrangler …`), and fixtures under `test/` are skipped.
8. Env parity: `wrangler.jsonc`, `docs/examples/wrangler.self-host.jsonc`, `test/config/wrangler.jsonc`, and the e2e dev server all declare only what `server/env.d.ts` declares (typecheck uses that file, not `cf-typegen`); the self-host template declares exactly the production set; every required `Env` member is a production binding, var, or listed secret.
9. Route parity: `test/e2e/worker-routes.mjs` covers every `SERVER_OWNED_PATH_PREFIXES` prefix (`server/middleware/canonical-host.ts`) with its wildcard; `wrangler.jsonc` and the self-host template keep `run_worker_first: true`. A missing prefix gets Vite's SPA `200` and the handler never runs.
10. Deadlines: a byte cap alone lets a trickling body run unbounded once headers arrive; exceptions are recorded deliberately in the test.

## Agent hooks

Harness-agnostic scripts; each takes the file as `argv[2]` or hook JSON on stdin (Claude Code `tool_input.file_path`, Codex `apply_patch` envelope). Wired in `.claude/settings.json` (PreToolUse/PostToolUse on `Edit|Write`) and `.codex/hooks.json` (trust project hooks once via `/hooks`). Tests: `test/agent-hooks.test.mjs`.

| Hook | When | Does | Fails |
| --- | --- | --- | --- |
| `scripts/hooks/post-edit-check.mjs` | After Edit/Write | `oxfmt --check` + `oxlint` on the file; exit 2 on violations. Never executes the file. | Open (exit 0) |
| `scripts/hooks/guard-protected-paths.mjs` | Before Edit/Write | Blocks (exit 2) `drizzle/**/*.sql` and `drizzle/meta/**`. | Open unless clearly matched |

1. The post-edit hook is report-only: rewriting the file would invalidate the harness's file-state tracking. `pnpm run verify` stays authoritative.
2. Migrations are generated with `pnpm db:generate` (Bash, unaffected by the guard).

## Agent files

| File | Holds |
| --- | --- |
| `AGENTS.md` (imported by `CLAUDE.md`) | Durable trust boundaries, ownership constraints, context routing. |
| `.claude/skills/` (also `.agents/skills`) | Task-specific contracts and evidence requirements. |

1. Describe capabilities conditionally; never pin model names or assume every runtime has the same tools.
2. The [super-agent](../.claude/skills/super-agent/SKILL.md) skill is the execution model for complex work; small tasks need no planning ceremony.
3. State outcome, non-obvious facts, and completion evidence; prescribe order only when it protects a boundary (triage before edits, inspect remote divergence before a push). No generic tutorials, repeated checklists, or anecdotes.
4. Lint and invariant tests own mechanically enforceable detail; prose keeps rationale or routing that changes a decision or protects a trust boundary. Context ceilings are maintenance budgets, not targets.
5. [pre-pr](../.claude/skills/pre-pr/SKILL.md) owns review triage, parity fixes, the adversarial fix review, and the stopping rule; dispositions go in `.context/review-log.md`; earlier P1/P2 resolve before P3 polish. Remote actions follow the user's session authorization.

## Shared helpers

| Helper | File | Use for |
| --- | --- | --- |
| `apiFetch` | `src/models/api.ts` | Same-origin JSON with active-organization headers and `ApiError`. |
| `apiJson` | `src/models/api.ts` | JSON bodies without repeated `content-type` / `JSON.stringify`. |
| `errorMessage` | `src/models/api.ts` | Caught errors into a signal in model actions. |
| `rateLimitResponse` | `server/lib/platform/http.ts` | 429 JSON with consistent `retryAfterSeconds` and `retry-after`. |
| `errorMessage` | `server/lib/platform/errors.ts` | Server error strings; keeps `message` from RPC-serialized errors. |

## Related skills

| Skill | Use for |
| --- | --- |
| [`shared-primitives`](../.claude/skills/shared-primitives/SKILL.md) | Ownership, contracts, naming, tests for shared helpers. |
| [`split-large-module`](../.claude/skills/split-large-module/SKILL.md) | Responsibility seams; proof declarations, routes, init survive. |
| [`preact-signals-preact-integration`](../.claude/skills/preact-signals-preact-integration/SKILL.md) | Component ownership, props/context, subscriptions. |
| [`preact-signals-models-utils`](../.claude/skills/preact-signals-models-utils/SKILL.md) | Model actions, constructor inputs, async state, lifetime. |
| [`preact-signals-eslint-plugin`](../.claude/skills/preact-signals-eslint-plugin/SKILL.md) | Diagnosing or changing Signals lint. |
| [`preact-signals-no-eager-unwrap`](../.claude/skills/preact-signals-no-eager-unwrap/SKILL.md) | JSX refactors with `Show`, bindings, computeds. |

## Change checklist

| If you add or change | Also |
| --- | --- |
| A `package.json` script | Add a row under [Scripts](#scripts). |
| A Cloudflare binding | `server/env.d.ts`, both Wrangler configs, [self-hosting.md](./self-hosting.md#bindings). |
| A lint rule or local plugin | Fixture + test under `test/`, a row in [Lint rules](#lint-rules), the fixture in `ignorePatterns`. |
| A static invariant test | A row in [Invariant tests](#invariant-tests). |
