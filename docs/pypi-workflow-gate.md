# PyPI Workflow-Gate Support

PyPI support uses a different product shape from npm staged publishing.

npm owns a pending staged tarball, so Drydock can fetch `/-/stage/<stage-id>/tarball` and leave final approval in npm. PyPI does not expose an equivalent registry-staged artifact. The PyPI path is therefore **workflow gate mode**: CI builds wheels/sdists first, uploads a manifest plus artifacts for review, and a GitHub Environment blocks the publish job until the reviewed artifact digests are approved.

Official references:

- PyPI Trusted Publishers: `https://docs.pypi.org/trusted-publishers/`
- PyPI GitHub Actions publishing setup: `https://docs.pypi.org/trusted-publishers/using-a-publisher/`
- PyPI project JSON API: `https://docs.pypi.org/api/json/`
- Python wheel format: `https://packaging.python.org/specifications/binary-distribution-format/`

## Implemented foundation

The repo now has a backend-only PyPI foundation in `server/lib/adapters/pypi/index.ts`:

- validates `drydock.release-artifacts.v1` manifests for `ecosystem: "pypi"`;
- exposes a `PackageAdapter` implementation compatible with the pluggable scan pipeline introduced for npm;
- normalizes PyPI project names using the PEP 503-style `[-_.]+ -> -` convention;
- recognizes wheel (`.whl`) and sdist (`.tar.gz`, `.tgz`) artifacts;
- parses wheel `METADATA`, `WHEEL`, and `RECORD` evidence from ZIP archives;
- strips the common root directory from sdists before reading `PKG-INFO`;
- compares flattened candidate artifact files against optional previous artifacts using stable wheel/sdist namespaces instead of versioned artifact filenames;
- requires the reviewed artifact path set to exactly match the manifest artifact path set;
- adds PyPI-specific deterministic findings for metadata mismatches, missing wheel `RECORD`, `.pth` startup hooks, custom `setup.py` install commands, and `.pyd` native extensions;
- fetches PyPI project metadata from `GET /pypi/<project>/json`;
- selects a default PyPI baseline release from `info.version`, falling back to newest non-yanked upload time;
- extracts wheel/sdist download metadata and SHA-256 digests from non-yanked PyPI release files;
- restricts public PyPI artifact downloads to `https://files.pythonhosted.org`.

The sandbox parser now supports safe ZIP archive parsing for wheels in addition to npm-style gzipped tar archives. ZIP downloads are read through a bounded stream before parsing; ZIP parsing then reads the central directory, accepts stored and deflated entries, rejects traversal paths and Zip64, enforces file/expanded-size caps, and keeps package contents as bounded text samples or binary metadata.

## Manifest contract

The manifest is the boundary between the GitHub workflow and Drydock:

```json
{
  "schema": "drydock.release-artifacts.v1",
  "ecosystem": "pypi",
  "package": "example-package",
  "version": "1.2.3",
  "artifacts": [
    {
      "path": "dist/example_package-1.2.3-py3-none-any.whl",
      "sha256": "..."
    },
    {
      "path": "dist/example_package-1.2.3.tar.gz",
      "sha256": "..."
    }
  ]
}
```

The publish job must verify these digests immediately before publishing. A reviewed wheel/sdist must be the exact file uploaded to PyPI; rebuilding after the gate breaks the security boundary.

## Target workflow

```yaml
jobs:
  build-release-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python -m build
      - run: sha256sum dist/* > drydock-sha256.txt
      - run: python scripts/write-drydock-manifest.py
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate
          path: |
            dist/*
            drydock-manifest.json
            drydock-sha256.txt

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
      - run: sha256sum --check drydock-sha256.txt
      - uses: pypa/gh-action-pypi-publish@release/v1
```

PyPI strongly encourages configuring a GitHub Environment for Trusted Publishers. Drydock should attach to that same environment as a GitHub custom deployment protection rule when the GitHub App work lands.

## GitHub App mapping

The GitHub App installation + repository/environment mapping that connects an
organization to its workflow gates lives in `server/lib/github-app.ts` with the
HTTP surface in `server/routes/github-app.ts`. Two tables back it:

- `github_app_installations` — one row per installation an org has authorized
  (`organization_id`, GitHub `installation_id`, `account_login`, status). The
  installation ID is unique across the app, so the same install cannot be linked
  to two organizations.
- `github_release_targets` — one row per (org, ecosystem, package) mapping. Each
  row points at an installation row and pins a `repository_id`, `environment`,
  and `pypi_trusted_publisher_environment`. Drydock requires
  `environment === pypi_trusted_publisher_environment` so the deployment
  protection gate runs against the same job that performs the OIDC token
  exchange. PyPI package names are stored in normalized PEP 503 form so
  case/separator aliases map to the same release target. GitHub environment
  names are stored in lowercase because GitHub treats environment names as
  case-insensitive. A
  repository/environment pair is unique within an organization because GitHub
  deployment-protection webhooks identify the pending gate by installation,
  repository, and environment, not by package name.

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

`POST /release-targets` enforces every validation listed in issue #114:

- `installation_missing` — caller supplied an `installationRowId` that does not
  belong to the active organization.
