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
  `pypiTrustedPublisherEnvironment`.
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

## Remaining work

- Add the front-end OAuth flow (install button + callback page) that consumes
  the existing `/install` and `/install/callback` routes.
- Replace the free-text `repositoryFullName` field with a dropdown of repos the
  installation can see (`GET /installation/repositories`).
- Fetch GitHub Actions artifacts and `drydock-manifest.json` with installation
  credentials, then call `markGateDecided` / `postDeploymentProtectionDecision`
  to release or block the publish job.
- Run the existing PyPI candidate review helper from the gate handler.
- Persist workflow-gate reviews separately from npm `stageId` scans or
  generalize the scan schema around `release_candidate` records.
- Add UI for workflow-gate reviews and GitHub/PyPI setup guidance.
- Verify artifact digests in the gate path before scanning and record those
  digests in the report payload.
- Compare against prior PyPI release artifacts by downloading selected
  `files.pythonhosted.org` URLs through the exact public-artifact allowlist.

Until those items land, the PyPI code is a review engine foundation and
testable backend slice, not an end-to-end publish gate.
