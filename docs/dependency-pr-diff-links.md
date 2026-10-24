# Diff links in dependency update PRs

Renovate and Dependabot PRs say "bump `lodash` 4.17.20 → 4.17.21" without showing
what changed in the published packages. Drydock's anonymous `/diff` pages take a
fully derivable URL — `/diff/<name>/<from>/<to>` for npm,
`/diff/pypi/<project>/<from>/<to>` for PyPI (see `src/lib/package-diff-path.ts`)
— so a dependency-update PR can link its own diff with no account, token, or API
call. This is a consumer-side distribution surface: it puts "Read the diff" in
front of reviewers at the moment they are deciding whether to merge a bump.

The PR comment workflow goes one step further and puts the diff itself in the
PR: for each bumped npm or PyPI dependency, Drydock's headline (release risk;
files added, removed, and changed; new install scripts, dependencies, and native
binaries) and the top release findings with their rule ids, next to the link.
Review already happens in the PR, so that is where the diff should be.

The user-facing setup instructions live on the Docs page
(`src/pages/Docs/index.tsx`, "Diffs in dependency PRs"). This file documents the
contracts and the operational posture.

## Renovate preset (`renovate/diff-links.json`)

Third-party repositories reference the preset by path, after their base presets:

```json
{ "extends": ["config:recommended", "github>JoviDeCroock/drydock//renovate/diff-links"] }
```

**The file path is a public contract.** Renovate resolves
`github>JoviDeCroock/drydock//renovate/diff-links` to
`renovate/diff-links.json` on the default branch of this (public) repository.
A failed preset resolution is not a soft miss: Renovate raises a
`CONFIG_VALIDATION` error and stops processing the downstream repository
entirely — adopters lose all updates, not just the column — so treat the path
like a published API: additive changes only, never rename or move the file.

Shape notes, so edits keep the links correct:

- The column is added via `packageRules` scoped with `matchDatasources`, the
  same mechanism as Renovate's built-in `security:openssf-scorecard` preset.
  Only `npm` and `pypi` get a column — those are the ecosystems `/diff` serves.
- `prBodyColumns` is a non-mergeable array where the last matching packageRule
  wins, so the preset lists a superset: Renovate's defaults plus the
  `mergeConfidence:*` (`Age`, `Confidence`) and `security:openssf-scorecard`
  (`OpenSSF`) columns plus `Drydock`. Renovate drops columns that end up empty,
  so each repo renders only the columns its other presets actually populate.
  Without the superset, this preset would silently erase the merge-confidence
  badges for every `config:recommended` adopter. The extends order in the
  snippet matters for the same reason: listed first, a base preset's own
  `prBodyColumns` rule would win and drop the `Drydock` column instead.
- `packageName`, not `depName`: for npm alias specs (`npm:real-pkg@1.2.3`) and
  normalized PyPI names, `packageName` is the package actually being installed;
  `depName` is what the manifest calls it. Linking `depName` could present a
  same-named squatter's diff for an aliased dependency.
- The guards drop the link whenever the pair is not two distinct published
  versions of the same package: missing `currentVersion`/`newVersion` (digest
  and some lockfile-only updates), `currentVersion` equal to `newVersion` (pin
  updates — the public-diff API rejects identical pairs), and `newName` present
  (replacement updates, where `packageName`/`currentVersion` describe the old
  package but `newVersion` belongs to the replacement). No link is safer than a
  confidently wrong one, matching `dependencyDiffHref` in the app.
- Triple-stash (`{{{…}}}`) follows upstream preset convention for URLs; Renovate
  compiles templates with `noEscape`, so it is stylistic, not load-bearing.

## PR comment workflow (Dependabot and Renovate)

