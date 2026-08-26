# Diff links in dependency update PRs

Renovate and Dependabot PRs say "bump `lodash` 4.17.20 → 4.17.21" without showing
what changed in the published packages. Drydock's anonymous `/diff` pages take a
fully derivable URL — `/diff/<name>/<from>/<to>` for npm,
`/diff/pypi/<project>/<from>/<to>` for PyPI (see `src/lib/package-diff-path.ts`)
— so a dependency-update PR can link its own diff with no account, token, or API
call. This is a consumer-side distribution surface: it puts "Read the diff" in
front of reviewers at the moment they are deciding whether to merge a bump.

The user-facing setup instructions live on the Docs page
(`src/pages/Docs/index.tsx`, "Diffs in dependency PRs"). This file documents the
contracts and the operational posture.

Plain diff links are the zero-request integration: a reviewer chooses when to
open one. Repositories that want an enforceable dependency-update check can add
[`drydock verify`](./verify-ci.md). It reads changed npm pairs from the lockfile,
calls the machine-readable verdict for each pair, and turns the same `/diff`
links into a failing GitHub check according to `drydock.policy.json`.

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

## Dependabot

Dependabot has no PR-body templating. The documented path is a small workflow
using `dependabot/fetch-metadata` plus a comment upsert — copy-paste YAML on the
Docs page, no Drydock-owned action required. The workflow never checks out or
executes PR code, so granting `pull-requests: write` to the Dependabot-triggered
run is safe. Note that Dependabot-triggered `pull_request` runs honor the
workflow-level `permissions` key (GitHub changelog 2022-02-10); the
`dependabot/fetch-metadata` README still recommends `pull_request_target` for
write access, but GitHub's own Dependabot automation tutorial uses exactly this
`pull_request` + `permissions` shape.

`fetch-metadata` runs first for its own sake, not only for its outputs: it fails
the job unless the PR's first commit is an authentic, signed Dependabot commit.
That verification is what makes it safe for the next step to parse that commit
message, so nothing may be reordered ahead of it.

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
`scripts/comment-detection-eval.mjs` uses for its PR comment. A per-PR
`concurrency` group keeps two quick pushes from racing the read-then-write into
duplicate comments.

Unlike that script, this logic stays inline in the workflow rather than moving
under `scripts/`: the published artifact is copy-paste YAML for repositories
that cannot reference anything in this one, so a shared script would be
reachable only by us and would end the dogfooding below.

This repository runs the documented workflow against its own Dependabot PRs in
`.github/workflows/drydock-diff-link.yml`, pinned to a `fetch-metadata` commit
per the `.github/workflows/ci.yml` convention where the published snippet floats
on `@v3`. That pin is the only intended difference; keep the two otherwise in
step, since the repository copy is the only place the snippet is exercised.

## Operational posture

The Renovate column and the Dependabot comment are plain markdown links, not
badge images: nothing contacts Drydock when a PR is rendered, only when a human
clicks through. There is no new anonymous-traffic amplification to reason about
— clicks land on the existing `/api/public/v1/package-diff` endpoints with
their IP rate limits and colo cache (`docs/security-model.md`). Do not "upgrade"
the column to a per-PR badge image without revisiting that math: registry-scale
PR volume would fetch on every page view instead of every click.

`drydock verify` intentionally has a different traffic shape: CI calls the
verdict endpoint for every unambiguous changed pair. Pair results are immutable
and cacheable, but cold computations still share the anonymous public-diff
budget. The CLI retries `429` responses with bounded `retry-after` delays, then
applies the repository's `onUnavailable` policy. See
[`verify-ci.md`](./verify-ci.md) for the enforcement contract.
