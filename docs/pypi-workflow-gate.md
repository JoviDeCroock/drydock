# PyPI workflow-gate mode

This document covers PyPI review through a **GitHub deployment-protection
workflow gate**. PyPI has no registry-staged artifact, so the workflow gate is
the only review-before-publish path for PyPI packages.

It only describes what is PyPI-specific. The webhook ingestion, gate
persistence, artifact download + SHA-256 recomputation, approve/reject callback,
2FA step-up, monorepo fan-out, notifications, and timeout handling are all
**shared with the npm gate** and documented in
[`workflow-gates.md`](./workflow-gates.md). Read that first for the end-to-end
gate lifecycle.

## The release candidate

There is **no Drydock manifest file** to write. The boundary is the workflow
run's uploaded artifacts: CI runs `python -m build`, records checksums for
publish-time verification, and uploads one or more `.whl` files plus the sdist.
Small releases can use one `pypi-release-candidate` GitHub Actions artifact;
large compiled releases use `pypi-release-candidate-*` shards with one bounded
wheel/sdist upload per shard. Drydock treats every `.whl` / `.tar.gz` / `.tgz`
in that family as the release set; identity (`package` / `version`) is read from
each wheel's `METADATA` and the sdist's `PKG-INFO` after the bytes are parsed in
the credentials-free sandbox.

Integrity rests on **GitHub artifact immutability**, exactly like the npm gate:

- Drydock downloads the artifact bytes in the control plane and recomputes each
  wheel/sdist's SHA-256. That digest is the reviewed artifact's digest, surfaced
  in the report **Provenance** section, in the scan-detail API, and in the
  `report.json` export under `provenance.artifacts[].sha256`.
- The publish job downloads the **same immutable artifact**, re-verifies the
  digests, and uploads with `pypa/gh-action-pypi-publish` — it never rebuilds.
  The bytes Drydock reviewed are the bytes that get published.

Drydock synthesizes an internal release manifest
(`drydock.release-artifacts.v1`, `ecosystem: "pypi"`) from each artifact's parsed
identity plus the recomputed digest. The manifest is what the report and UI
render uniformly across ecosystems; maintainers never author it.

## Byte continuity

A reviewed wheel/sdist must be the **exact file** uploaded to PyPI. Rebuilding
after the gate breaks the boundary: a fresh `python -m build` can differ
byte-for-byte (timestamps, build-tool versions, file ordering) from the artifact
Drydock reviewed, so its contents were never reviewed.

The byte-continuity chain has three independently checkable links, all keyed on
the same SHA-256:

1. **Build** records `dist/SHA256SUMS` — the digest of every artifact it
   produced and uploaded.
2. **Review** — Drydock recomputes the digest from the immutable bundle bytes
   and shows it in the report Provenance section and the `report.json` export.
3. **Publish** re-verifies the downloaded bytes against `dist/SHA256SUMS` and
   fails closed on any mismatch before calling PyPI.

Because GitHub artifact storage is immutable, links 1–3 all hash the same bytes,
so an auditor can confirm `build digest == Drydock provenance digest == publish
digest` without trusting any single step.

## Auto-detection (no declared ecosystem)

A PyPI sdist `.tar.gz`/`.tgz` is byte- and filename-indistinguishable from an npm
`.tgz`, so a release target left on **auto-detect** (no pinned ecosystem) cannot
decide the ecosystem from the path alone. The gate resolves it by **content**
after parsing the archive in the credentials-free sandbox:

- a PyPI sdist carries a `PKG-INFO` at the root of its single top-level directory
  → **pypi**;
- an npm tarball carries a root `package.json` → **npm**.

This lives in the shared router (`server/lib/workflow-gates/resolve.ts`), which
also routes `.vsix` files to the VS Code adapter by extension (they are not
byte-ambiguous with tarballs). A single auto-detect gate therefore reviews npm,
PyPI, VS Code, or a mixed monorepo that publishes several. Pinning
`ecosystem: "pypi"` on the release target is supported but optional.

**Ambiguity fails closed.** Package contents are untrusted, and an archive that
presents as more than one ecosystem is rejected
(`artifact_identity_inconsistent`) rather than silently routed to one. PyPI's
`PKG-INFO` match is scoped to the sdist root location so a file vendored deep
inside an npm tarball does not look like a sdist. A genuine collision is resolved
by pinning the release target's ecosystem, which bypasses content detection.

## Monorepo

`python -m build` across several projects → `dist/*` fans out into one review per
package: artifacts are grouped by their normalized (PEP 503) name and each group
is scanned against its own previously-published baseline. The held deployment
releases only once every package is individually approved; rejecting any one
package blocks the whole release.

Every artifact must expose a `Name`/`Version`, and all artifacts that share a
normalized name must agree on the version, so a metadata-less or version-skewed
file slipped into a package's set is rejected (`artifact_identity_missing` /
`artifact_identity_inconsistent`) rather than silently shipped. Distinct package
names are kept apart — that is the expected monorepo shape, not a conflict.

## Baseline (currently-published version)

The baseline is the currently-published PyPI version, selected from the project's
public PyPI JSON metadata and downloaded from `files.pythonhosted.org`
(`acquireBaselinePyPi`, `pickPyPiBaselineRelease`). PyPI packages are public, so
no credential is attached for the baseline fetch. If no comparable published
release exists, the review runs without a baseline (full-tree review). Matching
platform baselines are downloaded and sandbox-parsed sequentially so a release
with dozens of wheels never inflates them concurrently.