Dependabot has no PR-body templating, and a Renovate PR body is rendered by
Renovate without any chance to fetch. The documented path for both is the
reusable workflow `.github/workflows/drydock-diff-link.yml`:
`dependabot/fetch-metadata` for Dependabot PRs, then one `actions/github-script`
step that derives the version pairs, fetches each pair's summary from the public
diff API, and upserts one comment. Adopters paste a ~20-line caller from the Docs
page that references it at `JoviDeCroock/drydock/...@<sha>`; there is still no
Drydock-owned action. The hash is the last commit that changed the reusable
workflow, so adopters run exactly the version they copied with
`pull-requests: write`, and pick up changes by copying a new hash. The caller's trigger is
`pull_request_target`; a called workflow runs under its caller's event, so
GitHub runs the caller, this workflow, and the action commits it pins as they
are on the base branch. Under `pull_request`, the
file came from the PR's merge ref. Dependabot and Renovate both bump GitHub
Actions, so a PR that bumped `fetch-metadata` or `github-script` would have run
the bumped, unreviewed action with write access. `pull_request_target` is also
what the `dependabot/fetch-metadata` README recommends for write access.
`pull_request_target`'s usual hazard is checking out and running the PR head
with the base repository's token. This workflow never checks out or executes PR
code. It reads PR lockfiles as data through the API, so granting
`pull-requests: write` to the run is safe. `contents: read` is the only other
scope, for those lockfile and registry-config reads. Dependabot-triggered runs
honor the workflow-level `permissions` key (GitHub changelog 2022-02-10), and a
called workflow can only narrow what its caller grants. The
cost is that a change to the workflow itself takes effect only after it merges,
so a PR editing the file is not exercised against itself.

The job runs only for PRs whose author is `dependabot[bot]` or `renovate[bot]`.
That login is GitHub's own record of who opened the PR, not something a fork
can claim, which matters because `pull_request_target` also fires for fork PRs. Self-hosted Renovate opens PRs under its own account, so it needs
that login added to the `if:`.

For Dependabot PRs, `fetch-metadata` runs first for its own sake, not only for
its outputs: it fails the job unless the PR's first commit is an authentic,
signed Dependabot commit. That verification is what makes it safe for the next
step to parse that commit message, so nothing may be reordered ahead of it.

### Grouped PRs and where the versions come from

Grouped updates are Dependabot's recommended default and, for a repository that
groups by dependency type, they are effectively every PR — so a workflow that
handles only single-dependency PRs never fires. The group is the case that
matters most anyway: eight bumps in one PR is exactly where a reviewer wants
eight diffs.

The version pair is read from a different place per shape, and the reason is
subtle enough to state outright:

- **Single-dependency PRs** use the action's `previous-version`/`new-version`
  outputs.
- **Grouped PRs** are detected by a comma in `dependency-names` (the action
  joins every updated dependency into that one output) and are parsed from the
  ``Updates `name` from A to B`` lines in the commit message. Dependabot emits
  those lines only when a PR updates more than one dependency, which is why the
  single-dependency path cannot use them.

Grouped PRs do not use the action's own per-dependency output
(`updated-dependencies-json`) even though one exists, because the action fills
each entry's new version from the commit's `dependency-version` metadata in
preference to the `Updates` line, and that metadata can lag the version the PR
actually merges once Dependabot revises a group. Observed on this repository's
PR #589: the metadata claimed `@cloudflare/vite-plugin` 1.51.2 and `knip` 6.32.1
while the manifest in the same PR moved to 1.52.1 and 6.32.2. Both stale values
are real published releases, so the links would have resolved — to a range the
PR does not merge. The `Updates` lines matched the manifest for all eight.
No link beats a confidently wrong one, the same rule the Renovate guards follow.

Because a grouped PR is rewritten in place as its contents change, the workflow
triggers on `synchronize` as well as `opened` and upserts one comment keyed by a
`<!-- drydock:diff-link -->` marker, rather than stacking a new comment under
each stale one — the same marker convention
`scripts/comment-detection-eval.mjs` uses for its PR comment. Only a comment
written by `github-actions[bot]` is a candidate, since anyone can paste the
marker into their own comment. A per-PR `concurrency` group keeps two quick
pushes from racing the read-then-write into duplicate comments.

