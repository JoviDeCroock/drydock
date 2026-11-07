# Dependency PR diff links

Renovate and Dependabot updates link to anonymous package diffs and can post release summaries in one PR comment. **Authority:** advisory. **Owner:** `.github/workflows/drydock-diff-link.yml`.

## At a glance

| Thing | Owner file | Who may call / trigger | Pinned by (test) |
| --- | --- | --- | --- |
| Renovate PR-body column | `renovate/diff-links.json` | Repositories extending the public preset | No dedicated preset test |
| PR summary comment | `.github/workflows/drydock-diff-link.yml` | Dependabot and Renovate PR events | `test/dependency-pr-diff-workflow.test.ts` |
| Repository caller | `.github/workflows/dependency-pr-diff.yml` | `pull_request_target`: `opened`, `synchronize` | `test/dependency-pr-diff-workflow.test.ts` |
| Copyable Docs caller | `src/pages/Docs/dependency-pr-workflow.ts` | Docs page users | `test/dependency-pr-diff-workflow.test.ts` |
| Published workflow commit | `scripts/lib/workflow-ref.mjs` | Build | `test/dependency-pr-diff-workflow.test.ts` |
| Anonymous diff | `server/routes/public-diff.ts` | No account or token | [Public diff](./public-diff.md), [security model](./security-model.md) |

## Contract

### Links and setup

| Surface | Contract |
| --- | --- |
| npm link | `/diff/<name>/<from>/<to>`; derived without an API call; `src/lib/package-diff-path.ts` |
| PyPI link | `/diff/pypi/<project>/<from>/<to>`; derived without an API call; `src/lib/package-diff-path.ts` |
| Preset reference | `github>JoviDeCroock/drydock//renovate/diff-links` resolves `renovate/diff-links.json` on the public repository's default branch |
| Preset compatibility | Public contract: additive changes only; never rename or move the file; failed resolution raises Renovate `CONFIG_VALIDATION` and stops all downstream repository updates |
| Caller reference | `JoviDeCroock/drydock/.github/workflows/drydock-diff-link.yml@<sha>`; no Drydock-owned action |
| Published SHA | Last commit touching the reusable workflow, not `HEAD`; adopters copy a new hash to update |
| Caller grants | `contents: read` for lockfiles/config; `pull-requests: write` for the comment; Dependabot runs honor workflow permissions; called workflows can only narrow caller grants |
| Caller event | `pull_request_target` runs caller, reusable workflow, and pinned actions from the base branch; workflow edits take effect after merge and are not exercised against themselves |
| Authors | Job `if:` accepts GitHub's PR author `dependabot[bot]` or `renovate[bot]`; self-hosted Renovate requires its login added to that condition |
| Request | `GET /api/public/v1/package-diff?ecosystem=npm&package=lodash&from=4.17.20&to=4.17.21`; no credentials |
| Links-only input | `with: summaries: false` posts links and sends nothing to Drydock |

List the preset after base presets:

```json
{ "extends": ["config:recommended", "github>JoviDeCroock/drydock//renovate/diff-links"] }
```

### Renovate column

| Input / mechanism | Result / requirement |
| --- | --- |
| `packageRules.matchDatasources` | Only `npm` and `pypi` receive the column; other public-diff ecosystems do not |
| `prBodyColumns` | Non-mergeable array; last matching rule wins; preserve defaults plus `Age`, `Confidence`, `OpenSSF`, `Drydock` |
| Merge-confidence / OpenSSF presets | Superset preserves populated columns; Renovate drops empty columns; listing base presets later can erase `Drydock` |
| Package identity | Use `packageName`, never `depName`; npm aliases and normalized PyPI names must link the installed package |
| Missing `currentVersion` or `newVersion` | No link, including digest and some lockfile-only updates |
| Identical versions | No link for pin updates; the public-diff API rejects identical pairs |
| `newName` present | No link for a replacement whose new version belongs to another package |
| Triple-stash URL templates | Upstream convention; Renovate's `noEscape` makes this stylistic |
| PR rendering | Plain Markdown links; no Drydock request until clicked; changing the column to badge images requires revisiting per-view traffic |

### Version sources

