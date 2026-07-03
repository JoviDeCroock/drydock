# RubyGems workflow-gate mode

This document covers RubyGems review through a **GitHub deployment-protection
workflow gate**. RubyGems.org has no registry-staged artifact, so the workflow
gate is the only review-before-publish path for gems.

It only describes what is RubyGems-specific. The webhook ingestion, gate
persistence, artifact download + SHA-256 recomputation, approve/reject callback,
2FA step-up, monorepo fan-out, notifications, and timeout handling are all
**shared with the npm and PyPI gates** and documented in
[`workflow-gates.md`](./workflow-gates.md). Read that first for the end-to-end
gate lifecycle.

## The release candidate

There is **no Drydock manifest file** to write. The boundary is the workflow
run's uploaded artifacts: CI runs `gem build`, records `pkg/SHA256SUMS` for
publish-time verification, and uploads the `.gem` file(s) as a GitHub Actions
artifact. Drydock treats every `.gem` it finds as the release set; identity
(`package` / `version`) is read from each gem's serialized gemspec
(`metadata.gz`) after the bytes are parsed in the credentials-free sandbox.

Integrity rests on **GitHub artifact immutability**, exactly like the npm and
PyPI gates:

- Drydock downloads the artifact bytes in the control plane and recomputes each
  gem's SHA-256. That digest is the reviewed artifact's digest, surfaced in the
  report **Provenance** section, in the scan-detail API, and in the
  `report.json` export under `provenance.artifacts[].sha256`.
- The publish job downloads the **same immutable artifact**, re-verifies the
  digests, and pushes with `gem push` under RubyGems Trusted Publishing — it
  never rebuilds. The bytes Drydock reviewed are the bytes that get published.

Drydock synthesizes an internal release manifest
(`drydock.release-artifacts.v1`, `ecosystem: "rubygems"`) from each artifact's
parsed identity plus the recomputed digest. The manifest is what the report and
UI render uniformly across ecosystems; maintainers never author it.

## Byte continuity

A reviewed gem must be the **exact file** pushed to RubyGems.org. Rebuilding
after the gate breaks the boundary: a fresh `gem build` can differ byte-for-byte
(timestamps, packaging-tool versions, file ordering) from the artifact Drydock
reviewed, so its contents were never reviewed.

The byte-continuity chain has three independently checkable links, all keyed on
the same SHA-256:

1. **Build** records `pkg/SHA256SUMS` — the digest of every gem it produced and
   uploaded.
2. **Review** — Drydock recomputes the digest from the immutable bundle bytes
   and shows it in the report Provenance section and the `report.json` export.
3. **Publish** re-verifies the downloaded bytes against `pkg/SHA256SUMS` and
   fails closed on any mismatch before calling `gem push`.

Because GitHub artifact storage is immutable, links 1–3 all hash the same bytes,
so an auditor can confirm `build digest == Drydock provenance digest == publish
digest` without trusting any single step.

## Gem archive parsing

A `.gem` file is a plain (uncompressed) tar whose members include `metadata.gz`
(the gzipped Gem::Specification YAML) and `data.tar.gz` (the gzipped tar of the
packaged files). The sandbox parses both layers with the existing bounded tar
reader — the same member-count, per-entry, and decompressed-size limits apply to
the outer tar, the decompressed gemspec, and the inner data tar, so a crafted
gem cannot expand past the safety limits at any layer. The gemspec is surfaced
to the review as a synthetic root `metadata.gz` file record; the packaged files
appear under their `data.tar.gz` paths. No gem code is ever executed and the
gemspec YAML is read as plain text (no YAML object deserialization).

## Auto-detection (no declared ecosystem)

`.gem` is not claimed by any other ecosystem, so a release target left on
**auto-detect** routes `.gem` entries to the RubyGems adapter by extension
alone. Content detection (a root `metadata.gz` whose text carries the
`!ruby/object:Gem::Specification` tag) exists for completeness in the shared
router (`server/lib/workflow-gates/resolve.ts`); a single auto-detect gate
reviews npm, PyPI, RubyGems, or a mixed monorepo publishing all of them.
Pinning `ecosystem: "rubygems"` on the release target is supported but optional.

## Monorepo

`gem build` across several gems → one review per gem: artifacts are grouped by
their normalized (lowercased) gemspec name and each group is scanned against its
own previously-published baseline. Platform-specific gems (`foo-1.0.0.gem`,
`foo-1.0.0-x86_64-linux.gem`) belong to one group and one review. The held
deployment releases only once every gem is individually approved; rejecting any
one gem blocks the whole release.

Every artifact must expose a gemspec `name`/`version`, all artifacts that share
a name must agree on the version, and platforms within a group must be distinct,
so a metadata-less, version-skewed, or duplicated file slipped into a gem's set
is rejected (`artifact_identity_missing` / `artifact_identity_inconsistent`)
rather than silently shipped. Distinct gem names are kept apart — that is the
expected monorepo shape, not a conflict.

## Baseline (currently-published version)

The baseline is the currently-published RubyGems.org version, selected from the
gem's public versions listing (`https://rubygems.org/api/v1/versions/{gem}.json`,
yanked versions excluded) and downloaded from
`https://rubygems.org/gems/{gem}-{version}[-{platform}].gem`
(`acquireBaselineRubygems`, `pickRubygemsBaselineRelease`). Gems are public, so
no credential is attached for the baseline fetch — the RubyGems push credential
never enters Drydock at all; publishing stays in GitHub Actions via RubyGems
Trusted Publishing. If no comparable published release exists, the review runs
without a baseline (full-tree review).