## Code sharing

PyPI review is deterministic-only and shares the package diff, risk model, and
redaction with every other adapter. The PyPI-specific pieces:

- `server/lib/adapters/pypi/` — `pypiAdapter`, the `PackageAdapter` the shared
  pipeline runs for a gated PyPI publish: artifact preparation
  (`preparePyPiArtifact`), baseline selection (`acquireBaselinePyPi`),
  deterministic PyPI findings (`pyPiReleaseFindings`), and `summarizeDetails`,
  which surfaces the reviewed digests as the report `provenance` block.
- `server/lib/workflow-gates/pypi.ts` — `pypiWorkflowGateAdapter`, the
  `WorkflowGateAdapter`: `classifyArtifact` (`.whl`/`.tar.gz`/`.tgz`),
  `detectArtifact` (root `PKG-INFO`), and `prepareReleaseCandidates` (group
  parsed artifacts by package identity → one candidate per package).

## Workflow shape

The publish job must verify the downloaded bytes before upload — this is what
makes "the reviewed bytes are the published bytes" enforceable in CI rather than
assumed.

```yaml
jobs:
  build-release-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python -m build
      # Record the digest of every artifact Drydock will review. These are the
      # bytes the gate approves; the publish job re-verifies against them, and
      # they match the digests shown in the Drydock report Provenance section.
      - run: |
          shopt -s nullglob
          cd dist && sha256sum *.whl *.tar.gz *.tgz > SHA256SUMS
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate
          path: |
            dist/*.whl
            dist/*.tar.gz
            dist/*.tgz
            dist/SHA256SUMS
          if-no-files-found: error

  publish:
    needs: build-release-artifacts
    runs-on: ubuntu-latest
    environment: pypi # the gate: Drydock's deployment protection rule lives here
    permissions:
      id-token: write # OIDC for PyPI Trusted Publishing
      contents: read
    steps:
      # No checkout, no rebuild: GitHub artifact storage is immutable, so the
      # bytes the gate approved are the bytes we download and publish here.
      - uses: actions/download-artifact@v4
        with: { name: pypi-release-candidate, path: dist }
      # Fail closed if the downloaded bytes differ from what was built and
      # reviewed.
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      # SHA256SUMS is not a distribution; drop it so twine only uploads dists.
      - run: rm dist/SHA256SUMS
      - uses: pypa/gh-action-pypi-publish@release/v1
```

The `environment: pypi` line is the gate. Map the repository + environment on
`Organization settings → GitHub App` so the webhook can resolve a delivery to
your organization, then attach Drydock as a custom deployment protection rule on
that environment. The publish job stays blocked until a maintainer approves every
package's review in Drydock.

`Name`s are content-detected, so Drydock ignores `SHA256SUMS` in the bundle (it
is neither a wheel nor an sdist). PyPI strongly encourages configuring a GitHub
Environment for Trusted Publishers; the same environment carries the Drydock
gate.

### Large compiled releases

Projects that already build wheels in a platform matrix should upload each
matrix result as its own bounded shard. Leave the release target's optional
artifact-name override blank: a pinned PyPI target automatically selects the
exact `pypi-release-candidate` name and every
`pypi-release-candidate-*` shard, while ignoring unrelated workflow artifacts.
Drydock processes one shard at a time but does not omit distributions from the
review or provenance.

```yaml
jobs:
  build-wheel:
    strategy:
      matrix:
        include: # project-specific
          - { shard: linux-x64, os: ubuntu-latest }
          - { shard: macos-arm64, os: macos-14 }
          - { shard: windows-x64, os: windows-latest }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - run: ./ci/build-wheel "${{ matrix.shard }}" # writes one or more dist/*.whl
      - run: cd dist && sha256sum *.whl > "SHA256SUMS-${{ matrix.shard }}"
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate-${{ matrix.shard }}
          path: dist/
          if-no-files-found: error

  build-sdist:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python -m build --sdist
      - run: cd dist && sha256sum *.tar.gz > SHA256SUMS-sdist
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate-sdist
          path: dist/
          if-no-files-found: error

  publish:
    needs: [build-wheel, build-sdist]
    runs-on: ubuntu-latest
    environment: pypi
    permissions:
      id-token: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          pattern: pypi-release-candidate-*
          merge-multiple: true
          path: dist
      - run: |
          cd dist
          for sums in SHA256SUMS-*; do sha256sum --check --strict "$sums"; done
          rm SHA256SUMS-*
      - uses: pypa/gh-action-pypi-publish@release/v1
```

## Acceptance mapping (issue #308)

- _A GitHub Actions PyPI publish job waits on Drydock through a GitHub
  Environment gate_ — `environment: pypi` + the shared deployment-protection
  webhook path.
- _Drydock reviews every candidate wheel/sdist and records their SHA-256
  digests_ — the bundle bytes are recomputed (`processReleaseBundleForGate`) and
  bound into the synthesized `drydock.release-artifacts.v1` manifest.
- _Scan detail and report export expose the reviewed artifact digests_ —
  `pypiAdapter.summarizeDetails` emits a `provenance` block carried into
  `summary.stagedPublish` (scan detail) and `report.json`
  (`provenance.artifacts[]`).
- _The documented publish job verifies and uploads the reviewed bytes after gate
  approval_ — the `sha256sum --check --strict` step above.
- _Fail-closed on digest mismatch_ — gate ingestion rejects unsafe/inconsistent
  artifacts before any scan runs; the publish job's checksum step blocks upload
  on any byte drift.