### Renovate PRs and where the versions come from

Renovate has nothing like Dependabot's signed commit. Its PR title, body, branch
name, and commit message are unauthenticated text, and the body embeds upstream
release notes, so a hostile package's changelog could write a lookalike
`from → to` row or a Drydock link to a benign pair. The workflow reads none of
them. It lists the PR's changed files through the API and, for each supported
lockfile, reads the file at the merge base and at the head with
`repos.getContent`, parses both as data, and reports each direct dependency
whose resolved version changed. Those are the versions the PR merges. The merge
base, not the base branch tip, is the "before" side, so commits that landed on
the base branch after the PR was opened don't show up as bumps. Whoever can
write those lockfile bytes can already push to the repository and edit any
workflow, so reading them adds no trust. An upstream author controls only its
own package's name and version, and both must pass the same strict name and
version check before they reach a URL or the comment.

Supported lockfiles, all for direct dependencies only (transitive churn is not a
bump the PR names):

- `package-lock.json` / `npm-shrinkwrap.json` v2 and v3: each importer's
  declared dependencies, resolved through its `node_modules` path. Aliases
  (`npm:real@^1`) report the real package. Entries resolved from anywhere but
  the public registry are skipped. v1 does not mark direct dependencies.
- `pnpm-lock.yaml` v5 through v9: the `importers` (or single-project top-level)
  dependency sections, with peer suffixes stripped and aliases resolved;
  `link:`, `file:`, and git references are skipped.
- `yarn.lock` v1 and Berry: the direct dependencies of the `package.json` beside
  it, looked up by descriptor. A v1 entry whose `resolved` URL is not the public
  registry is skipped.
- `uv.lock`: pypi.org packages a workspace member depends on directly. A name
  with two entries (a marker-split resolution) is skipped.
- `requirements*.txt` and `requirements/*.txt`: exact `==` pins. A name pinned
  twice in one file is skipped.

Renovate PRs that change no supported lockfile (`poetry.lock`, `bun.lock`,
`Pipfile.lock`, or no lockfile) get no comment. The preset column above still
links them. A PR whose head branch lives in another repository is skipped.

### What the comment says

Each entry is the existing link plus, when the summary fetch succeeds, the
release risk, file counts, a flags line (new or changed install scripts, new
dependencies, new native binaries, new `bin` commands), and up to three release
findings by severity (severity, rule id, file, reason), with a count of the rest.
Context findings, which describe code the previous release already shipped,
are left out.

Every string from the API describes a package someone else published, so it is
untrusted. Package names, rule ids, file paths, and finding reasons render
inside code spans, which GitHub never turns into links, mentions, images, or
HTML. The fence is always longer than any backtick run in the text. Control,
bidi, and zero-width characters and newlines collapse to spaces, and each field
is truncated (paths at 120 characters, reasons at 200). Severity and risk render
only when they are one of the known values, and a rule id only when it matches
the rule-id shape. The comment is bounded by construction: at most 50 entries
(the rest are counted), three findings each, and a 60,000-character hard cap
below GitHub's 65,536 limit.

A pair whose summary cannot be fetched keeps today's link, followed by "summary
unavailable" and the reason: an HTTP status, `rate limited`, `timed out`,
`request failed`, or `unreadable response`. The job never fails on a Drydock
API problem. Calling the workflow `with: summaries: false` turns the fetch off
and posts links only.

### Keeping the snippet and the repository copy in step

The logic stays inline in the reusable workflow rather than moving under
`scripts/`: a called workflow runs in the caller's repository, so a script here
would not be on disk, and a vendored copy of the file must keep working alone.

