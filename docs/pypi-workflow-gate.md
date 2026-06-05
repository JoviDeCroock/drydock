# PyPI Workflow-Gate Support

PyPI support uses a different product shape from npm staged publishing.

npm owns a pending staged tarball, so Drydock can fetch `/-/stage/<stage-id>/tarball` and leave final approval in npm. PyPI does not expose an equivalent registry-staged artifact. The PyPI path is therefore **workflow gate mode**: CI builds wheels/sdists first, uploads them as a `pypi-release-candidate` bundle for review, and a GitHub Environment blocks the publish job until the reviewed release is approved. There is no `drydock-manifest.json` to write — the release set is whatever wheels/sdists the bundle contains, and the package identity is derived from the artifacts themselves.

Official references:

- PyPI Trusted Publishers: `https://docs.pypi.org/trusted-publishers/`
- PyPI GitHub Actions publishing setup: `https://docs.pypi.org/trusted-publishers/using-a-publisher/`
- PyPI project JSON API: `https://docs.pypi.org/api/json/`
- Python wheel format: `https://packaging.python.org/specifications/binary-distribution-format/`

## Implemented foundation

The repo now has a backend-only PyPI foundation in `server/lib/adapters/pypi/index.ts`:

- derives a `drydock.release-artifacts.v1` release set from the uploaded artifacts (identity from wheel `METADATA` / sdist `PKG-INFO`, digests recomputed from the bytes) — there is no maintainer-declared manifest;
- exposes a `PackageAdapter` implementation compatible with the pluggable scan pipeline introduced for npm;
- normalizes PyPI project names using the PEP 503-style `[-_.]+ -> -` convention;
- recognizes wheel (`.whl`) and sdist (`.tar.gz`, `.tgz`) artifacts;
- parses wheel `METADATA`, `WHEEL`, and `RECORD` evidence from ZIP archives;
- strips the common root directory from sdists before reading `PKG-INFO`;
- compares flattened candidate artifact files against the previous PyPI release using stable wheel/sdist namespaces instead of versioned artifact filenames (callers may inject explicit `previousArtifacts`, otherwise the adapter resolves and downloads the baseline itself);
- requires every artifact in the bundle to agree on the normalized package name and version before forming a reviewable release;
- adds PyPI-specific deterministic findings for metadata mismatches, missing wheel `RECORD`, `.pth` startup hooks, custom `setup.py` install commands, and `.pyd` native extensions;
- fetches PyPI project metadata from `GET /pypi/<project>/json`;
- selects a default PyPI baseline release from `info.version`, falling back to newest non-yanked upload time;
- extracts wheel/sdist download metadata and SHA-256 digests from non-yanked PyPI release files;
- downloads the baseline wheel/sdist artifacts whose namespace matches a staged artifact through a credential-free `PyPiBroker`, so completed reviews show changed/unchanged files against the selected previous release;
- restricts public PyPI artifact downloads to `https://files.pythonhosted.org`.

The sandbox parser now supports safe ZIP archive parsing for wheels in addition to npm-style gzipped tar archives. ZIP downloads are read through a bounded stream before parsing; ZIP parsing then reads the central directory, accepts stored and deflated entries, rejects traversal paths and Zip64, enforces file/expanded-size caps, and keeps package contents as bounded text samples or binary metadata.

## Release set derivation

There is no manifest file. The boundary between the GitHub workflow and Drydock
is simply the `pypi-release-candidate` artifact bundle: CI uploads `dist/*` and
Drydock treats every `.whl` / `.tar.gz` / `.tgz` in the bundle as the release
set. The reviewable identity is derived internally into the same
`drydock.release-artifacts.v1` shape the rest of the pipeline consumes:

- `package` / `version` come from each wheel's `METADATA` and each sdist's
  `PKG-INFO`. Every artifact must expose a `Name`/`Version` and agree on the
  normalized (PEP 503) name and the version, so a foreign or version-skewed file
  in `dist/` is rejected, not silently shipped.
- each artifact's `sha256` is recomputed server-side from the bundle bytes.

### Trust tradeoff (deliberate)

Dropping the manifest removes the maintainer's explicit "ship exactly these N
files, at these digests" declaration. There is no externally-declared digest to
compare against, so the publish-side digest-match check disappears. Byte
integrity between review and publish rests on GitHub artifact immutability plus
the publish job never rebuilding (it only downloads the reviewed artifact).
What keeps this safe:

- cross-artifact identity consistency (a foreign or version-skewed wheel cannot
  sneak into the release set);
