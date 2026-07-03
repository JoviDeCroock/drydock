# Composer workflow-gate mode

This document covers Composer/Packagist review through a **GitHub
deployment-protection workflow gate**. Packagist has no registry-staged
artifact (it serves dist archives straight from the VCS host), so the workflow
gate is the only review-before-publish path for Composer packages.

It only describes what is Composer-specific. The webhook ingestion, gate
persistence, artifact download + SHA-256 recomputation, approve/reject callback,
2FA step-up, monorepo fan-out, notifications, and timeout handling are all
**shared with the npm and PyPI gates** and documented in
[`workflow-gates.md`](./workflow-gates.md). Read that first for the end-to-end
gate lifecycle.

## The release candidate

There is **no Drydock manifest file** to write. The boundary is the workflow
run's uploaded artifacts: CI packages the release (`composer archive`, `git
archive`, or equivalent CI packaging), records `dist/SHA256SUMS` for
publish-time verification, and uploads the archive(s) as a GitHub Actions
artifact. Drydock treats every `.zip` / `.tar.gz` / `.tgz` it finds as the
release set; identity (`package` / `version`) is read from each archive's root
`composer.json` after the bytes are parsed in the credentials-free sandbox.

`composer.json` `name` is **required** — an archive without one fails the gate
(`artifact_identity_missing`). `version` is optional (most Composer packages
derive it from the VCS tag); when absent the candidate reviews as
`0.0.0-unversioned` and the baseline is still selected from Packagist's newest
published release.

Drydock synthesizes an internal release manifest
(`drydock.release-artifacts.v1`, `ecosystem: "composer"`) from each artifact's
parsed identity plus the recomputed digest, exactly like the PyPI gate.
Maintainers never author it.

## Archive normalization

`composer archive` produces a **rootless** archive (`composer.json` at the top
level); `git archive` and GitHub's zipball/tarball endpoints wrap everything in
a single `<repo>-<ref>/` directory. Drydock strips a single common root
directory before reading identity and diffing (`prepareComposerArtifact`), so
staged and baseline trees line up regardless of which tool produced each
archive. Only the root `composer.json` carries identity; nested
`composer.json` files (test fixtures, vendored packages) are ignored.

## Auto-detection (no declared ecosystem)

`classifyArtifact` claims `.zip`, `.tar.gz`, and `.tgz`. A `.tar.gz`/`.tgz` is
byte- and filename-indistinguishable from an npm tarball or PyPI sdist, so an
auto-detect release target resolves those by **content** in the shared router
(`server/lib/workflow-gates/resolve.ts`):

- a root `composer.json` (directly or under a single top-level directory)
  → **composer**;
- a root `package.json` → **npm**;
- a root-scoped `PKG-INFO` → **pypi**.

Ambiguity fails closed (`artifact_identity_inconsistent`); pinning
`ecosystem: "composer"` on the release target bypasses content detection.

## Monorepo

A Composer monorepo (one repository publishing several packages) uploads one
archive per package. Candidates are grouped by the normalized (lowercased)
`vendor/package` name — one review per package, each against its own Packagist
baseline. Two archives claiming the same package name fail closed
(`artifact_identity_inconsistent`); Composer publishes exactly one archive per
package per release.

## Baseline (currently-published version)

The baseline is the newest published release from Packagist's public Composer
v2 metadata endpoint (`https://repo.packagist.org/p2/<vendor>/<package>.json`),
selected by upload time with a fallback to metadata order
(`pickComposerBaselineRelease`). The baseline dist archive is downloaded
credential-free through a broker restricted to the HTTPS dist hosts Packagist
references (GitHub, GitLab, Bitbucket); GitHub zipball redirects are resolved
hop-by-hop in the control plane with every hop re-checked against the
allowlist. If no comparable published release exists, the review runs without a
baseline (full-tree review).

## Deterministic findings

Composer runs the shared file/code/diff rules with the **PHP** capability
pattern set (process execution, network access, dynamic evaluation, credential
access), plus `composer.*` rules derived from the root `composer.json`.
Manifest-shape rules only fire on what is **new relative to the baseline**, so
a package that has always been a plugin does not re-alarm on every release:

