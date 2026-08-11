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

Third-party repositories reference the preset by path:

```json
{ "extends": ["github>JoviDeCroock/drydock//renovate/diff-links"] }
```

**The file path is a public contract.** Renovate resolves
`github>JoviDeCroock/drydock//renovate/diff-links` to
`renovate/diff-links.json` on the default branch of this (public) repository.
Renaming or moving the file breaks every downstream config silently (Renovate
logs a preset-resolution error but keeps updating without the column), so treat
it like a published API: additive changes only.

Shape notes, so edits keep the links correct:

- The column is added via `packageRules` scoped with `matchDatasources`, the
  same mechanism as Renovate's built-in `security:openssf-scorecard` preset.
  Only `npm` and `pypi` get a column — those are the ecosystems `/diff` serves.
- `packageName`, not `depName`: for npm alias specs (`npm:real-pkg@1.2.3`) and
  normalized PyPI names, `packageName` is the package actually being installed;
  `depName` is what the manifest calls it. Linking `depName` could present a
  same-named squatter's diff for an aliased dependency.
- The `{{#if currentVersion}}{{#if newVersion}}` guards drop the link for
  updates without a resolvable exact pair (pin, digest, some lockfile-only
  updates) — no link is safer than a confidently wrong one, matching
  `dependencyDiffHref` in the app.
- Triple-stash (`{{{…}}}`) keeps handlebars from HTML-escaping scoped names.
- `prBodyColumns` restates Renovate's default columns plus `Drydock`; Renovate
  drops columns that end up empty, so tables without a Drydock link render
  unchanged.

## Dependabot

Dependabot has no PR-body templating. The documented path is a small workflow
using `dependabot/fetch-metadata` (which parses the bump from the PR) plus a
`gh pr comment` call — copy-paste YAML on the Docs page, no Drydock-owned
action required. The workflow never checks out or executes PR code, so granting
`pull-requests: write` to the Dependabot-triggered run is safe. Grouped
Dependabot PRs expose `updated-dependencies-list` instead of a single
previous/new pair; the snippet comments only on single-dependency PRs.

## Operational posture

The Renovate column and the Dependabot comment are plain markdown links, not
badge images: nothing contacts Drydock when a PR is rendered, only when a human
clicks through. There is no new anonymous-traffic amplification to reason about
— clicks land on the existing `/api/public/v1/package-diff` endpoints with
their IP rate limits and colo cache (`docs/security-model.md`). Do not "upgrade"
the column to a per-PR badge image without revisiting that math: registry-scale
PR volume would fetch on every page view instead of every click.
