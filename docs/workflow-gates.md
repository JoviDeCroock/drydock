# Workflow Gates

Workflow gates are Drydock's review mode for releases whose registry cannot hold a private staged artifact. GitHub Actions builds the release, uploads the candidate artifacts, and a GitHub Environment custom deployment-protection rule pauses publishing while Drydock reviews the bytes.

Supported gate ecosystems: **PyPI**, **npm**, and **VS Code extensions**. Shared GitHub plumbing lives in `server/lib/workflow-gates/`; artifact-specific behavior lives behind adapters.

atpm has no gate. Its releases are reviewed through an anonymous link from atpm's own staged dashboard, and approving stays entirely on atpm's side; see [`atpm-trusted-publishing.md`](./atpm-trusted-publishing.md).

## Core contract

1. A repository installs the Drydock GitHub App and configures a GitHub Environment with Drydock as a deployment-protection rule.
2. The publish workflow builds release artifacts and uploads them before the protected publish job starts.
3. GitHub sends a `deployment_protection_rule` webhook to `/webhooks/github`.
4. Drydock resolves the installation, repository, run, environment, release target, and uploaded artifacts.
5. The adapter derives one or more reviewable release candidates from those artifacts.
6. A queue worker runs the shared scan pipeline for each candidate.
7. A maintainer accepts or rejects the gate review in Drydock.
8. Drydock posts the deployment-protection decision back to GitHub; the workflow either continues to publish or fails closed.

The GitHub webhook is public but signed with `GITHUB_APP_WEBHOOK_SECRET` and bypasses Better Auth only after signature verification. All stored gate state remains organization-scoped.

## Shared implementation

- `server/routes/github-webhooks.ts` verifies GitHub webhook signatures and persists gate deliveries.
- `server/routes/github-app/installations.ts` handles App install/callback setup.
- `server/routes/release-targets.ts` maps organizations to GitHub repositories/environments/ecosystems.
- `server/routes/workflow-gates.ts` exposes pending/completed gate review APIs and accept/reject actions.
- `server/lib/workflow-gates/` resolves workflow runs, artifacts, release targets, callback URLs, and gate lifecycle state.
- `server/lib/scan/pipeline.ts` runs the same deterministic/AI/report pipeline used by npm registry-staged scans.

Required bindings/secrets include the GitHub App id/private key/client credentials, webhook secret, installation access, queues, D1, R2, and normal scan pipeline bindings. See [`self-hosting.md`](./self-hosting.md) for setup.

## Release set derivation

A release set is the boundary between CI and Drydock. Drydock never trusts a maintainer-declared manifest as authority over reviewed bytes; it recomputes identity and digest evidence from the uploaded artifacts themselves.

Package identity and version come from each artifact's own metadata: wheel `METADATA`, sdist `PKG-INFO`, npm `package.json`, or VSIX `extension/package.json` (`publisher.name` + `version`). Every artifact must expose a package identity and version; files are grouped by normalized package name where the ecosystem has one, and artifacts that share a name must agree on the version. Distinct package names are separate releases, which is the expected monorepo shape.

For every candidate artifact set, adapters must provide:

- package/project/extension identity and version;
- ecosystem and artifact kind;
- normalized file list and hashes;
- current candidate bytes;
- previous-release baseline bytes when available;
- deterministic findings specific to that ecosystem;
- enough metadata to show the maintainer exactly what was reviewed.

If a workflow uploads artifacts for several packages, Drydock fans out into separate gate reviews. Accepting one package must not approve another package's release.

Dropping maintainer-declared manifests removes the explicit "ship exactly these
N files, at these digests" declaration. Byte integrity between review and publish
rests on GitHub artifact immutability plus the publish job never rebuilding. For
ecosystems that can record publish-side checksums, the recommended workflow
records a checksum file during build and verifies it immediately before upload.
Those digests match the ones Drydock recomputes and surfaces in the report
Provenance section and `report.json` (`provenance.artifacts[]`), so the build,
review, and publish all hash the same bytes.

## PyPI workflow-gate notes

PyPI has no `drydock-manifest.json`. The release set is whatever wheels and sdists the workflow uploads, with identity parsed from wheel `METADATA` or sdist `PKG-INFO`.

The PyPI adapter (`server/lib/ecosystems/pypi/`):

- normalizes project names with the PEP 503 `[-_.]+ -> -` convention;
- accepts `.whl`, `.tar.gz`, and `.tgz` artifacts;
- parses wheel `METADATA`, `WHEEL`, and `RECORD` from ZIP archives;
- strips the common sdist root before reading `PKG-INFO`;
- groups artifacts by normalized project name and requires a shared version inside each group;
- discovers the conventional `pypi-release-candidate` upload plus
  `pypi-release-candidate-*` shards (pinned release targets only), parsing one
  bounded Actions artifact at a time and retaining every distribution digest;
- selects the default baseline from PyPI `info.version`, falling back to newest non-yanked upload time;
- downloads matching baseline wheels/sdists sequentially through a
  credential-free broker restricted to `https://files.pythonhosted.org`;
- records `comparisonSkipped: "baseline-too-large"` when the published release
  exceeds the download budget, so findings stay `unknown` package context and the
  report names the missing comparison instead of grading an uncompared release;
- reports metadata mismatches, missing wheel `RECORD`, `.pth` startup hooks, custom `setup.py` install commands, and `.pyd` native extensions.

## npm workflow-gate notes

