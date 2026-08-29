# Workflow Gate — enforced

Workflow Gate is Drydock's **enforced** mode for releases whose registry cannot hold a private staged artifact. GitHub Actions builds the release, uploads the candidate artifacts, and a GitHub Environment custom deployment-protection rule pauses the configured protected publish job while Drydock reviews the bytes. Drydock can approve or reject that job; it does not claim authority over publication paths outside the configured workflow.

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

## Guided setup

Step 1 of the contract used to be a manual walk through GitHub settings. **Settings → Integrations → Guided gate setup** (`/dashboard/settings#gate-setup`) now walks it with Drydock generating the workflow and checking the result:

1. Pick the installation and repository the App can already see.
2. Create the GitHub Environment (Drydock links straight to the repository's environment settings), then **Check it** — Drydock reads that environment back by name.
3. Enable Drydock as that environment's custom deployment-protection rule in GitHub, then **Check it** — Drydock reads the environment's protection rules and confirms its own App id is among them.
4. Pick the ecosystem and package name; Drydock generates the publish workflow for it.
5. Copy the workflow, or follow the link to GitHub's new-file editor with the path prefilled, and commit it yourself.
6. Create the matching release target, which is the same `POST /release-targets` the manual form uses — pinned to the chosen ecosystem rather than left on auto-detect, because pinning is what enables the ecosystem's own artifact-name matching (notably PyPI's `pypi-release-candidate-*` shards).

A maintainer who has not installed the GitHub App yet still lands on this section: it renders an install prompt in place of the wizard rather than nothing, so the `#gate-setup` deep link never dead-ends. Organization members see the same anchored section with an owner/admin-required explanation instead of controls that can only return `403`.

### Why Drydock does not do the GitHub steps for you

Creating the environment and registering the protection rule need **Administration: write**; committing a file under `.github/workflows/` needs **Contents: write** plus **Workflows: write**, and opening the pull request needs **Pull requests: write**. Those are standing grants on every gated repository, and `workflows: write` is specifically the power to rewrite the workflow the gate exists to protect — the same power the wizard's own hardening checklist tells you to lock down with `CODEOWNERS`. A security tool should not hold it to save a dozen one-time clicks.

Acting _as_ the gate needs none of that. GitHub's only requirement for the review callback is that an App may review its own custom deployment-protection rules, so Drydock's runtime permissions are unchanged by guided setup. The App's full registration — two read-only repository permissions and two webhook events — is in [`self-hosting.md`](./self-hosting.md#repository-permissions).

Everything the wizard reads is repository-read tier and already used by the release-target form:

| Endpoint                   | Does                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `POST /gate-setup/preview` | Renders the ecosystem's workflow YAML for a draft. No GitHub calls.                                  |
| `POST /gate-setup/verify`  | Reads `GET /repos/{o}/{r}`, `GET .../environments/{name}` and `GET .../deployment_protection_rules`. |

Both are owner/admin-only (`roleCanManageIntegrations`), scoped through `ensureInstallationOwnedBy`, and organization-rate-limited, with the same session posture as `POST /release-targets`. Guided setup writes no audit rows, because it makes no change to audit.

### Verification, not bookkeeping

`verify` returns `{ environment, protectionRule, adminBypass, defaultBranch }`. `environment` and `protectionRule` are `present`, `absent`, or `unknown`. A read Drydock could not complete resolves to `unknown` — never to a confident `absent` — and that includes an installation token GitHub would not mint for a transient reason (5xx, rate limit). A token GitHub refuses outright (403 suspended, 404 removed) is the explicit `installation_inactive` 409 instead; a 403 that is really a rate limit (a `retry-after` header, an exhausted `x-ratelimit-remaining`, or a message saying so) is not. The wizard's other GitHub calls — the repository and environment lists, release-target create — classify a mint the same way, answering `github_unavailable` (503) for one that did not complete. No gate-setup route forwards GitHub's response body (the messages carry its status only), and nothing on these paths logs a body, header, or the installation token.

