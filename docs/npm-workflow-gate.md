# npm workflow-gate mode

This document covers npm review through a **GitHub deployment-protection workflow
gate** — the alternative to npm staged-publish review for repositories that
publish npm packages without staged publishing.

It only describes what is npm-specific. The webhook ingestion, gate persistence,
artifact download + SHA-256 recomputation, approve/reject callback, 2FA step-up,
monorepo fan-out, notifications, and timeout handling are all **shared with the
PyPI gate** and documented in [`workflow-gates.md`](./workflow-gates.md).
Read that first for the end-to-end gate lifecycle.

## When to use it

Two ways an npm package reaches Drydock review:

| Mode                           | Boundary                                                                                         | Doc                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------- |
| **Staged publish** (preferred) | npm holds the staged tarball; Drydock fetches it by `stageId`                                    | [`architecture.md`](./architecture.md) |
| **Workflow gate** (this doc)   | the publish job is held on a GitHub Environment; Drydock reviews the uploaded `npm pack` tarball | here                                   |

Workflow-gate mode is **not** a replacement for staged-publish review. Use
staged publishing when the registry supports it; reach for a workflow gate when a
repository publishes npm packages without staging them, and wants the same
review-before-publish guarantee.

## The release candidate

There is **no manifest file and no checksum file** to write. The boundary is the
workflow run's uploaded artifacts: CI runs `npm pack` (one tarball per
publishable workspace) and uploads `dist/*.tgz` as a GitHub Actions artifact.
Drydock treats every `.tgz` / `.tar.gz` it finds as the release set.

Integrity rests on **GitHub artifact immutability**, exactly like the PyPI gate:

- Drydock downloads the artifact bytes in the control plane and recomputes each
  tarball's SHA-256 (`fetchReleaseBundleWithToken`). That digest is the reviewed
  tarball's digest, surfaced in the report and shown in the UI.
- The publish job downloads the **same immutable artifact** and runs
  `npm publish <tarball>` — it never re-packs. The bytes Drydock reviewed are the
  bytes that get published.

Drydock synthesizes an internal release manifest
(`drydock.release-artifacts.v1`, `ecosystem: "npm"`) from the parsed
`package.json` identity plus the recomputed digest. The manifest is what the
report and UI render uniformly across ecosystems; maintainers never author it.

## Auto-detection (no declared ecosystem)

An npm `.tgz` is byte- and filename-indistinguishable from a PyPI sdist
`.tar.gz`/`.tgz`, so a release target left on **auto-detect** (no pinned
ecosystem) cannot decide the ecosystem from the path alone. The gate resolves it
by **content** after parsing the archive in the credentials-free sandbox:

- an npm tarball carries a root `package.json` (the sandbox surfaces
  `package/package.json` with the `package/` prefix stripped) → **npm**;
- a PyPI sdist carries a `PKG-INFO` at the root of its single top-level directory
  → **pypi**.

This lives in the shared router (`server/lib/workflow-gates/resolve.ts`): every
artifact is parsed once, and entries the path classifier could not disambiguate
(tagged with the `AMBIGUOUS_ARCHIVE_ECOSYSTEM` sentinel) are routed by
`detectArchiveEcosystems`. A single auto-detect gate therefore reviews npm, PyPI,
or a mixed monorepo that publishes both — no one has to tell Drydock what they're
shipping. Pinning `ecosystem: "npm"` on the release target is supported but
optional.

**Ambiguity fails closed.** Package contents are untrusted, and an npm tarball
can ship arbitrary files — including a decoy root `PKG-INFO`. The router collects
_every_ ecosystem's content claim rather than taking the first match, so an
archive that presents as more than one ecosystem is rejected
(`artifact_identity_inconsistent`) instead of being silently routed to one and
skipping the other's findings. A maintainer resolves a genuine collision by
pinning the release target's ecosystem, which bypasses content detection. PyPI's
`PKG-INFO` match is scoped to the sdist root location so a file vendored deep
inside an npm tarball does not look like a sdist.

## Monorepo

`npm run pack:all` → `dist/*.tgz` (one tarball per workspace) fans out into one
review per package: tarballs are grouped by their `package.json` name and each
group is scanned against its own previously-published baseline. The held
deployment releases only once every package is individually approved; rejecting
any one package blocks the whole release.