Use npm workflow gates when CI publishes from built artifacts instead of `npm stage publish`, or when the release must be paused by GitHub rather than npm registry staging.

The candidate is the uploaded npm pack artifact. Drydock detects npm candidates from `package.json` in the archive, normalizes package identity, and compares against the currently published baseline using the same npm adapter projection used by registry-staged scans.

Recommended workflow shape:

```yaml
jobs:
  pack:
    steps:
      - run: npm ci
      - run: npm pack --json > pack.json
      # Record the digests Drydock reviews and the publish job re-checks.
      - run: sha256sum *.tgz > SHA256SUMS
      - uses: actions/upload-artifact@v4
        with:
          name: npm-release-candidates
          path: |
            *.tgz
            SHA256SUMS
  publish:
    needs: pack
    environment: production
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: npm-release-candidates
      # Fail closed if the downloaded bytes drifted from what was reviewed.
      - run: sha256sum --check --strict SHA256SUMS
      - run: npm publish *.tgz
```

Drydock should be the deployment-protection rule for the `production` environment. The publish job must consume the exact uploaded artifact reviewed by Drydock; rebuilding after approval breaks the review boundary. The `SHA256SUMS` record/check pair makes that enforceable in CI: the digests match the ones Drydock recomputes and shows in the report Provenance section, and the publish job fails closed on any drift. Drydock ignores `SHA256SUMS` in the bundle (it is not a `.tgz`).

To make this gated workflow the _only_ credentialed publish path — npm trusted publishing pinned to the gate environment, tokens disallowed — see [`npm-trusted-publishing.md`](./npm-trusted-publishing.md).

See [`pypi-workflow-gate.md`](./pypi-workflow-gate.md) for the PyPI-specific
workflow shape, including build-time `SHA256SUMS` generation and publish-time
verification.

## VS Code workflow-gate notes

VS Code extension gates review uploaded `.vsix` artifacts before a workflow publishes them to the Marketplace. Identity is derived from `extension/package.json` inside the VSIX as `publisher.name` plus `version`.

The VS Code adapter (`server/lib/ecosystems/vscode/`):

- accepts `.vsix` artifacts and parses them through the shared ZIP sandbox;
- strips the VSIX `extension/` payload prefix before deterministic review;
- requires a constrained `engines.vscode` value and safe extension identity fields;
- groups by extension id and requires a single VSIX per extension release;
- resolves a best-effort baseline from the public VS Code Marketplace, then downloads only allowed Marketplace or `*.gallerycdn.vsassets.io` VSIX assets without credentials;
- treats Marketplace baseline lookup as a diff aid only: metadata, download, parse, or identity failures degrade to a no-baseline review;
- reports metadata mismatches, broad startup activation, startup remote-command loaders, startup WebAssembly loaders, undeclared configuration reads, and transitive extension installs.

Recommended workflow shape:

```yaml
jobs:
  package:
    steps:
      - run: npm ci
      - run: npx @vscode/vsce package --out dist/extension.vsix
      - uses: actions/upload-artifact@v4
        with:
          name: vscode-release-candidate
          path: dist/*.vsix
  publish:
    needs: package
    environment: production
    steps:
      - uses: actions/download-artifact@v4
      - run: npx @vscode/vsce publish --packagePath dist/*.vsix
```

The publish job must publish the reviewed VSIX bytes. Repacking after approval breaks the review boundary.

## Trust and failure behavior

- The GitHub webhook signature is mandatory.
- Gate decisions must resolve to the original installation, repository, workflow run, environment, and callback URL.
- Artifact digests are recomputed by Drydock from downloaded bytes.
- Package identity comes from artifact metadata, not GitHub paths or artifact names alone.
- If artifact resolution, baseline acquisition, validation, scan, or callback fails, the gate remains blocked or is rejected; do not fail open.
- Drydock never publishes. It only posts the GitHub deployment-protection decision.

## Maintainer workbench

The gate review workbench shows the release target, package identity/version, artifact set, scan status, findings, changed files, and accept/reject controls. Accept/reject actions require an authenticated maintainer in the owning organization. Step-up auth requirements should match other sensitive release decisions; see [`two-factor-auth.md`](./two-factor-auth.md).

## Adding a new ecosystem

1. Add or extend a package adapter under `server/lib/ecosystems/<ecosystem>/`.
2. Implement release-set derivation from uploaded artifact bytes.
3. Define baseline acquisition and artifact namespace matching.
4. Add deterministic findings for ecosystem-specific risky behavior.
5. Register the adapter with workflow-gate resolution.
6. Add Worker-route tests for webhook/gate lifecycle and adapter tests for archive/metadata/baseline behavior.
7. Add fake-registry or fake-artifact e2e coverage when the publish workflow or browser-visible review flow changes.

## Provenance surfacing

Each gate adapter's `summarizeDetails` emits a `provenance` block — `{ ecosystem,
mode, artifacts: [{ path, kind, sha256 }] }` — built from the digests the control
plane recomputed from the immutable bundle bytes. It is persisted in
`summary.stagedPublish`, rendered as the report **Provenance** section in the
scan workbench, and re-validated into the `report.json` export as a top-level
`provenance` field. A maintainer's CI can compare those digests against the
checksum file it built and the bytes it is about to publish, closing the
byte-continuity loop without trusting any single step.

## Remaining work

- Expand gate-specific e2e coverage as more ecosystems are added.
- Keep GitHub/PyPI/npm/VS Code validation failures user-actionable without leaking credentials or private package bytes.