## Deterministic findings

RubyGems review is deterministic-only and shares the package diff, risk model,
Ruby code-capability rules, and redaction with every other adapter. The
gem-specific rules (`rubygemsReleaseFindings`):

- `rubygems.metadata-missing` / `rubygems.metadata-mismatch` — the gemspec must
  expose a name/version and match the reviewed manifest identity.
- `rubygems.extension-build` / `rubygems.extension-added` — declared gemspec
  `extensions` compile on the consumer machine at `gem install` time; newly
  declared extensions relative to the baseline escalate.
- `rubygems.extension-install-code` — process/network/eval capability inside
  extension build files (`extconf.rb`, `mkrf_conf*.rb`, `ext/` Rakefiles,
  `Cargo.toml`).
- `rubygems.suspicious-extension-file` — shell scripts or precompiled binaries
  inside `ext/`.
- `rubygems.native-artifact` — packaged native binaries anywhere in the gem.
- `rubygems.executable-added` — executables added relative to the previous
  published release.
- `rubygems.git-dependency` — gemspec dependencies with git sources.

The RubyGems-specific pieces:

- `server/lib/adapters/rubygems/` — `rubygemsAdapter`, the `PackageAdapter` the
  shared pipeline runs for a gated gem publish: artifact preparation
  (`prepareRubygemsArtifact`), baseline selection (`acquireBaselineRubygems`),
  deterministic findings (`rubygemsReleaseFindings`), and `summarizeDetails`,
  which surfaces the reviewed digests as the report `provenance` block.
- `server/lib/workflow-gates/rubygems.ts` — `rubygemsWorkflowGateAdapter`, the
  `WorkflowGateAdapter`: `classifyArtifact` (`.gem`), `detectArtifact` (root
  `metadata.gz` with the Gem::Specification tag), and
  `prepareReleaseCandidates` (group parsed artifacts by gem identity → one
  candidate per gem).

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
      - uses: ruby/setup-ruby@v1
        with: { ruby-version: "3.3" }
      - run: mkdir -p pkg && gem build *.gemspec -o pkg/
      # Record the digest of every gem Drydock will review. These are the bytes
      # the gate approves; the publish job re-verifies against them, and they
      # match the digests shown in the Drydock report Provenance section.
      - run: cd pkg && sha256sum *.gem > SHA256SUMS
      - uses: actions/upload-artifact@v4
        with:
          name: rubygems-release-candidates # or leave blank to auto-detect
          path: |
            pkg/*.gem
            pkg/SHA256SUMS
          if-no-files-found: error

  publish:
    needs: build-release-artifacts
    runs-on: ubuntu-latest
    environment: rubygems # the gate: Drydock's deployment protection rule lives here
    permissions:
      id-token: write # OIDC for RubyGems Trusted Publishing
      contents: read
    steps:
      # No checkout, no rebuild: GitHub artifact storage is immutable, so the
      # bytes the gate approved are the bytes we download and publish here.
      - uses: actions/download-artifact@v4
        with: { name: rubygems-release-candidates, path: pkg }
      # Fail closed if the downloaded bytes differ from what was built and
      # reviewed.
      - run: cd pkg && sha256sum --check --strict SHA256SUMS
      - uses: ruby/setup-ruby@v1
        with: { ruby-version: "3.3" }
      # Exchange the OIDC token for a short-lived RubyGems API key (Trusted
      # Publishing); no long-lived credential exists anywhere in the flow.
      - uses: rubygems/configure-rubygems-credentials@v1
      - run: for gem in pkg/*.gem; do gem push "$gem"; done
```

The `environment: rubygems` line is the gate. Map the repository + environment
on `Organization settings → GitHub App` so the webhook can resolve a delivery to
your organization, configure the same environment as a RubyGems.org Trusted
Publisher for the gem, then attach Drydock as a custom deployment protection
rule on that environment. The publish job stays blocked until a maintainer
approves every gem's review in Drydock.

Gems are content-identified, so Drydock ignores `SHA256SUMS` in the bundle (it
is not a `.gem`). RubyGems.org Trusted Publishing supports pinning a GitHub
Environment; the same environment carries the Drydock gate.

## Acceptance mapping (issue #200)

- _Organization settings can map a GitHub repo + environment to a RubyGems gem_
  — release targets accept `ecosystem: "rubygems"` (or auto-detect).
- _A pending deployment protection request creates a `workflow_gate` scan with
  `ecosystem = rubygems`_ — the shared webhook path plus
  `rubygemsWorkflowGateAdapter` in the gate registry.
- _Drydock downloads and scans `.gem` release candidates from the workflow
  artifact bundle_ — the shared bundle fetcher plus the bounded gem parser in
  the credentials-free sandbox.
- _The scan compares the candidate against the previous published gem version
  when available_ — `acquireBaselineRubygems` /
  `pickRubygemsBaselineRelease` against the public RubyGems.org API.
- _Approve/reject in Drydock releases or blocks the held GitHub job_ — the
  shared gate decision path documented in `workflow-gates.md`.
- _Docs describe the required GitHub Actions workflow and the reviewed-bytes
  guarantee_ — this document.
