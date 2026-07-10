# Drydock CLI

The dependency-free `@resynapse/drydock` npm package (binary: `drydock`) is the CI-native client for
the organization-token scan surface. It creates staged-publish scans, waits for existing
workflow-gate scans, prints human summaries, and emits the canonical report JSON for other tools.

## Authentication and configuration

Create an organization API token in Settings and expose it to the job as a masked secret:

```sh
export DRYDOCK_TOKEN="drydock_..."
```

Creating a staged scan requires `scans:write`; polling and report export require `scans:read`. The
CLI intentionally has no `--token` flag so secrets do not enter shell history or process listings.
It sends the token only in the `Authorization: Bearer` header, refuses cross-origin redirects, and
redacts it from surfaced API/network errors.

The default API origin is `https://drydock.org`. Self-hosted jobs can set `DRYDOCK_API_URL` or pass
`--api-url <origin>`.

## Scan checks

Create and await an npm staged-publish scan:

```sh
npx @resynapse/drydock scan --stage "$NPM_STAGE_ID" --fail-on high
```

GitHub workflow-gate scans are created by the signed deployment-protection webhook. The CLI does
not create or decide a gate; it can await the scan ID already attached to one:

```sh
npx @resynapse/drydock scan --gate "$DRYDOCK_SCAN_ID" --fail-on high
```

Both forms poll `GET /api/v1/scans/:id?poll=1` until `complete` or `failed`. `--timeout` controls the
overall wait and `--poll-interval` controls polling frequency.

`--fail-on` accepts `low`, `medium`, `high`, `critical`, or `none` and defaults to `high`. It uses
the primary artifact risk because deterministic evidence must not be hidden by diff context. Human
output also reports the narrower release and context risks.

Exit codes are stable for CI:

- `0` — complete and below threshold;
- `1` — configuration, API, timeout, or scan failure;
- `2` — complete at or above the configured risk threshold.

## Reports

Print a compact summary:

```sh
npx @resynapse/drydock report <scan-id>
```

Emit the canonical `drydock.report.v1` document without re-deriving or reshaping its evidence:

```sh
npx @resynapse/drydock report <scan-id> --json > drydock-report.json
```

The CLI never requests package file bodies and never installs or executes package contents. It is
only a client for the redacted scan and report APIs.