The wizard renders a gate as armed only when GitHub reports `protectionRule: "present"` **and** the organization has a release target mapped to that repository and environment — without the mapping, the webhook has nowhere to route and the gate holds nothing. That is a read of GitHub's live state rather than a record of what Drydock believes it did, so it also catches a rule that was switched off after setup.

`adminBypass` is `allowed`, `blocked`, or `unknown`, read from the environment's `can_admins_bypass` field (GitHub's "Allow administrators to bypass configured protection rules", on by default). It is reported beside the gate rather than folded into it: the rule still holds every run nobody overrides, but a repository admin can push a held release past Drydock, so the wizard warns and links to the environment settings to turn it off. The field is missing from GitHub's published OpenAPI description, so anything but an explicit boolean is `unknown`.

Identity allowlisting (`assertGateSetupEnvironment` / `assertGateSetupPackageName`, `GATE_SETUP_*_RE` in `server/lib/github-app/validation.ts`) applies to `preview` only: those values are interpolated into YAML a maintainer will merge. `verify` deliberately accepts any name GitHub accepted, because an environment created by hand — `production/eu`, say — still has to be checkable and mappable; only the generated workflow is unavailable for it.

Existing mappings are detected in the wizard, and a pinned ecosystem stays locked until the maintainer explicitly removes that mapping, avoiding a duplicate create against the unique repository/environment pair.

### Generated workflows

The YAML comes from the ecosystem's gate adapter, through the optional `gateSetupTemplate({ environmentName, packageName })` method on `WorkflowGateAdapter` (`server/lib/ecosystems/<id>/workflow-gate.ts`). The `/github-app/config` response derives the wizard's ecosystem choices from that same registry, so adding a template also makes the option visible without a second client-side list. Routes never branch on ecosystem names; an ecosystem with no template is a 400 and the maintainer falls back to the shapes documented below. Each template writes `.github/workflows/drydock-<ecosystem>-release.yml` and reproduces the canonical contract: build once, record `SHA256SUMS`, upload both, gate the publish job on `environment:`, re-verify with `sha256sum --check --strict`, publish the reviewed bytes.

The generated workflows are also least-privilege, and each property is pinned by `test/workers/gate-setup-template.test.ts`:

- Top-level `permissions: {}`. The build job gets `contents: read` and nothing else; the npm and PyPI publish jobs get `id-token: write` and nothing else; the VS Code publish job gets `contents: read` for its lockfile and nothing else, because its only credential is the Marketplace PAT in the environment's secrets.
- `actions/checkout` runs with `persist-credentials: false`, since the build job goes on to run dependency install scripts and build backends.
- Every action is pinned to a full commit SHA with its release in a trailing comment (`server/lib/workflow-gates/gate-setup-actions.ts`), which Dependabot's `github-actions` updates can move. `setup-node` restores no package-manager cache in a release build.
- Tools that run beside a credential are pinned as a whole tree, not just by name. The npm and VS Code publish jobs install an exact npm CLI (`GATE_SETUP_NPM_CLI_VERSION` in `server/lib/workflow-gates/gate-setup-actions.ts`) — npm's OIDC publishing needs 11.5.1 or newer, and `--allow-git` is npm 11 only; npm bundles its own dependencies, so that version pins everything it loads. `vsce` does not bundle its dependencies, so `npx @vscode/vsce@x.y.z` would still resolve their ranges fresh on every run — beside a Marketplace PAT that is not bound to the workflow and outlives it. The VS Code template therefore runs `vsce` from the repository's own lockfile (a `devDependency`) in both jobs, and the publish job installs that tree with `npm ci --ignore-scripts --allow-git=none`: npm still runs a git dependency's prepare scripts under `--ignore-scripts`, so git dependencies are refused outright beside the PAT.
- The npm publish carries no `--provenance`: trusted publishing attaches provenance by itself from a public repository, and the flag fails the publish from a private one.
- The PyPI template is the single-build shape. A platform wheel matrix needs the sharded example in [`pypi-workflow-gate.md`](./pypi-workflow-gate.md#large-compiled-releases).

Drydock generates these files but does not review them. Read the workflow before you commit it.

## Shared implementation

- `server/routes/github-webhooks.ts` verifies GitHub webhook signatures and persists gate deliveries.
- `server/routes/github-app/installations.ts` handles App install/callback setup.
- `server/routes/github-app/gate-setup.ts` and `server/lib/github-app/gate-setup.ts` back the guided setup wizard (workflow preview and read-only verification of GitHub's gate configuration).
- `server/routes/github-app/release-targets.ts` maps organizations to GitHub repositories/environments/ecosystems.
- `server/routes/github-app/workflow-gates.ts` exposes pending/completed gate review APIs and accept/reject actions.
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
permissions: {} # each job asks for exactly what it needs

jobs:
  pack:
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false # npm ci runs install scripts next
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

To narrow npm's automated publish path to this gated workflow — trusted publishing pinned to the gate environment, tokens disallowed — see [`npm-trusted-publishing.md`](./npm-trusted-publishing.md). npm still permits interactive publication by an account holder using password, 2FA, and an OTP.

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
- treats Marketplace baseline lookup as a diff aid only: metadata, download, parse, or identity failures degrade to a no-baseline review, and an unreadable version list is recorded as `metadata-unavailable` rather than as a first publish;
- reports metadata mismatches, broad startup activation, startup remote-command loaders, startup WebAssembly loaders, undeclared configuration reads, and transitive extension installs.

Recommended workflow shape:

```yaml
permissions: {} # each job asks for exactly what it needs

jobs:
  package:
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false # npm ci runs install scripts next
      - run: npm ci # @vscode/vsce is a devDependency in the lockfile
      - run: ./node_modules/.bin/vsce package --out dist/extension.vsix
      - run: cd dist && sha256sum *.vsix > SHA256SUMS
      - uses: actions/upload-artifact@v4
        with:
          name: vscode-release-candidate
          path: dist/
  publish:
    needs: package
    environment: production # VSCE_PAT is a secret on this environment
    permissions:
      contents: read # the lockfile only
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - run: npm ci --ignore-scripts # the locked vsce, no install scripts
      - uses: actions/download-artifact@v4
        with:
          name: vscode-release-candidate
          path: dist
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      - run: ./node_modules/.bin/vsce publish --packagePath dist/extension.vsix
        env:
          VSCE_PAT: ${{ secrets.VSCE_PAT }}
```

The publish job must publish the reviewed VSIX bytes. Repacking after approval breaks the review boundary. Run `vsce` from the lockfile rather than `npx @vscode/vsce@x.y.z`: the job holds a Marketplace PAT that outlives the run, and a version pin on `vsce` alone still resolves its dependencies fresh on every run.

These shapes use action tags for brevity. The workflows guided setup generates pin every action to a commit SHA instead — see [Generated workflows](#generated-workflows).

## Observing publication

Gate approval authorizes the configured job; registries do not consume a
Drydock artifact-digest constraint. The checksum recipes assume that job remains
trusted to run the check and publish the checked file. For explicitly enrolled
public npm packages, the [publication monitor](./publication-monitor.md) hashes
published bytes and compares them with prior staged or gate approvals. This is
post-publication evidence and does not expand gate authority or cover PyPI and
VS Code publication outcomes.

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
5. Register the adapter with workflow-gate resolution, and implement `gateSetupTemplate` so the guided setup wizard can generate its publish workflow.
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

npm gate reviews also record `sha1` beside `digest` in `summary.stagedPublish`
(not in `provenance` or the release manifest): the SHA-1 of the same reviewed
tarball, in npm's `dist.shasum` encoding. It lets the
[publication monitor](./publication-monitor.md) compare npm's own shasum with a
gate review when the published tarball is too large or too slow to hash; gate
reviews from before it was recorded carry SHA-256 only.

## Remaining work

- Expand gate-specific e2e coverage as more ecosystems are added.
- Keep GitHub/PyPI/npm/VS Code validation failures user-actionable without leaking credentials or private package bytes.
