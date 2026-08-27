# Workflow Gates

Workflow gates are Drydock's review mode for releases whose registry cannot hold a private staged artifact. GitHub Actions builds the release, uploads the candidate artifacts, and a GitHub Environment custom deployment-protection rule pauses publishing while Drydock reviews the bytes.

Supported gate ecosystems: **PyPI**, **npm**, **VS Code extensions**, and **browser extensions**. Shared GitHub plumbing lives in `server/lib/workflow-gates/`; artifact-specific behavior lives behind adapters.

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

Candidate name and version come from each artifact's own metadata: wheel `METADATA`, sdist `PKG-INFO`, npm `package.json`, VSIX `extension/package.json` (`publisher.name` + `version`), or a WebExtension's root `manifest.json` (Gecko id when present, otherwise its display name, plus version). Registry package names and marketplace IDs are stable cross-release identities; display-only browser names are not. Adapters may therefore opt a candidate out of release history and name-indexed public surfaces while still giving the current gate a readable label. Files are grouped by normalized package name where the ecosystem has one, and artifacts that share a stable identity must agree on the version. Distinct candidate names are separate releases, which is the expected monorepo shape.

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

## Browser-extension workflow-gate notes

Browser-extension gates review packed WebExtension `.zip` and `.xpi` archives before a workflow uploads them to the Chrome Web Store, Firefox Add-ons, or another compatible store. The archive must contain `manifest.json` at its root. Drydock derives a stable identity from a valid email-style or GUID `browser_specific_settings.gecko.id`, preserving the ID's declared casing, and falls back to the legacy `applications.gecko.id` only for Manifest V2. Otherwise it uses the manifest name only as the current review's display label; a `__MSG_name__` reference is resolved from the manifest's declared default-locale `_locales/<locale>/messages.json`, and missing or malformed localization evidence fails the review closed. The version always comes from `manifest.json`. Because a Chrome display name is neither unique nor stable, name-only archives are kept separate by release artifact, excluded from cross-release package history, and may appear in the chronological threat feed, but they are not exposed through the name-indexed public badge endpoint.

Choose **Browser extension** in the release target's **Artifact ecosystem** selector when publishing a `.zip`. ZIP is also a generic CI/source-artifact extension, so unpinned auto-detection deliberately ignores it instead of letting an unrelated ZIP block another ecosystem's gate. Browser-specific `.xpi` artifacts remain safe to auto-detect.

The browser adapter (`server/lib/ecosystems/browser/`):

- parses ZIP/XPI bytes in the shared credential-free sandbox and retains root `manifest.json` as identity evidence;
- supports Manifest V2 and V3, requires a valid display name, a one-to-four-component numeric WebExtension version, and a valid manifest version, and treats only validated Gecko IDs as stable identities;
- requires one archive per stable extension identity in a release target and keeps name-only archives distinct by verified artifact digest, so unrelated Chrome archives with the same display name cannot be merged;
- runs shared JavaScript, secret, native-artifact, suspicious-archive, and file-diff rules, treating manifest-loaded background scripts, token-validated classic-worker `importScripts()` dependencies (resolved against their worker entry, including the top-level `this` global), content scripts, extension pages (including root-relative popup, options, sandbox, protocol-handler, HTML/SHTML, XML, XHTML, standalone SVG, and suffixless packaged paths, with each page retaining its own document base and inline event-handler code), packaged pages opened through HTML or SVG links, refresh metadata, multiline static ESM imports and commented literal dynamic imports, literal `runtime.getURL()` or static `new URL(..., import.meta.url)` dynamic imports that retain their page, worker, or module execution base (including `.href` and `.pathname` projections), literal packaged sources assigned directly or with `setAttribute()` to dynamically created script, frame, iframe, embed, object, hyperlink, and HTML-namespaced script elements whose bindings are initialized at declaration or by direct assignment or returned from `appendChild(document.createElement(...))` (with dynamically inserted scripts retaining every candidate document base, including dynamically assigned `<base>` URLs, for nested relative Worker and navigation URLs), literal documents written through `document.write()`/`writeln()`, `innerHTML`/`outerHTML` assignment (including `+=`), `insertAdjacentHTML()`, or iframe `srcdoc`, including their inline executable code, and resolved against their inherited document base, literal DOM navigation (including unqualified `open()`, `runtime.getURL()`, static `new URL(..., import.meta.url)` values, and static `new URL()` values resolved against `location.href` or the document URL/base, semicolonless assignments, `window.document.location`, and `self`/`globalThis`/`this`/`top`/`parent` window aliases), or literal `tabs.create({ url })`, `tabs.update({ url })`, `windows.create({ url })`, Firefox `sidebarAction.setPanel({ panel })`, and DevTools sidebar `setPage()` calls (including computed literal option and member keys, recursive literal object or array spreads, Unicode-escaped identifiers, literal `runtime.getURL()`, and legacy `extension.getURL()` wrappers), with runtime-opened documents receiving their own execution base, pages nested through HTML frames, objects, or embeds, direct or `import.meta.url` Worker paths (including plain nested Worker paths resolved against their parent worker and plain Worker paths from generated Manifest V2 background pages), and packaged script paths injected through direct or global-object-qualified dot/bracket notation in `tabs.executeScript()` or Manifest V3 scripting APIs as consumer entrypoints regardless of their directory names, with context-independent file-source parsing cached and total execution-context and dependency-resolution work bounded, and with document references collected by a deliberately conservative flat token scan supplemented by bounded XML qualified-name, decoded internal-entity, expanded-attribute, and inherited `xml:base` handling for XML/XHTML/SVG — script MIME types, namespaces, raw text, CDATA, templates, comments, and self-closing syntax are not modeled, so every URL-shaped reference in a reachable document counts and only a missed edge is a defect (see the `1.58.0` through `1.80.0` notes in [`security-detection-corpus.md`](./security-detection-corpus.md)); manifest-declared web-accessible resources, including XML/XHTML/SVG and suffixless documents, are expanded within fixed declaration, XML-entity, wildcard-work, and reachability budgets so hostile manifests cannot cause unbounded review work;
- reports privileged browser/data permissions, all-sites host access, all-sites content scripts, broad external messaging, unsafe extension-page or sandbox CSP, and release/manifest identity mismatches;
- records the exact archive kind and SHA-256 in report provenance;
- does not invent a public baseline: Chrome packages usually do not embed a store id, and store download availability differs by channel. A gate without an explicit previous artifact records `comparisonSkipped: "baseline-unavailable"`, treats findings as package context rather than release deltas, and recommends manual review instead of grading an all-added diff as a release change.

Recommended workflow shape:

```yaml
jobs:
  package:
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run build:extension
      - run: npx web-ext build --source-dir dist/extension --artifacts-dir dist --filename extension.zip
      - run: cd dist && sha256sum extension.zip > SHA256SUMS
      - uses: actions/upload-artifact@v4
        with:
          name: browser-extension-release-candidate
          path: |
            dist/extension.zip
            dist/SHA256SUMS
  publish:
    needs: package
    environment: production
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: browser-extension-release-candidate
          path: dist
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      # This command must upload dist/extension.zip as-is; it must not rebuild.
      - run: npm run publish:browser-extension -- dist/extension.zip
```

Store credentials remain in the protected publish job. If one workflow publishes separate Chrome and Firefox archives, use separate protected environments/release targets so each gate has one unambiguous archive and digest. The settings form keeps a repository selectable after its first mapping and removes only environments already mapped for that repository.

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
- Keep GitHub/PyPI/npm/VS Code/browser validation failures user-actionable without leaking credentials or private package bytes.