A single npm package version is exactly one tarball, so two tarballs that claim
the same name (whether the versions agree or not) is treated as inconsistent and
fails the gate closed (`artifact_identity_inconsistent`). A tarball with no
`package.json` name/version fails closed too (`artifact_identity_missing`).

## Baseline (currently-published version)

The baseline is the currently-published npm version, selected and fetched through
the **organization's npm connection** — the same path the staged-publish adapter
uses (`acquireBaselineNpm`, `pickBaselineVersion`). Private packages resolve
because the org token is attached, and the token never enters the sandbox: the
published tarball is fetched by the trusted parent worker and parsed
credentials-free. If no npm connection is configured (or it is invalid), the
review runs without a baseline (full-tree review).

## Code sharing

The npm review behaves identically whether a package arrives via staged publish
or workflow gate, because both share the deterministic findings, package diff,
risk model, and baseline selection:

- `server/lib/adapters/npm/gate.ts` — `npmGateAdapter`, the `PackageAdapter` the
  shared pipeline runs for a gated npm publish. It reassembles the already-parsed
  tarball (no broker, no sandbox call for the staged side) and delegates baseline
  (`acquireBaselineNpm`), findings (`buildNpmFindings`), and the broker
  (`createNpmBroker`) to the shared npm adapter code. The only npm-gate-specific
  bits are input parsing and surfacing the reviewed digest in the report.
- `server/lib/adapters/npm/manifest.ts` — the synthesized release-manifest type +
  validator.
- `server/lib/workflow-gates/npm.ts` — `npmWorkflowGateAdapter`, the
  `WorkflowGateAdapter`: `classifyArtifact` (`.tgz`/`.tar.gz`), `detectArtifact`
  (root `package.json`), and `prepareReleaseCandidates` (group parsed tarballs by
  package identity → one candidate per package).

The staged-publish `npmAdapter` (`server/lib/adapters/npm/index.ts`) is
unchanged: staged scans keep their existing behavior and routes.

## Workflow shape

A worked monorepo example lives at
[`JoviDeCroock/drydock-npm-monorepo-ci-example`](https://github.com/JoviDeCroock/drydock-npm-monorepo-ci-example/blob/main/.github/workflows/release.yml).
The shape:

```yaml
jobs:
  build-release-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22", registry-url: "https://registry.npmjs.org" }
      - run: npm run pack:all # npm pack each publishable workspace into dist/*.tgz
      - uses: actions/upload-artifact@v4
        with:
          name: npm-release-candidates # or leave blank in the release target to auto-detect
          path: dist/*.tgz
          if-no-files-found: error

  publish:
    needs: build-release-artifacts
    runs-on: ubuntu-latest
    environment: npm # the gate: Drydock's deployment protection rule lives here
    permissions:
      id-token: write # OIDC for npm provenance / Trusted Publishing
      contents: read
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: "22", registry-url: "https://registry.npmjs.org" }
      # No checkout, no re-pack: GitHub artifact storage is immutable, so the
      # bytes the gate approved are the bytes we download and publish here.
      - uses: actions/download-artifact@v4
        with: { name: npm-release-candidates, path: dist }
      - run: |
          shopt -s nullglob
          for tgz in dist/*.tgz; do
            npm publish "$tgz" --access public --provenance
          done
```

The `environment: npm` line is the gate. Map the repository + environment on
`Organization settings → GitHub App` so the webhook can resolve a delivery to
your organization, then attach Drydock as a custom deployment protection rule on
that environment. The publish job stays blocked until a maintainer approves every
package's review in Drydock.

## Acceptance mapping (issue #144)

- _A deployment-protection request for an npm target produces a stored review and
  approve/reject callback_ — shared gate machinery; the npm bundle resolves to
  `npmGateAdapter` scans linked to the gate.
- _The report shows the reviewed tarball digest and npm package/version_ —
  `npmGateAdapter.summarizeDetails` persists the recomputed digest + synthesized
  manifest.
- _Existing npm staged-publish scans keep their current behavior and routes_ —
  `npmAdapter` is untouched; the gate uses a separate adapter.
- _Tarball/identity verification before review_ — the reviewed digest is bound to
  the immutable artifact bytes; a tarball with missing/inconsistent
  `package.json` identity fails the gate closed before any scan runs.