| Rule                              | Fires when                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `composer.manifest-missing`       | no root `composer.json` in the archive                                                          |
| `composer.manifest-mismatch`      | archive identity disagrees with the reviewed manifest                                           |
| `composer.plugin`                 | `type: composer-plugin` (or a new `extra.class` plugin entry point) not present in the baseline |
| `composer.plugin-api-requirement` | new `require.composer-plugin-api` constraint                                                    |
| `composer.allow-plugins`          | newly allowed plugins in `config.allow-plugins`, or allow-all                                   |
| `composer.autoload-files`         | new `autoload.files` entries (run on every autoloader load)                                     |
| `composer.bin-entry`              | new `bin` executables                                                                           |
| `composer.custom-repository`      | new non-Packagist repository; **high** for non-HTTPS URLs                                       |
| `composer.package-shadowing`      | new `replace`/`provide` entries shadowing other packages                                        |
| `composer.unstable-stability`     | `minimum-stability: dev` without `prefer-stable`                                                |
| `composer.source-install`         | `config.secure-http: false` or `config.preferred-install: source`                               |

## Code sharing

Composer review is deterministic-only and shares the package diff, risk model,
and redaction with every other adapter. The Composer-specific pieces:

- `server/lib/adapters/composer/` — `composerAdapter`, the `PackageAdapter` the
  shared pipeline runs for a gated Composer publish: archive preparation
  (`prepareComposerArtifact`), baseline selection (`acquireBaselineComposer`),
  deterministic Composer findings (`composerReleaseFindings`), and
  `summarizeDetails`, which surfaces the reviewed digests as the report
  `provenance` block.
- `server/lib/workflow-gates/composer.ts` — `composerWorkflowGateAdapter`, the
  `WorkflowGateAdapter`: `classifyArtifact` (`.zip`/`.tar.gz`/`.tgz`),
  `detectArtifact` (root `composer.json`), and `prepareReleaseCandidates`
  (group parsed archives by package name → one candidate per package).

## Workflow shape

The publish job must verify the downloaded bytes before tagging — this is what
makes "the reviewed bytes are the published bytes" enforceable in CI rather
than assumed.

```yaml
jobs:
  build-release-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: composer archive --format=zip --dir=dist
      # Record the digest of every artifact Drydock will review. These are the
      # bytes the gate approves; the publish job re-verifies against them, and
      # they match the digests shown in the Drydock report Provenance section.
      - run: cd dist && sha256sum *.zip > SHA256SUMS
      - uses: actions/upload-artifact@v4
        with:
          name: composer-release-candidate # or leave blank to auto-detect
          path: |
            dist/*.zip
            dist/SHA256SUMS
          if-no-files-found: error

  publish:
    needs: build-release-artifacts
    runs-on: ubuntu-latest
    environment: packagist # the gate: Drydock's deployment protection rule lives here
    steps:
      # No checkout, no rebuild: GitHub artifact storage is immutable, so the
      # bytes the gate approved are the bytes verified here.
      - uses: actions/download-artifact@v4
        with: { name: composer-release-candidate, path: dist }
      # Fail closed if the downloaded bytes differ from what was built and
      # reviewed.
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      # Packagist publishes from the VCS tag; push the release tag only after
      # the gate approves the reviewed bytes.
      - run: git push origin "refs/tags/${GITHUB_REF_NAME}"
```

The `environment: packagist` line is the gate. Map the repository + environment
on `Organization settings → GitHub App` so the webhook can resolve a delivery
to your organization, then attach Drydock as a custom deployment protection
rule on that environment.

Packagist serves dists straight from the VCS host, so the enforceable boundary
is the tag push (or Packagist API update) that the protected job performs after
approval. The `SHA256SUMS` record/check pair keeps the reviewed archive bytes
auditable against the tagged tree; Drydock ignores `SHA256SUMS` in the bundle
(it is not an archive).
