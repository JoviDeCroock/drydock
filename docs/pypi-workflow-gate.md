# PyPI workflow-gate mode

This document covers PyPI review through a **GitHub deployment-protection
workflow gate**. pypi.org has no registry-staged artifact today, so the workflow
gate is the only review-before-publish path for PyPI packages. When PEP 694
staged previews ship, the same gate can review the staged bytes instead; see
[PEP 694 staged releases](#pep-694-staged-releases-preview).

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

A published release that exceeds the baseline download budget is a different
case from having no predecessor at all, and the review says so rather than
guessing. `BaselineInfo.comparisonSkipped` is set to `baseline-too-large`, every
finding is annotated `unknown` package context instead of a release delta, and
the report leads with "no baseline to compare" plus the version that was
skipped. Without that, an uncompared release would report its entire contents as
newly added — which for a compiled project means every `.pyd` raising a high
release-delta finding, and an advisory verdict of "block manual approval" that
no evidence supports. The gate's advisory recommendation becomes
`manual_review`: neither approval nor rejection is supported when nothing was
compared. The gate stays pending for a maintainer either way.

## Code sharing

PyPI review is deterministic-only and shares the package diff, risk model, and
redaction with every other adapter. The PyPI-specific pieces:

- `server/lib/ecosystems/pypi/` — `pypiAdapter`, the `PackageAdapter` the shared
  pipeline runs for a gated PyPI publish: artifact preparation
  (`preparePyPiArtifact`), baseline selection (`acquireBaselinePyPi`),
  deterministic PyPI findings (`pyPiReleaseFindings`), and `summarizeDetails`,
  which surfaces the reviewed digests as the report `provenance` block.
- `server/lib/ecosystems/pypi/workflow-gate.ts` — `pypiWorkflowGateAdapter`, the
  `WorkflowGateAdapter`: `classifyArtifact` (`.whl`/`.tar.gz`/`.tgz`),
  `detectArtifact` (root `PKG-INFO`), and `prepareReleaseCandidates` (group
  parsed artifacts by package identity → one candidate per package).

## Workflow shape

The publish job must verify the downloaded bytes before upload — this is what
makes "the reviewed bytes are the published bytes" checkable in CI rather than
assumed. The check runs in the repository's own job, so it holds only while the
workflow keeps it.

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
matrix result as its own bounded shard. Pin the release target's ecosystem to
`pypi` and leave its optional artifact-name override blank: a pinned PyPI target
automatically selects the exact `pypi-release-candidate` name and every
`pypi-release-candidate-*` shard, while ignoring unrelated workflow artifacts.
Drydock processes one shard at a time but does not omit distributions from the
review or provenance.

Pinning is what unlocks the large-release budget. An auto-detect release target
has no name to narrow the run by, so it matches every non-expired artifact the
run uploaded and keeps the smaller single-upload budget (20 distributions,
50 MiB of artifact ZIPs) rather than downloading unrelated CI output. Shard
families are a PyPI-only behavior; the npm and VS Code gates still match their
conventional artifact name exactly.

Give each distribution exactly one shard. A matrix leg that runs a full
`python -m build` ships the sdist alongside its wheel, so the same
`*.tar.gz` lands in every shard: identical bytes are accepted once, but two
shards producing the same filename from a non-reproducible build fail the gate
with `artifact_identity_inconsistent` rather than binding two digests to one
manifest path. Build the sdist in its own job, as below.

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

## PEP 694 staged releases (preview)

> **Preview, draft spec.** [PEP 694](https://peps.python.org/pep-0694/) (the
> Upload 2.0 API with staged previews) is a draft and is not live on pypi.org.
> The stage-reference schema and fetch code are versioned and tolerant so they
> can follow the PEP, but nothing here has run against a real index yet.

PEP 694 lets a workflow create a publishing session, upload files into it, and
publish them later in one step. With staged previews, the index serves the
session's files at an unguessable **stage URL** before anything is public.
Drydock can review the bytes the stage holds, so the reviewed bytes are the
bytes the index will publish, not a copy built elsewhere.

There is no endpoint that lists sessions, so Drydock cannot discover a stage.
The workflow registers it through the gate: it uploads a `pypi-stage.json`
file in the `pypi-release-candidate*` artifact. The GitHub App already
authenticates that artifact to the repository and run.

### Mode A: credential-free review of the staged bytes (default)

Drydock holds no PyPI credentials. The workflow creates the session and uploads
the files with its own trusted-publishing credentials, then writes:

```json
{
  "schema": "drydock.pypi-stage.v1",
  "stages": [
    {
      "name": "demo-package",
      "version": "1.2.0",
      "stage-url": "https://pypi.org/<stage path from links.stage>/"
    }
  ]
}
```

A single-project file may put `name` / `version` / `stage-url` at the top
level. Unknown keys are ignored. An unknown `schema` fails closed: a workflow
that tried to bind a stage never falls back to an unbound review. `session-url`
(`links.session`) is optional and is used only by mode B below.

For each registered project, the gate:

1. reads the stage's simple-index project page (`<stage-url>/<normalized-name>/`),
   asking for PEP 691 JSON and accepting PEP 503 HTML;
2. selects every file for the registered version. Files for other versions are
   ignored, because a session publishes exactly one name and version. A file
   that names another project, cannot be attributed to a version, or has no
   sha256 or URL fails the check;
3. downloads each staged file, requires its sha256 to equal the digest the
   index declares, and parses it in the credentials-free sandbox. **These staged
   bytes are the release candidate**: the report's Provenance digests are the
   staged files' digests;
4. if the artifact also carries wheels/sdists for the project, requires byte
   identity between the two: the same filenames, the same sha256, and nothing
   extra on either side. Identical bytes reuse the artifact's parse;
5. checks the staged metadata's `Name` / `Version` against the registered name
   and version.

Any failure rejects the held deployment with a `stage_*` reason that names the
file and both digest prefixes, for example
`stage_identity_mismatch: demo_package-1.2.0-py3-none-any.whl sha256 differs:
artifact 1a2b3c4d5e6f…, stage 9f8e7d6c5b4a…`. Codes: `stage_reference_invalid`
(bad or non-allowlisted reference), `stage_unavailable` (unreachable, refused
redirect, oversized or malformed page), `stage_identity_mismatch`. A release
without `pypi-stage.json` is reviewed exactly as before.

The gate decision is the enforcement: approval releases the protected job, which
publishes the session. A rejection, or a gate left pending, means the job never
runs and the session is never published.

**Egress.** The stage host comes from a workflow-controlled file, so every
request, including each redirect hop, must be https on an allowlisted origin:
index pages on `https://pypi.org` or `https://test.pypi.org`, and staged files
on that index's own origins (`pypi.org` + `files.pythonhosted.org`, or
`test.pypi.org` + `test-files.pythonhosted.org`). Stage URLs with credentials,
ports, query strings, or fragments are refused. Pages are capped at 8 MiB,
staged files at 25 MiB each (the same cap as artifact entries), and every
request has a timeout. The allowlist is code, not configuration; a self-hosted
index cannot be used yet.

