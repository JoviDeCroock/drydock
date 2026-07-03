# Workflow Gates

Workflow gates are Drydock's review mode for releases whose registry cannot hold a private staged artifact. GitHub Actions builds the release, uploads the candidate artifacts, and a GitHub Environment custom deployment-protection rule pauses publishing while Drydock reviews the bytes.

Supported gate ecosystems: **PyPI**, **npm**, and **RubyGems**. Shared GitHub plumbing lives in `server/lib/workflow-gates/`; artifact-specific behavior lives behind adapters. npm workflow-gate specifics are documented in [`npm-workflow-gate.md`](./npm-workflow-gate.md), and RubyGems specifics are documented in [`rubygems-workflow-gate.md`](./rubygems-workflow-gate.md).

## Core Contract

1. A repository installs the Drydock GitHub App and configures a GitHub Environment with Drydock as a deployment-protection rule.
2. The publish workflow builds release artifacts and uploads them before the protected publish job starts.
3. GitHub sends a `deployment_protection_rule` webhook to `/webhooks/github`.
4. Drydock resolves the installation, repository, run, environment, release target, and uploaded artifacts.
5. The adapter derives one or more reviewable release candidates from those artifacts.
6. A queue worker runs the shared scan pipeline for each candidate.
7. A maintainer accepts or rejects the gate review in Drydock.
8. Drydock posts the deployment-protection decision back to GitHub; the workflow either continues to publish or fails closed.

The GitHub webhook is public but signed with `GITHUB_WEBHOOK_SECRET` and bypasses Better Auth only after signature verification. All stored gate state remains organization-scoped.

## Shared Implementation

- `server/routes/github-webhooks.ts` verifies GitHub webhook signatures and persists gate deliveries.
- `server/routes/github-app.ts` handles App install/callback setup.
- `server/routes/release-targets.ts` maps organizations to GitHub repositories/environments/ecosystems.
- `server/routes/workflow-gates.ts` exposes pending/completed gate review APIs and accept/reject actions.
- `server/lib/workflow-gates/` resolves workflow runs, artifacts, release targets, callback URLs, and gate lifecycle state.
- `server/lib/scan-pipeline.ts` runs the same deterministic/AI/report pipeline used by npm registry-staged scans.

Required bindings/secrets include the GitHub App id/private key/client credentials, webhook secret, installation access, queues, D1, R2, and normal scan pipeline bindings. See [`self-hosting.md`](./self-hosting.md) for setup.

## Release Set Derivation

A release set is the boundary between CI and Drydock. Drydock never trusts a maintainer-declared manifest as authority over reviewed bytes; it recomputes identity and digest evidence from the uploaded artifacts themselves.

For every candidate artifact set, adapters must provide:

- package/project identity and version;
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

## PyPI Workflow-Gate Notes

PyPI has no `drydock-manifest.json`. The release set is whatever wheels and sdists the workflow uploads, with identity parsed from wheel `METADATA` or sdist `PKG-INFO`.

The PyPI adapter (`server/lib/adapters/pypi/`):

- normalizes project names with the PEP 503 `[-_.]+ -> -` convention;
- accepts `.whl`, `.tar.gz`, and `.tgz` artifacts;
- parses wheel `METADATA`, `WHEEL`, and `RECORD` from ZIP archives;
- strips the common sdist root before reading `PKG-INFO`;
- groups artifacts by normalized project name and requires a shared version inside each group;
- selects the default baseline from PyPI `info.version`, falling back to newest non-yanked upload time;
- downloads matching baseline wheels/sdists through a credential-free broker restricted to `https://files.pythonhosted.org`;
- reports metadata mismatches, missing wheel `RECORD`, `.pth` startup hooks, custom `setup.py` install commands, and `.pyd` native extensions.

## npm Workflow-Gate Notes

Use npm workflow gates when CI publishes from built artifacts instead of `npm publish --stage`, or when the release must be paused by GitHub rather than npm registry staging.

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
          name: npm-package
          path: |
            *.tgz
            SHA256SUMS
  publish:
    needs: pack
    environment: production
    steps:
      - uses: actions/download-artifact@v4
      # Fail closed if the downloaded bytes drifted from what was reviewed.
      - run: sha256sum --check --strict SHA256SUMS
      - run: npm publish *.tgz
