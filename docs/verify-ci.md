# Verify dependency updates in CI

`drydock verify` is the enforcement layer for Drydock's public dependency
verdicts. It compares a PR's lockfile with its Git base, asks Drydock for one
deterministic verdict per unambiguous npm version pair, evaluates the consuming
repository's policy, and exits nonzero when a row violates that policy. Every
row links to the human-readable `/diff` page behind the verdict.

The v1 lockfile readers support `package-lock.json` (lockfile versions 1–3) and
`pnpm-lock.yaml` (the modern `name@version` shape plus pnpm 5 slash locators).
They consider direct and transitive packages. When one package has an ambiguous
many-to-one or one-to-many version change, the CLI omits that pair instead of
linking a confidently wrong diff. `yarn.lock` is not supported in v1.

Public verdicts apply only to bytes resolved from the canonical public npm
registry. For `package-lock.json`, the installed path and `resolved` URL exclude
workspace records, private registries, Git dependencies, direct tarballs, and
local sources. For pnpm, locator schemes plus each compared revision's checked-in
`.npmrc` `registry` / `@scope:registry` settings establish the same boundary;
registry credentials are ignored. A changed non-public pair is unavailable
evidence and follows `onUnavailable`, never a lookup of a same-named public
package. Duplicate pairs across monorepo lockfiles retain the strictest source
classification. Lockfile renames and same-directory `package-lock.json` /
`pnpm-lock.yaml` format replacements retain their old side, so moving a package
or changing its lockfile format does not erase the comparison without pairing
unrelated monorepo paths.

## Policy

Commit `drydock.policy.json` at the repository root:

```json
{
  "$schema": "https://unpkg.com/drydock-verify/drydock.policy.schema.json",
  "minReleaseAgeHours": 72,
  "maxGrade": "notable",
  "denyCapabilityEscalation": ["network", "process", "credentials"],
  "requireListedReview": ["left-pad", "@company/critical-*"],
  "onUnavailable": "fail"
}
```

- `minReleaseAgeHours` rejects a target release that is younger than the
  configured cooldown. A missing publication timestamp is unavailable evidence.
- `maxGrade` uses `clear < notable < needs-review`. The public endpoint never
  makes a stronger accusation than `needs-review`.
- `denyCapabilityEscalation` rejects target-side additions from Drydock's
  `network`, `process`, `credentials`, `dynamicEval`, `native`,
  `installScripts`, and `bin` capability vocabulary. If archive coverage is
  incomplete, an empty escalation list is not proof that nothing changed; the
  row follows `onUnavailable`.
- `requireListedReview` accepts exact package names and `*` wildcards. Matching
  targets must have a version-specific, feed-listed maintainer review from the
  public `drydock.review-lookup.v1` endpoint. An ordinary anonymous diff does
  not satisfy this policy, and neither does a workflow-gate review whose package
  name is only manifest-claimed; the lookup requires registry-established
  package identity. It also requires the verified SHA-1 of the reviewed staged
  archive to equal the SHA-1 Drydock recomputed over the published target
  archive, so a mutable stage rewritten after review cannot satisfy the policy.
- `onUnavailable` is `fail` by default. `warn` keeps CI available during a
  Drydock or registry outage but leaves the unavailable reason in the check
  table. It does not weaken a verdict that was fetched successfully.

Unknown properties and invalid values fail configuration loading, so a typo
cannot silently weaken the check.

## Command line

```sh
npx drydock-verify verify --base origin/main
```

The default base is the pull request base supplied by GitHub Actions, then
`origin/main`, `main`, or `HEAD^`. `--policy` selects a different policy path.
`--endpoint` or `DRYDOCK_URL` points the client at a self-hosted Drydock origin.

The CLI never installs dependencies, runs lifecycle scripts, imports changed
packages, or executes package-provided code. It reads the two lockfile versions
with data-only parsers, invokes `git` without a shell, and makes credential-free
HTTPS requests to the public verdict and listed-review endpoints.

## GitHub Action

The thin Action is published separately from the Worker repository so consumer
checkouts do not pull the Drydock application:

```yaml
name: drydock-verify

on: pull_request

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: JoviDeCroock/drydock-verify-action@v1
```

The Action invokes the bundled CLI with the pull request's base SHA. The CLI
writes its Markdown table to the job log and `GITHUB_STEP_SUMMARY`; its nonzero
exit code makes the ordinary Actions check fail. No GitHub App, webhook, token,
or write permission is involved.

## Availability and request budget

Verdict requests are pair-addressed and cacheable. A warm pair spends only the
verdict endpoint's cheap rate-limit bucket; a cold pair also spends the shared
public-diff computation budget. The CLI retries `429`, `502`, `503`, and `504`
responses up to three times with bounded delays. If the request remains
unavailable, `onUnavailable` decides whether the check warns or fails.