**Capability secrets.** A stage URL, and every file URL its page lists, lets
anyone read the unpublished bytes. Drydock reads them in the parent Worker (they
never enter the sandbox), keeps them in memory only, and never logs, persists,
or displays them. Errors name projects, files, and digest prefixes. The report
records only the index origin and whether the artifact was byte-bound
(`provenance.stage`).

**Residual risk.** Artifacts of a public repository's workflow runs can be
downloaded by any signed-in GitHub user, so `pypi-stage.json` exposes the
preview to them until the session is published or canceled. Keep the session
short, do not extend it more than needed, and cancel it when the release is
rejected. In mode A the session stays editable by anyone with upload rights to
the project between Drydock's review and the publish step. Upload the
distributions and `SHA256SUMS` in the artifact too (Drydock then binds them to
the stage), and have the publish job re-check the stage against `SHA256SUMS`
immediately before it publishes. Mode B closes the window for Drydock-held
sessions.

### Workflow sketch (mode A)

```yaml
jobs:
  stage:
    runs-on: ubuntu-latest
    environment: pypi-stage # trusted publisher for the upload session
    permissions: { id-token: write, contents: read }
    outputs:
      session-url: ${{ steps.session.outputs.session-url }}
    steps:
      - uses: actions/checkout@v4
      - run: python -m build
      - run: cd dist && sha256sum *.whl *.tar.gz > SHA256SUMS
      # Creates the PEP 694 session, uploads dist/*, and writes
      # dist/pypi-stage.json (see the Python sketch below).
      - id: session
        run: python ci/pep694_stage.py dist
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate
          path: |
            dist/*.whl
            dist/*.tar.gz
            dist/SHA256SUMS
            dist/pypi-stage.json
          retention-days: 1

  publish:
    needs: stage
    runs-on: ubuntu-latest
    environment: pypi # Drydock's deployment protection rule
    permissions: { id-token: write, contents: read }
    steps:
      - uses: actions/download-artifact@v4
        with: { name: pypi-release-candidate, path: dist }
      # Re-check the stage against the reviewed digests, then POST links.publish.
      - run: python ci/pep694_publish.py "${{ needs.stage.outputs.session-url }}" dist

  cancel:
    needs: [stage, publish]
    if: failure() && needs.stage.result == 'success'
    runs-on: ubuntu-latest
    environment: pypi-stage
    permissions: { id-token: write }
    steps:
      - run: python ci/pep694_cancel.py "${{ needs.stage.outputs.session-url }}" # DELETE links.session
```

```python
# ci/pep694_stage.py (sketch; PEP 694 is a draft, field names may change)
import hashlib, json, os, pathlib, sys, requests

ROOT = "https://upload.pypi.org/2.0/"  # index-documented Upload 2.0 root
CT = "application/vnd.pypi.upload.v2+json"
token = mint_trusted_publishing_token()  # OIDC exchange, as gh-action-pypi-publish does
auth = {"Authorization": f"Bearer {token}", "Content-Type": CT, "Accept": CT}
dist = pathlib.Path(sys.argv[1])
name, version = project_name_and_version(dist)

session = requests.post(ROOT, headers=auth, json={
    "meta": {"api-version": "2.0"}, "name": name, "version": version,
}).json()
for path in sorted(dist.glob("*.whl")) + sorted(dist.glob("*.tar.gz")):
    upload_file(session["links"]["upload"], path, auth)  # one file-upload session per file
if "stage" not in session["links"]:
    sys.exit("index does not support staged previews")
(dist / "pypi-stage.json").write_text(json.dumps({
    "schema": "drydock.pypi-stage.v1",
    "stages": [{"name": name, "version": version,
                "stage-url": session["links"]["stage"],
                "session-url": session["links"]["session"]}],
}))
with open(os.environ["GITHUB_OUTPUT"], "a") as out:
    out.write(f"session-url={session['links']['session']}\n")
```

`ci/pep694_publish.py` reads the stage page, fails unless every staged file's
sha256 matches `SHA256SUMS` and nothing else is staged, then sends
`POST links.publish` with `{"meta": {"api-version": "2.0"}}` and polls
`links.session` through `processing` until `published` (or fails on `error`).
`ci/pep694_cancel.py` sends `DELETE links.session`.

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