| Bot / shape | Version evidence | Exclusions / trust boundary |
| --- | --- | --- |
| Dependabot single | `fetch-metadata` outputs `previous-version` / `new-version`; `npm_and_yarn` and `bun` map to npm, `pip` and `uv` to PyPI | Unsupported ecosystems yield no pairs |
| Dependabot grouped | Comma in `dependency-names`; first commit's exact ``Updates `name` from A to B`` lines | Do not use `updated-dependencies-json`: its preferred `dependency-version` metadata can lag a revised group's manifest; single updates lack `Updates` lines |
| Dependabot verification | `dependabot/fetch-metadata` must run before parsing; it fails unless the first commit is an authentic, signed Dependabot commit | Never reorder parsing ahead of verification |
| Renovate | Changed lockfiles through the GitHub API, parsed at merge base and PR head using `repos.getContent` | Never parse PR title, body, branch, or commit text; upstream release notes can forge apparent pairs |
| Renovate before side | Merge base, not current base-branch tip | Base-branch commits made after PR creation must not appear as bumps |
| Renovate head | Head repository must equal caller repository | Cross-repository heads are skipped |
| Pair validation | Strict ecosystem name/version patterns; two distinct versions of the same package; deduplicate pairs | Invalid, missing, equal-version, or replacement pairs produce no link |

### Renovate lockfiles

Only direct dependencies count; transitive churn is excluded. Added/removed lockfiles are skipped; renamed files use their previous path for the before side.

| Lockfile | Direct-dependency resolution | Skips |
| --- | --- | --- |
| `package-lock.json`, `npm-shrinkwrap.json` v2/v3 | Each importer's dependency declarations through its `node_modules` path; npm aliases resolve to the real package | v1 lacks direct-dependency markings; entries with non-public-registry `resolved` URLs |
| `pnpm-lock.yaml` v5–v9 | Importers or single-project top-level dependency sections; strip peer suffixes; resolve aliases | `link:`, `file:`, git references |
| `yarn.lock` v1 / Berry | Adjacent `package.json` direct dependencies matched by descriptor; aliases resolve to the real package | v1 `resolved` URLs outside public registries |
| `uv.lock` | pypi.org packages directly required by a workspace member | Duplicate name entries / marker-split resolutions |
| `requirements*.txt`, `requirements/*.txt` | Exact `==` pins | A name pinned twice in one file; any file with `-i`, `--index-url`, or `--extra-index-url` |
| Other files | No comment without a supported changed lockfile | `poetry.lock`, `bun.lock`, `Pipfile.lock`, or absent lockfile; preset links still work |

### Registry and privacy filters

The request discloses each package name and version pair. A private package sharing a public name would otherwise get the public package's summary.