```

Drydock should be the deployment-protection rule for the `production` environment. The publish job must consume the exact uploaded artifact reviewed by Drydock; rebuilding after approval breaks the review boundary. The `SHA256SUMS` record/check pair makes that enforceable in CI: the digests match the ones Drydock recomputes and shows in the report Provenance section, and the publish job fails closed on any drift. Drydock ignores `SHA256SUMS` in the bundle (it is not a `.tgz`).

See [`pypi-workflow-gate.md`](./pypi-workflow-gate.md) for the PyPI-specific
workflow shape, including build-time `SHA256SUMS` generation and publish-time
verification.

## RubyGems Workflow-Gate Notes

RubyGems has no registry-side staging step for external review. The candidate is the uploaded `.gem` artifact, and the protected publish job must download and push that exact reviewed file through RubyGems Trusted Publishing. Do not rebuild after approval.

The RubyGems adapter (`server/lib/adapters/rubygems/`):

- classifies `.gem` files by path; unlike npm `.tgz` versus PyPI sdists, `.gem` is not content-ambiguous;
- parses RubyGems' uncompressed outer tar, then bounded `metadata.gz` and `data.tar.gz` members;
- derives gem name, version, platform, executables, extensions, dependencies, requirements, and metadata from the Gem::Specification YAML;
- groups native platform variants by normalized gem name and requires each group to share one version;
- rejects missing identity, version skew, and duplicate name/platform artifacts fail-closed;
- selects the current published baseline from the RubyGems versions API and downloads matching staged platforms from `https://rubygems.org/downloads/`;
- reports metadata mismatches, missing metadata, native extension build hooks, and unexpected `metadata.allowed_push_host` values.

See [`rubygems-workflow-gate.md`](./rubygems-workflow-gate.md) for the complete RubyGems workflow and parser trust boundary.

## Trust and Failure Behavior

- The GitHub webhook signature is mandatory.
- Gate decisions must resolve to the original installation, repository, workflow run, environment, and callback URL.
- Artifact digests are recomputed by Drydock from downloaded bytes.
- Package identity comes from artifact metadata, not GitHub paths or artifact names alone.
- If artifact resolution, baseline acquisition, validation, scan, or callback fails, the gate remains blocked or is rejected; do not fail open.
- Drydock never publishes. It only posts the GitHub deployment-protection decision.

## Maintainer Workbench

The gate review workbench shows the release target, package identity/version, artifact set, scan status, findings, changed files, and accept/reject controls. Accept/reject actions require an authenticated maintainer in the owning organization. Step-up auth requirements should match other sensitive release decisions; see [`two-factor-auth.md`](./two-factor-auth.md).

## Adding A New Ecosystem

1. Add or extend a package adapter under `server/lib/adapters/<ecosystem>/`.
2. Implement release-set derivation from uploaded artifact bytes.
3. Define baseline acquisition and artifact namespace matching.
4. Add deterministic findings for ecosystem-specific risky behavior.
5. Register the adapter with workflow-gate resolution.
6. Add Worker-route tests for webhook/gate lifecycle and adapter tests for archive/metadata/baseline behavior.
7. Add fake-registry or fake-artifact e2e coverage when the publish workflow or browser-visible review flow changes.

## Provenance Surfacing

Each gate adapter's `summarizeDetails` emits a `provenance` block — `{ ecosystem,
mode, artifacts: [{ path, kind, sha256 }] }` — built from the digests the control
plane recomputed from the immutable bundle bytes. It is persisted in
`summary.stagedPublish`, rendered as the report **Provenance** section in the
scan workbench, and re-validated into the `report.json` export as a top-level
`provenance` field. A maintainer's CI can compare those digests against the
checksum file it built and the bytes it is about to publish, closing the
byte-continuity loop without trusting any single step.

## Remaining Work

- Expand gate-specific e2e coverage as more ecosystems are added.
- Keep GitHub/PyPI/npm/RubyGems validation failures user-actionable without leaking credentials or private package bytes.