- the release target binds the gate to the configured GitHub repository and
  environment;
- a bundle whose artifacts cannot be identified (no `METADATA`/`PKG-INFO`
  `Name`/`Version`) is rejected rather than guessed.

A reviewed wheel/sdist must be the exact file uploaded to PyPI; rebuilding after
the gate breaks the security boundary.

## Target workflow

```yaml
jobs:
  build-release-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python -m build
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate
          path: dist/*

  publish:
    needs: build-release-artifacts
    environment: pypi
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: pypi-release-candidate
      - uses: pypa/gh-action-pypi-publish@release/v1
```

No manifest-writing or checksum step is required — CI just builds and uploads
`dist/*`. PyPI strongly encourages configuring a GitHub Environment for Trusted
Publishers. Drydock attaches to that same environment as a GitHub custom
deployment protection rule.

## GitHub App mapping

The GitHub App installation + repository/environment mapping that connects an
organization to its workflow gates lives in `server/lib/github-app/` with the
HTTP surface in `server/routes/github-app.ts`. Two tables back it:

- `github_app_installations` — one row per installation an org has authorized
  (`organization_id`, GitHub `installation_id`, `account_login`, status). The
  installation ID is unique across the app, so the same install cannot be linked
  to two organizations.
- `github_release_targets` — one row per (org, repository, environment) mapping.
  Each row points at an installation row and pins a `repository_id` and
  `environment`. GitHub environment names are stored in lowercase because GitHub
  treats environment names as case-insensitive. A repository/environment pair is
  unique within an organization because GitHub deployment-protection webhooks
  identify the pending gate by installation, repository, and environment.

### Endpoints

All endpoints sit under `/api/v1/github-app/*` and require Better Auth + active
organization (`x-organization-id` header to scope writes).

- `GET /config` — exposes `{ configured, appSlug }` so the UI can build install
  URLs without holding GitHub App secrets.
- `POST /install` — returns a signed install URL plus the HMAC state token.
- `POST /install/callback` — verifies the state token, exchanges the GitHub
  OAuth `code` for a user-to-server token, confirms the
  submitted installation appears in `GET /user/installations`, then calls
  `GET /app/installations/:id` with the App JWT and stores the resulting
  `account_login` + `account_type`. The GitHub App must enable "Request user
  authorization (OAuth) during installation" so the setup callback includes
  this `code`; the installation ID alone is treated as untrusted.
- `GET /installations` — lists every installation linked to the active org.
- `GET /installations/:installationRowId/repositories` — proxies
  `GET /installation/repositories` via the installation token so the UI can
  surface a dropdown of repos the install can see, without holding GitHub App
  credentials. It follows GitHub pagination until exhausted. Returns
  `{ repositories: [{ id, fullName, defaultBranch }] }`.
- `GET /installations/:installationRowId/repositories/:owner/:repo/environments`
  — proxies `GET /repos/:owner/:repo/environments` via the installation token
  so the UI can surface a dropdown of GitHub Environments configured on the
  selected repo. Returns `{ environments: [{ name }] }`. Both routes call
  `ensureInstallationOwnedBy` first, so foreign installation IDs return
  `installation_missing` before any GitHub call is made, and both are
  rate-limited before minting an installation token or calling GitHub.
- `GET /release-targets`, `POST /release-targets`,
  `DELETE /release-targets/:id` — CRUD over the mapping.
- `GET /workflow-gates/by-scan/:scanId` — resolves the gate a persisted review
  belongs to so the scan workbench can render gate status and the decision
  controls. Returns the public gate shape (no `deployment_callback_url`); 404
  when the scan is not a gate review or belongs to another org.