| Evidence | Behavior |
| --- | --- |
| `.npmrc` `registry=` or `@scope:registry=`; `.yarnrc.yml` `npmRegistryServer` at top level or under `npmScopes` | Both bots read committed PR-head config beside the lockfile (Dependabot's updated `directory`) and at repository root |
| Custom default npm registry | Drop every npm pair, including its link |
| Flow-style `npmScopes` | Drop every npm pair |
| Custom npm scope registry | Drop that scope's pairs |
| Public npm registries | `PUBLIC_NPM` / `NPM_REGISTRY_TARBALL` in `.github/workflows/drydock-diff-link.yml` recognize npmjs.org and yarnpkg.com registry hosts |
| Unreadable Dependabot commit or registry config | Post nothing rather than guess |
| npm lockfile source | Drop non-public-registry `package-lock.json` and yarn v1 resolved entries |
| PyPI source | Renovate requirements index directives suppress the file; `uv.lock` accepts pypi.org only |
| Invisible config | Environment variables, CI-only config, user-level `.npmrc`, `pip.conf`, Dependabot `registries:` are not observed; Dependabot pip/uv pairs are sent as given |
| Confidential private names | Set `with: summaries: false`; an unknown public name otherwise answers `404` |

### Comment content and limits

All workflow constants below are in `.github/workflows/drydock-diff-link.yml`.

| Field / constant | Contract |
| --- | --- |
| Summary | Release risk; files added, removed, modified; new/changed install scripts; new dependencies, native binaries, and `bin` commands |
| Findings | Only `releaseDelta === true`; severity-ordered, with severity, rule ID, file, reason, and remaining count; context findings are excluded |
| Single update | One full summary, or link with summary failure reason |
| Group ordering | Summarize first pairs, then sort notable summaries by risk and highest finding severity; findings, flags, or risk above `low` need reading |
| Group unavailable | One `Summary unavailable (<reason>):` line per reason with all affected links |
| Group clean | One `No release findings:` line listing clean bump links |
| Group overflow | Bare links in collapsed `N more updates without a summary (10 per run)` block; `MAX_SUMMARIES` controls that count |
| `MAX_SUMMARIES` | At most 10 summary requests per run, one per pair, sequential |
| `MAX_ENTRIES` | At most 50 entries; count the remainder |
| `MAX_FINDINGS` | At most three rendered findings per entry |
| `MAX_LOCKFILES` | Read at most 20 supported changed lockfiles |
| `REQUEST_TIMEOUT_MS` | 30-second timeout per request |
| `RUN_BUDGET_MS` | 150-second budget checked before starting each request; an in-flight request can finish after the deadline |
| `MAX_RESPONSE_CHARS` | Reject summary response text above 32 × 1024 × 1024 characters |
| `MAX_COMMENT_CHARS` | 60,000-character hard cap below GitHub's 65,536 limit; close an open details block when truncating |
| `code()` limits | File paths: 120 characters; reasons: 200 characters; fields are truncated |
| `code()` escaping | Package names, rule IDs, file paths, reasons in code spans; fence longer than every internal backtick run; collapse control, bidi, zero-width characters and newlines to spaces |
| Risk / severity / rule IDs | Only known risk/severity values; `RULE_ID` shape required for IDs; package names and versions validated before URL/comment use |
| Upsert | `MARKER` = `<!-- drydock:diff-link -->`; only `github-actions[bot]` comments qualify, since anyone can paste the marker |
| Concurrency | Per-PR `drydock-diff-link-…` group with cancellation prevents overlapping read-then-write duplicates |

### Requests and caches

| Operation | Contract |
| --- | --- |
| Trigger frequency | Once per PR `opened` / `synchronize`, never per page view |
| Public pair budget | `enforcePublicRateLimit` in `server/routes/public-diff.ts` allows 10 cold computations/minute/client IP in the `fetch` bucket; cached pairs are read before this charge |
| Shared egress | Concurrent runs behind one NAT can receive `429`; first `429` stops later fetches and preserves links |
| Cache | Versioned colo/KV result cache; rebases can reuse pairs; cold computation uses browser sandbox caps; simultaneous cold requests can each compute |
| Persistence | No credentials or D1 access; route writes only its existing browser result cache |
| Analytics | `x-drydock-client: dependency-pr` labels `public_diff.viewed`'s `client` dimension; self-reported label changes no authority; see [analytics](./product-analytics.md) |

## Invariants

1. Never check out or execute PR code; read lockfiles/config as data through the API (`.github/workflows/drydock-diff-link.yml`).
2. Keep inline logic in the reusable workflow: called workflows run in the caller's repository, where this repository's scripts are absent; a vendored workflow must work alone (`test/dependency-pr-diff-workflow.test.ts`).
3. Preserve action commit pins and Dependabot verification ordering; `pull_request_target` prevents action-bump PRs from running their unreviewed versions with write access (`test/dependency-pr-diff-workflow.test.ts`).
4. Preserve one transformed Docs caller: `src/pages/Docs/dependency-pr-workflow.ts` imports the repository caller and changes only local `uses:` to the published SHA reference (`test/dependency-pr-diff-workflow.test.ts`).
5. Deploy from `main`; building an unmerged branch with a changed workflow can publish that branch's commit as the Docs reference (`scripts/lib/workflow-ref.mjs`).
6. A Drydock API failure never fails the job; preserve the link and label the failure (`test/dependency-pr-diff-workflow.test.ts`).

## Failure modes

| Symptom / condition | Cause | What happens | Fix |
| --- | --- | --- | --- |
| Renovate stops all updates | Preset resolution fails | `CONFIG_VALIDATION` | Restore the public preset path; never move it |
| Column disappears | A later matching `prBodyColumns` rule wins | No `Drydock` column | Extend this preset after base presets |
| Self-hosted Renovate has no comment | Login absent from job `if:` | Job skipped | Add its authenticated PR-author login |
| No comment | No valid pair, unsupported lockfile, cross-repository head, or unreadable Dependabot config | No post | Check version-source and registry tables |
| Summary unavailable | HTTP failure, `429`, timeout, fetch exception, oversized or unreadable response | Link retained with `HTTP <status>`, `rate limited`, `timed out`, `request failed`, `response too large`, or `unreadable response` | Retry on a later PR event; inspect public-diff availability |
| Summary budget exhausted | Time or pair cap reached | Later links remain; no extra requests | Inspect links directly or disable summaries |
| Wrong public package for a private name | Registry configured outside committed files | Public namesake can resolve | Set `with: summaries: false` if names are confidential |

## Change checklist

| If you change X | Also update Y | Run Z |
| --- | --- | --- |
| Preset templates, columns, or guards | Preserve public path, aliases, ecosystem guards, preset order | `pnpm run verify:file docs/dependency-pr-diff-links.md`; inspect rendered preset links |
| Version parsing, registry filters, comments, limits, or workflow grants | Repository caller, generated Docs snippet, this contract | `pnpm exec vitest run --project node test/dependency-pr-diff-workflow.test.ts` |
| Anonymous requests / analytics | [Public diff](./public-diff.md), [security model](./security-model.md), [analytics](./product-analytics.md) | Relevant route tests and workflow tests |
| This document | Keep the public filename; workflow and README link it | `pnpm run verify:file docs/dependency-pr-diff-links.md` |