- `installation_inactive` — installation is suspended or uninstalled.
- `repository_not_accessible` — `GET /repos/:owner/:repo` with an installation
  token returned 403/404, meaning the install was never granted that repo. The
  repo name is validated as exactly `owner/repo` before the GitHub API URL is
  built, so path traversal-like segments cannot escape the repository lookup.
- `environment_unmapped` — caller did not provide both `environment` and
  `pypiTrustedPublisherEnvironment`, or the provided environment name exceeds
  GitHub's 255-character limit.
- `environment_mismatch` — the two environment names differ.
- `package_already_mapped` — `(organizationId, ecosystem, packageName)` already
  has a row.
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
exactly once thanks to the `status = 'pending'` WHERE clause, so even if the
PyPI candidate review completes more than once we will only call GitHub a
single time. The companion `markGateErrored` records failures (e.g. inability
to fetch the manifest, scan pipeline crash) without consuming the gate, so
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
  `GET /repos/{owner}/{repo}` and the future `GET /installation/repositories`
  repo picker.

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

The install flow lives on `/dashboard/settings` (gated behind
`import.meta.env.DEV` until the workflow-gate path is ready for users):

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
5. Below the linked installations, a "PyPI release targets" form lets the user
   register a `(package, repo, environment)` mapping. Installation, repository,
   and environment are dropdowns populated from the new proxy endpoints; the
   PyPI Trusted Publisher environment defaults to the selected GitHub
   environment but stays editable so the user can confirm before saving. The
   server still revalidates installation ownership, repo access, and
   environment-name equality on `POST /release-targets`, so the UI cannot
   bypass the rules. Empty states link to GitHub App settings (no repos) and
   GitHub Actions environments docs (no environments).

### Resolving artifacts for a pending gate

`server/lib/github-app-artifacts.ts` turns a pending gate into a verified
release bundle on the trusted control-plane side, then
`server/lib/release-candidate-pypi.ts` hands each wheel/sdist to the
credentials-free `downloadInSandboxInline` sandbox path so the same untrusted-
archive parser the npm pipeline uses produces bounded `FileRecord[]` evidence.

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
4. The bundle must contain `drydock-manifest.json` at the root. It is parsed
   with the existing `parsePyPiReleaseManifest` (PEP 503 project name, safe
   version, ≤20 artifacts, safe artifact paths).
5. The bundle's wheel/sdist set must exactly match the manifest's declared
   artifact set — extra wheel/sdist files or missing declared paths fail.
6. Each declared artifact has its SHA-256 recomputed against the bundle
   bytes; mismatches reject before any bytes reach the sandbox. The
   workflow's own `drydock-sha256.txt` is never trusted.
7. The gate wrapper compares the normalized manifest package name against the
   mapped `github_release_targets.package_name` before wheel/sdist bytes enter
   the sandbox. A repo/environment gate for one PyPI project cannot approve a
   manifest for another project.

Typed errors returned by `WorkflowArtifactError.code`:

- `bundle_unavailable` — workflow run / artifact name is unreachable.
- `bundle_too_large` — outer ZIP exceeded the size or entry cap.
- `manifest_missing` — `drydock-manifest.json` not present at root.
- `manifest_invalid` — manifest JSON / schema validation failed.
- `manifest_artifact_mismatch` — declared vs. bundled artifact sets differ.
- `artifact_path_unsafe` — bundle entry path contained traversal segments.
- `artifact_kind_unsupported` — bundle has a file that isn't `.whl` /
  `.tar.gz` / `.tgz`, or the kind disagrees with the manifest entry.
- `artifact_digest_mismatch` — recomputed SHA-256 ≠ manifest sha256.
- `release_target_mismatch` — normalized manifest package name did not match
  the release target mapped to the pending gate.

`preparePyPiReleaseCandidateForGate(env, ctx, db, { config, organizationId,
gateId })` is the gate-aware wrapper. It looks up the gate row, swaps the App
JWT for a fresh installation access token, and on any failure calls
`markGateErrored` with the typed error code so the gate cannot advance to
scanning. The GitHub installation token never enters the sandbox: the parent
worker downloads the artifact ZIP, validates and digests it, and only the
verified wheel/sdist bytes cross the trust boundary through
`downloadInSandboxInline`, which constructs the `NpmStageGateway` with empty
props (no npm token, no public-artifact allowlist, `subRequests: 0`).

## Remaining work

- Wire `preparePyPiReleaseCandidateForGate` into the scan pipeline so a
  resolved gate runs `pypiAdapter` to completion, persists the report, and
  calls `markGateDecided` / `postDeploymentProtectionDecision`.
- Persist workflow-gate reviews separately from npm `stageId` scans or
  generalize the scan schema around `release_candidate` records.
- Add UI for workflow-gate reviews and GitHub/PyPI setup guidance.
- Record the reviewed artifact SHA-256 digests in the persisted report
  payload (the resolver returns them; the persister doesn't store them yet).
- Compare against prior PyPI release artifacts by downloading selected
  `files.pythonhosted.org` URLs through the exact public-artifact allowlist.

Until those items land, the PyPI code is a review engine foundation and
testable backend slice, not an end-to-end publish gate.