- `POST /workflow-gates/:gateId/decision` — records a maintainer's
  `{ decision: "approved" | "rejected", comment?, totpCode? }` and releases/blocks
  the held GitHub job. `markGateDecided` is the single CAS out of `pending`, so a
  double-submit (or a race with the fail-closed artifact reject) returns 409.
  Approval requires the gate to be linked to a completed `workflow_gate` scan;
  rejection is allowed without one so maintainers can still fail closed.
  Delivery to GitHub is scheduled immediately after the CAS, before best-effort
  scan/audit mirroring, and is handed to the gate job (over `SCAN_QUEUE`, with
  inline fallback) so the decided gate posts its stored decision. The decision is
  also mirrored onto the underlying scan as `publish` for approved gates or
  `no_publish` for rejected gates when that write succeeds. Rate-limited to
  60/min per org.
  - **2FA step-up (issue #162):** releasing or blocking a held deployment is
    irreversible (approval immediately releases the job and publishing proceeds
    over Trusted Publishing/OIDC), so when the deciding maintainer has two-factor
    auth enabled they must include a **fresh** `totpCode` from their authenticator
    app. A missing code returns `401 { code: "two_factor_required" }` and a wrong
    code `401 { code: "two_factor_invalid" }`; both leave the gate `pending` and
    never post to GitHub. The code is verified against the request's own session
    via Better Auth's `verifyTOTP` (`server/lib/auth.ts`), so a stale session is
    not enough. Step-up attempts are rate-limited to 10 per 15 min per user, and
    the verified method is recorded on the `github_workflow_gate.approved` /
    `.rejected` scan event (`twoFactor`, `twoFactorMethod`). Maintainers without
    2FA decide as before. This requirement is specific to the **approval gate**;
    the staged-publish decision (`POST /api/v1/scans/:id/decision`) is an audit
    record only — it never publishes or cancels anything — and deliberately does
    not require a step-up.

`POST /release-targets` enforces every validation listed in issue #114:

- `installation_missing` — caller supplied an `installationRowId` that does not
  belong to the active organization.
- `installation_inactive` — installation is suspended or uninstalled.
- `repository_not_accessible` — `GET /repos/:owner/:repo` with an installation
  token returned 403/404, meaning the install was never granted that repo. The
  repo name is validated as exactly `owner/repo` before the GitHub API URL is
  built, so path traversal-like segments cannot escape the repository lookup.
- `environment_unmapped` — caller did not provide an `environment`, or the
  provided environment name exceeds GitHub's 255-character limit.
- `environment_already_mapped` — `(organizationId, repositoryId, environment)`
  already has a row, so a deployment-protection webhook would be ambiguous.

### Webhook resolution

`resolveDeploymentProtectionTarget(db, { installationId, repositoryId,
environment })` is the lookup helper the `deployment_protection_rule` webhook
calls to find the owning organization and release target. It returns `null`
for unknown installs, suspended installs, and unmapped environments — the
caller decides whether that becomes an HTTP 404 or a silent skip. The
environment is normalized the same way as stored release targets, and the
database enforces one target per organization/repository/environment so this
lookup is deterministic.

## Deployment-protection webhook

The webhook endpoint is `POST /webhooks/github`. It is mounted outside the
Better Auth middleware so GitHub can deliver to it directly; the trust
boundary is the GitHub App webhook secret. Configure the GitHub App to send
deliveries to `https://<drydock-host>/webhooks/github` with the same secret
that is stored in `GITHUB_APP_WEBHOOK_SECRET`.

What the handler does on each delivery:

1. Read `X-GitHub-Event`, `X-GitHub-Delivery`, and `X-Hub-Signature-256`.
   Missing required headers, missing/invalid signatures, or empty bodies all
   return 4xx — we fail closed so unsigned or malformed requests cannot bypass
   the gate. Bodies are capped before materialization: oversized
   `Content-Length` values are rejected immediately, and chunked/undeclared
   bodies are read through a hard streaming byte limit.
2. HMAC-SHA256 verify the signature against the raw body in constant time.
3. Parse the payload. The handler accepts two event types:
   - `deployment_protection_rule` (action `requested`) — resolves the
     `(installationId, repositoryId, environment)` triple against the
     release-target table, then inserts a `github_workflow_gates` row in
     `pending` state. Insertion is keyed on `delivery_id`, so GitHub
     retries with the same delivery are idempotent.
   - `installation` (actions `suspend` / `unsuspend` / `deleted`) — updates
     the installation row's status so subsequent webhook deliveries fail
     closed if GitHub later revokes access.
4. Audit the resolved gate via `scan_events`
   (`github_workflow_gate.requested`).

Deliveries that resolve to no release target are ack'd with HTTP 200 + an
`ignored` body. GitHub considers that a successful delivery, so the webhook
log stays clean even when other GitHub Apps the org installs send events to
the same URL.

### Posting the decision back to GitHub

`postDeploymentProtectionDecision` reads the stored
`deployment_callback_url`, swaps the App JWT for an installation access token,
and POSTs `{ state, environment_name, comment }`. The callback URL is
re-validated before the request — only `https://api.github.com/repos/<owner>/
<repo>/actions/runs/<run_id>/deployment_protection_rule` URLs are accepted, so
a spoofed `deployment_callback_url` in the original webhook cannot redirect
the approval to an attacker-controlled host. The comment is truncated to 140
characters and is what GitHub renders in the Actions run log, so it carries
the link to the Drydock report.

`markGateDecided` is the only transition out of `pending`: it succeeds
exactly once thanks to the `status = 'pending'` WHERE clause. Its callers are
the maintainer decision route, the fail-closed artifact reject, and (never the
review itself) — so a double-submit, or a race between a human decision and the
fail-closed reject, only calls GitHub a single time. The companion
`markGateErrored` records failures (e.g. inability to fetch the artifact bundle,
unidentifiable artifacts, scan pipeline crash) without consuming the gate, so
the operator can retry once the underlying issue is fixed.

### Trust boundary (webhook)

- Signatures are required. There is no "trust the header" fallback.
- Callback URLs are pinned to `api.github.com` and the deployment-protection
  path; spoofed URLs are rejected even when the signature is valid.
- The decision API uses a fresh installation access token; no long-lived
  PyPI credential ever touches Drydock.
- `markGateDecided` is a CAS on the pending status, so a race between
  webhook retries and the review pipeline cannot double-approve.

### Trust boundary

The mapping never holds PyPI credentials or OIDC tokens. The publish job on
GitHub Actions exchanges its OIDC token with PyPI directly; Drydock only
controls whether the deployment protection gate releases that job.

### Env bindings

`GITHUB_APP_ID`, `GITHUB_APP_SLUG`, and `GITHUB_APP_CLIENT_ID` are public values
and live in `wrangler.jsonc` under `vars`. `GITHUB_APP_PRIVATE_KEY`,
`GITHUB_APP_WEBHOOK_SECRET`, and `GITHUB_APP_CLIENT_SECRET` are sensitive and
need to be set as runtime secrets:

```bash
wrangler secret put GITHUB_APP_PRIVATE_KEY < drydock.private-key.pem
echo -n "<webhook-secret>" | wrangler secret put GITHUB_APP_WEBHOOK_SECRET
echo -n "<client-secret>" | wrangler secret put GITHUB_APP_CLIENT_SECRET
```

The private key may be GitHub's downloaded PKCS#1 PEM or a converted PKCS#8 PEM.
`GITHUB_APP_STATE_SECRET` is optional and falls back to `BETTER_AUTH_SECRET` for
HMAC-signing the OAuth state.

### GitHub App permissions

Repository permissions the App must request on the repos the org maps to a
release target:

- **Actions: Read** — list workflow run artifacts and download the
  artifact ZIP for a pending gate.
- **Deployments: Read & write** — receive `deployment_protection_rule`
  webhooks and POST the deployment-protection decision callback.
- **Metadata: Read** — mandatory for any fine-grained App; backs
  `GET /repos/{owner}/{repo}` and the `GET /installation/repositories` repo
  picker.

Webhook events to subscribe to:

- `deployment_protection_rule` (pending-gate trigger).
- `installation` (suspend / unsuspend / deleted, so we fail closed on
  revoked installs).

Account permissions: "Request user authorization (OAuth) during installation"
must be on so the install callback gets a `code` to confirm the installer
actually controls the installation. No additional OAuth scopes are required.

### GitHub App setup URL

The "Setup URL" configured on the GitHub App (under "Identifying and authorizing
users") must point at the Drydock callback page:

```
https://<your-drydock-host>/dashboard/settings/github-app/callback
```

The setup URL must be marked **active** and "Request user authorization (OAuth)
during installation" must be checked so GitHub appends `code`, `installation_id`,
`setup_action`, and `state` to the redirect. The callback page reads those four
parameters and POSTs them to `/api/v1/github-app/install/callback`.

### Front-end

The install flow lives on `/dashboard/settings` and is generally available for
every organization. The `/dashboard/settings/github-app/callback` page completes
the install:

1. The page calls `GET /api/v1/github-app/config`; when `configured === false`
   it renders a "not configured yet — ask the operator" notice instead of the
   install button.
2. The "Install GitHub App" button calls `POST /api/v1/github-app/install` and
   navigates to the returned `installUrl`.
3. After install, GitHub redirects back to
   `/dashboard/settings/github-app/callback`, which POSTs `state`, `code`,
   `installationId`, and `setupAction` to
   `POST /api/v1/github-app/install/callback`. Success refreshes the
   installation list; typed validation codes
   (`installation_missing`, `installation_inactive`, `installation_not_active`,
   etc.) are surfaced inline.
   If the Drydock session expired while the user was on GitHub, the callback
   sends them through `/login?returnTo=...`; login only honors same-origin
   `/dashboard...` return paths before resuming the callback.
4. Linked installations render with `active` / `suspended` / `uninstalled`
   status badges.
5. Below the linked installations, a "Release targets" form lets the user
   register a `(repo, environment)` mapping. The installation defaults to the one
   linked for the org; repository and environment are dropdowns populated from
   the proxy endpoints. The server still revalidates installation ownership, repo
   access, and environment names on `POST /release-targets`, so the UI cannot
   bypass the rules. Empty states link to GitHub App settings (no repos) and
   GitHub Actions environments docs (no environments).
6. Above the release-targets form, a "gate setup" guide walks through installing
   the App, adding a GitHub Environment custom deployment protection rule, and
   matching the PyPI Trusted Publisher environment. It states plainly that
   approval releases or blocks the held GitHub job and that publishing happens
   through the workflow's Trusted Publishing OIDC exchange — Drydock never holds
   or sees PyPI credentials.

### Gate review workbench

A gate review is an ordinary persisted scan, so it opens in the same diff-first
workbench at `/dashboard/scans/<scanId>`. When the scan's `source` is
`workflow_gate`, the page calls `GET /workflow-gates/by-scan/:scanId` and, for a
gate still `pending`, renders approve/reject controls wired to
`POST /workflow-gates/:gateId/decision`. The release recommendation copy is
gate-targeted (it talks about releasing/blocking the held GitHub job rather than
publishing to npm) but the deterministic findings, package diff, and risk
surface are identical to npm reviews. A decided gate shows its stored decision
and comment instead of the controls. Failed review scans also resolve their
linked gate so the workbench can show the held GitHub job context instead of a
detached failure.

### Resolving artifacts for a pending gate

`server/lib/github-app/artifacts.ts` turns a pending gate into a release bundle
of recomputed-SHA-256 wheel/sdist bytes on the trusted control-plane side, then
the PyPI `WorkflowGateAdapter` (`server/lib/workflow-gates/pypi.ts`) hands each
wheel/sdist to the credentials-free `downloadInSandboxInline` sandbox path so the
same untrusted-archive parser the npm pipeline uses produces bounded
`FileRecord[]` evidence, and derives the release identity from that parsed
metadata. The ecosystem-neutral plumbing around it (gate/installation/release-
target loading, adapter selection, bundle fetch) lives in
`server/lib/workflow-gates/prepare.ts`.

What the resolver enforces, in order:

1. `GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts` with an
   installation token — find the first non-expired artifact named
   `pypi-release-candidate` (configurable). Requires the **Actions: Read**
   repository permission on the GitHub App.
2. `GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip` answers with
   a 302 to a signed artifact-storage URL. The redirect is followed manually
   (`redirect: "manual"`) through an egress allowlist
   (`evaluateGithubArtifactEgress`, mirroring the `NpmStageGateway` credential
   policy): the installation token is attached only to `api.github.com` and is
   dropped on the hop to GitHub's storage hosts
   (`*.actions.githubusercontent.com` or
   `*.blob.core.windows.net/actions-results/...`), which carry their own auth
   in the URL. A redirect to any other host fails closed with
   `bundle_unavailable` before the request is issued, so a spoofed `Location`
   cannot leak the token. The outer ZIP is capped at 25 MiB; Content-Length is
   rejected before reading, and the streamed body is also bounded.
3. The outer ZIP is parsed with a focused central-directory walker that
   reuses the hardened primitives from `server/lib/tar-parser.js`
   (`findZipEndOfCentralDirectory`, `inflateRawBounded`, `normalizeZipPath`).
   Traversal paths, ZIP64, oversized entries, and unsupported compression
   methods are rejected.
4. Every `.whl` / `.tar.gz` / `.tgz` entry becomes the release set; its SHA-256
   is recomputed from the bundle bytes. Non-artifact files are ignored. A bundle
   with no wheels/sdists is `bundle_empty`; more than 20 is `bundle_too_large`.
5. Each wheel/sdist's bytes cross into the credentials-free sandbox, which
   parses `METADATA`/`PKG-INFO` into bounded evidence.
6. The release identity is derived from that parsed metadata: every artifact
   must expose a `Name`/`Version` and agree on the normalized package name and
   the version. The synthesized `drydock.release-artifacts.v1` shape (PEP 503
   project name, safe version, ≤20 artifacts, safe artifact paths) is then
   re-validated before scanning.

Typed errors returned by `WorkflowArtifactError.code`:

- `bundle_unavailable` — workflow run / artifact name is unreachable.
- `bundle_too_large` — outer ZIP exceeded the size/entry cap, or the bundle held
  more than 20 wheel/sdist files.
- `bundle_empty` — the bundle contained no `.whl` / `.tar.gz` / `.tgz` files.
- `artifact_path_unsafe` — bundle entry path contained traversal segments.
- `artifact_identity_missing` — an artifact exposed no usable `Name`/`Version`
  (or the derived identity failed validation).
- `artifact_identity_inconsistent` — artifacts disagreed on the normalized
  package name or the version.

`prepareReleaseCandidateForGate(env, ctx, db, { config, organizationId,
gateId })` (`server/lib/workflow-gates/prepare.ts`) is the gate-aware wrapper. It
looks up the gate row, selects the `WorkflowGateAdapter` for the release target's
ecosystem, swaps the App JWT for a fresh installation access token, and on any
failure calls `markGateErrored` with the typed error code so the gate cannot
advance to scanning. The GitHub installation token never enters the sandbox: the
parent worker downloads the artifact ZIP and recomputes digests, and only the
wheel/sdist bytes cross the trust boundary through `downloadInSandboxInline`,
which constructs the `NpmStageGateway` with empty props (no npm token, no
public-artifact allowlist, `subRequests: 0`). Because identity is derived from
the sandbox-parsed metadata, package identity is known only after the artifacts
have crossed the untrusted-archive parser; the release target itself binds the
review to the GitHub repository and environment.

## Multi-ecosystem workflow gates

PyPI is the first workflow-gate ecosystem, not the only intended one. The gate
pipeline is split so that everything GitHub-shaped is shared and only the
ecosystem's artifact semantics are pluggable. Two distinct adapter layers are
involved — do not conflate them:

- **`WorkflowGateAdapter`** (`server/lib/workflow-gates/types.ts`) — gate-time
  artifact semantics: which GitHub Actions artifact to download, which bundle
  entries are reviewable, and how to derive the package identity + scan-pipeline
  input from the verified bytes.
- **`PackageAdapter`** (`server/lib/adapters/types.ts`) — the deterministic
  review/baseline/findings pipeline `runScanPipeline` already drives for npm and
  PyPI. A `WorkflowGateAdapter` references one via `packageAdapter`.

### Who owns what

The **shared runner** owns every GitHub-shaped and persistence concern, in
`server/lib/workflow-gate-job.ts` (`executeWorkflowGateJob`) plus
`server/lib/workflow-gates/prepare.ts` (`prepareReleaseCandidateForGate`):

- loading the `github_workflow_gates` row, installation, and release target;
- selecting the adapter from `github_release_targets.ecosystem`;
- fetching the GitHub Actions artifact bundle, bounded ZIP parsing, unsafe-path
  rejection, and SHA-256 recomputation (the installation token is swapped + used
  only in the control plane, never in the sandbox);
- persisting gate status / decision / audit events with ecosystem-neutral names
  (`github_workflow_gate.*`);
- calling `markGateDecided` + `postDeploymentProtectionDecision` exactly once;
- structured error handling: a `WorkflowArtifactError` rejects the deployment
  fail-closed, while a review/processing error (or an
  `UnsupportedEcosystemError`) leaves the gate pending for a human/retry and
  records the typed `failureReason`.

A **`WorkflowGateAdapter`** owns only the ecosystem-specific surface:

- `artifactName` — the default GitHub Actions artifact the bundle is downloaded
  from;
- `classifyArtifact(path)` — which bundle entries are reviewable artifacts (the
  returned kind is opaque to the shared fetcher; `null` drops the entry);
- `prepareReleaseCandidate(...)` — parse the verified bytes through the
  credentials-free sandbox, derive the package identity, reject a bundle that
  does not match the configured release target, and return the
  `pipelineInput` (`Record<string, unknown>` spread into `runScanPipeline`, so
  its keys must match what `packageAdapter.parseInput` expects);
- `packageAdapter` — the `PackageAdapter` the shared pipeline runs.

The risk-to-decision mapping (`recommendationForReleaseRisk`) stays shared, so
every ecosystem gets the same advisory recommendation and the same
human-drives-the-decision model.

### Adding a new ecosystem

1. Implement (or reuse) a `PackageAdapter` for the ecosystem under
   `server/lib/adapters/<ecosystem>/` — the deterministic findings, baseline
   selection, and diff. This is the same contract npm and PyPI already satisfy.
2. Add a `WorkflowGateAdapter` under `server/lib/workflow-gates/<ecosystem>.ts`
   with the four members above. Throw `WorkflowArtifactError` (with one of the
   typed codes) whenever the bundle cannot be trusted so the runner fail-closes.
3. Register it in `server/lib/workflow-gates/registry.ts` by adding it to
   `WORKFLOW_GATE_ADAPTERS` keyed by its `ecosystem`.
4. Add the ecosystem string to `SUPPORTED_ECOSYSTEMS`
   (`server/lib/github-app/config.ts`) so release targets for it can be created.
5. Add adapter-dispatch + prepare tests under `test/workers/` (see
   `workflow-gate-registry.test.ts` and `workflow-gate-prepare.test.ts`). No
   change to `executeWorkflowGateJob` should be needed — if it is, the GitHub
   plumbing has leaked into the adapter boundary.

A release target whose ecosystem has no registered adapter resolves to an
`UnsupportedEcosystemError`: the runner records `failureReason:
"unsupported_ecosystem"`, emits `github_workflow_gate.unsupported_ecosystem`, and
leaves the gate **pending** (a config/data problem is never auto-approved and
never fail-closed-rejected).

### Baseline acquisition

`pypiAdapter.acquireBaseline` resolves the previous release the candidate is
diffed against. When the caller supplies `previousArtifacts` (the inline-bytes
path used by `createPyPiReleaseCandidateReview`) those files are used directly.
Otherwise the adapter fetches `GET /pypi/<project>/json` through the
`PyPiBroker`, picks the baseline via `pickPyPiBaselineRelease` (`info.version`,
falling back to the newest non-yanked upload time), and downloads the baseline
artifacts.

Downloads are bounded and credential-free:

- `selectPyPiReleaseArtifacts` drops yanked files, and the URLs are filtered to
  `https://files.pythonhosted.org` (`isAllowedPyPiArtifactUrl`).
- Only baseline artifacts whose filename-derived namespace matches a staged
  artifact namespace are fetched, so popular projects with dozens of platform
  wheels don't trigger dozens of downloads; at most one artifact per namespace
  is pulled.
- `PyPiBroker.downloadPublicArtifact` runs each fetch through
  `downloadInSandbox` only after re-validating the artifact host, with no npm
  token and a public-artifact allowlist pinned to the single URL being fetched,
  so the `NpmStageGateway` forwards the request uncredentialed. PyPI artifacts
  never receive npm credentials or arbitrary egress.

The downloaded wheel/sdist files are flattened through the same wheel/sdist
namespaces as the candidate, so `createPackageDiff` reports changed/unchanged
files across versions.

### Running the gate review (queue consumer)

The webhook does not run the review inline. When a `deployment_protection_rule`
delivery resolves to a pending gate, `POST /webhooks/github` enqueues a
`{ kind: "workflow_gate", organizationId, gateId }` message onto `SCAN_QUEUE`
(the same queue npm scans use). The Worker's `queue` handler routes that
message to `executeWorkflowGateJob` in `server/lib/workflow-gate-job.ts`; the
existing `ScanQueueMessage` path is unchanged. `SCAN_QUEUE` is optional in
tests/local, so the enqueue is guarded — GitHub retries any non-2xx delivery
and the consumer re-checks gate status, so a re-enqueue is safe.

`executeWorkflowGateJob` runs the full pipeline for one gate:

1. Read the GitHub App config. A `GithubAppConfigError` leaves the gate pending
   and returns without retrying (a misconfigured app won't fix itself on retry).
2. Load the gate. A gate that is already `approved`/`rejected` triggers a
   **redelivery** of the stored decision to GitHub (idempotent re-POST) instead
   of re-running the review; callback failures rethrow so the queue retries. A
   pending gate with an attached completed review is skipped because it is
   waiting for a human decision; a pending gate with an attached failed review
   is retried and relinked to the new scan if the retry succeeds. A non-pending,
   non-decided status is skipped with a warning.
3. Record `github_workflow_gate.received`.
4. Call `prepareReleaseCandidateForGate` to select the ecosystem adapter and
   resolve + verify the bundle.
   - A `WorkflowArtifactError` (e.g. `bundle_unavailable` or
     `artifact_identity_inconsistent`)
     **rejects** the gate fail-closed with a generic comment, records
     `github_workflow_gate.rejected`, and POSTs the rejection — no human is
     needed to block an artifact that cannot be verified. `prepare` already
     recorded the typed `failureReason` and kept the gate pending, so the
     `markGateDecided` CAS still fires.
   - Any other error (sandbox/review failure) leaves the gate **pending**,
     records `github_workflow_gate.review_failed`, and returns without POSTing —
     the operator can retry.
5. Resolve the organization owner (so the persisted scan has an owner). A
   missing owner records `review_failed` and leaves the gate pending.
6. Create a scan job (`source: "workflow_gate"`, synthetic
   `stageId: "workflow-gate:<gateId>"`), claim the gate's `scanId` with a CAS
   against the scan link the worker observed, and run `runScanPipeline` with the
   selected adapter's `packageAdapter` over the verified pipeline input. If
   another delivery
   already claimed the gate, the worker deletes its just-created pending scan
   and exits. A pipeline throw marks the linked scan failed, records
   `review_failed`, and leaves the gate pending; a later retry can replace that
   failed link with a completed scan.
7. Compute an **advisory** recommendation from the release risk
   (`recommendationForReleaseRisk`: `high`/`critical` → `rejected`, otherwise
   `approved`) and record `github_workflow_gate.reviewed` with it. Then link the
   scan to the gate via `attachScanToGate` and **leave the gate pending** — the
   review never posts to GitHub.
8. Email the maintainer that a gate is parked pending their decision
   (`notifyWorkflowGateReview` in `server/lib/notify.ts`). Because Drydock never
   auto-decides, this email is the only proactive signal that a held GitHub
   deployment is waiting on a human.

### Notifying the maintainer

Step 8 is the gate equivalent of the npm scan-completion email. It reuses the
`sendNotificationEmail` primitive and fans out to the organization's resolved
recipient set (`resolveNotificationEmails`): the org's configured
`organization_notification_recipients` when present, otherwise the owner's email
(`getOrganizationOwnerUserId` → `getUserContact`) so an org that never touched
the setting keeps today's behavior. Each address gets its own send — no shared
`To`/`Cc` — so recipients are never disclosed to one another. The body carries
only the release identity (`package@version`), the computed release risk, the
repository, the environment, and a deep link to the review at
`/dashboard/scans/<scanId>` — never a token, header, callback URL, or artifact
bytes, per the observability rules in `AGENTS.md`.

Delivery is best-effort and **never blocks or fails the gate**: each send's
outcome is recorded as a `github_workflow_gate.notification_sent` or
`github_workflow_gate.notification_failed` `scan_events` row (one per recipient,
with the destination in `metadata.recipient`, mirroring the `scan.notification_*`
pattern), and a thrown send error is swallowed into a
`github_workflow_gate.notification_error` operational event. When the recipient
set is empty (no configured recipients and the owner has no email), a single
`notification_failed` row with `reason: "no_recipients"` is recorded and no email
is sent.

The email is **send-once per gate**. Step 8 sits on the single review-ready
transition, after the job re-confirms that the gate is still `pending` while
linking the completed scan. If a maintainer has already decided the gate during
the review, that compare-and-set fails and no stale "needs review" email is
sent. A GitHub re-delivery of the same `deployment_protection_rule` event
short-circuits earlier at the `already_reviewed` guard (a pending gate with a
completed attached scan is never re-reviewed), so one review-ready gate produces
exactly one email. A failed first review records no email; a later retry that
succeeds sends the one email when it reaches review-ready.

The job never auto-approves a release: approving releases the GitHub job and
publishing happens immediately through Trusted Publishing/OIDC, which is too
late to reverse. A maintainer drives the actual decision from the scan
workbench via `POST /workflow-gates/:gateId/decision`; the recommendation
recorded in step 7 is advisory only. Once decided, the gate job's redelivery
path (step 2) is what POSTs the stored decision to GitHub. The decision route
schedules that redelivery immediately after `markGateDecided`, before scan
decision mirroring or audit events, so post-CAS bookkeeping cannot strand the
held GitHub job behind a future 409; callback failure rethrows so the queue
retries rather than re-running the review or double-deciding.

The persisted review is an ordinary `scans` row scoped to the org with
`source: "workflow_gate"`, reachable at `/dashboard/scans/<scanId>` — no
separate review table. The gate row already links scan ↔ release target, so no
schema change was needed.

## Remaining work

- Record the reviewed artifact SHA-256 digests in the persisted report
  payload (the resolver returns them; the persister doesn't store them yet).

The end-to-end path now works: a maintainer can configure a gate from settings,
the webhook holds the publish job, the review surfaces in the workbench, and the
approve/reject decision releases or blocks the job. The digest-persistence item
above is an audit-trail enrichment, not a gap in the gate.
