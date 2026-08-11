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
using `dependabot/fetch-metadata` (which parses the bump from the PR) plus a
`gh pr comment` call — copy-paste YAML on the Docs page, no Drydock-owned
action required. The workflow never checks out or executes PR code, so granting
`pull-requests: write` to the Dependabot-triggered run is safe. Note that
Dependabot-triggered `pull_request` runs honor the workflow-level `permissions`
key (GitHub changelog 2022-02-10); the `dependabot/fetch-metadata` README still
recommends `pull_request_target` for write access, but GitHub's own Dependabot
automation tutorial uses exactly this `pull_request` + `permissions` shape.
Grouped Dependabot PRs expose `updated-dependencies-list` instead of a single
previous/new pair; the snippet comments only on single-dependency PRs.

## Operational posture

The Renovate column and the Dependabot comment are plain markdown links, not
badge images: nothing contacts Drydock when a PR is rendered, only when a human
clicks through. There is no new anonymous-traffic amplification to reason about
— clicks land on the existing `/api/public/v1/package-diff` endpoints with
their IP rate limits and colo cache (`docs/security-model.md`). Do not "upgrade"
the column to a per-PR badge image without revisiting that math: registry-scale
PR volume would fetch on every page view instead of every click.