This repository dogfoods the published path. `.github/workflows/dependency-pr-diff.yml`
is the caller, and it calls `.github/workflows/drydock-diff-link.yml` locally, whose
actions are pinned to commits per the `.github/workflows/ci.yml` convention. The
Docs page doesn't keep a second copy: `src/pages/Docs/dependency-pr-workflow.ts`
imports the caller and swaps the local path for
`JoviDeCroock/drydock/.github/workflows/drydock-diff-link.yml@<sha>`. That is the
only intended difference. `scripts/lib/workflow-ref.mjs` resolves `<sha>` at
build time to the last commit that touched the reusable workflow, not `HEAD`, so
the published hash moves only when the workflow does. Deploy from `main`: a
build on an unmerged branch whose workflow changed would publish a branch
commit. `test/dependency-pr-diff-workflow.test.ts`
checks the transformation, then runs the inline script under a stubbed
`github`/`fetch` against grouped and single Dependabot PRs, each supported
lockfile, hostile API responses, API failures, and the caps.

## Operational posture

The Renovate column is a plain markdown link, not a badge image: nothing
contacts Drydock when a PR is rendered, only when a human clicks through. Do not
"upgrade" the column to a per-PR badge image without revisiting the math below:
registry-scale PR volume would fetch on every page view.

The PR comment workflow does contact Drydock, from CI, once per PR `opened` or
`synchronize` event and never per view. One run sends at most one
`GET /api/public/v1/package-diff` per bumped pair, bounded by the group size and
capped at 10 per run (later pairs keep the link and say they are over the
per-run limit). Requests are sequential, with a 30-second timeout each and a
150-second budget per run, and the first `429` stops the remaining fetches.
Ten is the endpoint's own per-IP budget: the version-pair route charges the
`fetch` bucket at 10 requests a minute per client IP (`docs/security-model.md`),
so one run on one runner fits and never 429s on its own requests. Runs that
share an egress IP (self-hosted runners behind one NAT, several PRs pushed in
the same minute) can hit 429. Those entries degrade to the link.

The aggregate is bounded by adopters' PR events, not page views. A popular
release produces one PR per adopting repository, and every request after the
first for that pair is served from the versioned colo/KV result cache. Cold
computation runs once per pair in the common case, under the same sandbox caps
as a browser visit. Requests for the same cold pair that arrive at the same
moment can each compute it. A rebased or revised PR fetches the same pairs
again, all cache hits. The requests carry no credentials, and the route writes
only the result cache it already writes for browsers. Nothing reaches D1, so
the anonymous surface's properties in `docs/security-model.md` are unchanged.

What the workflow sends is each bumped package's name and version pair. A
private package would also be summarized wrongly: when a public package has the
same name, the comment would describe that package instead. So the workflow
drops a pair, link included, whenever the repository's own config says the name
may resolve somewhere else:

- npm, both bots: a non-public `registry=` or `@scope:registry=` in `.npmrc`, or
  `npmRegistryServer` (top-level or under `npmScopes`) in `.yarnrc.yml`. Config
  is read at the PR head from the lockfile's directory (for Dependabot, the
  `directory` it updated) and the repository root. A custom default registry, or
  `npmScopes` written in flow style, drops every npm pair. A custom scope drops
  that scope. If the config can't be read, a Dependabot run posts nothing
  rather than guess.
- npm lockfiles: a `package-lock.json` or yarn v1 entry whose `resolved` URL is
  not the public registry.
- PyPI, Renovate only: a requirements file with `-i`, `--index-url`, or
  `--extra-index-url` contributes no pairs, and `uv.lock` counts only pypi.org
  packages.

Those checks see only committed config. Registries set through environment
variables, CI-only config, user-level `.npmrc`, `pip.conf`, or a Dependabot
`registries:` block are invisible to the workflow. Dependabot's pip and uv bumps
in particular are sent as they are. Drydock answers 404 for a name it can't find. If a
repository's private package names are themselves confidential, call the
workflow `with: summaries: false`.

The workflow sends `x-drydock-client: dependency-pr`, which `public_diff.viewed`
records in its `client` dimension (`docs/product-analytics.md`), so CI fetches
are not counted as people reading a diff. The header is self-reported and
selects nothing but that label.
