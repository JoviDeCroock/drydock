# Drydock CLI

Trigger and await Drydock package scans from CI, then consume the same canonical report used by
the dashboard.

```sh
export DRYDOCK_TOKEN="drydock_..."
npx @resynapse/drydock scan --stage "$NPM_STAGE_ID" --fail-on high
npx @resynapse/drydock report <scan-id> --json > drydock-report.json
```

`scan --stage` needs a token with `scans:write`; polling and `report` need `scans:read`. Create an
organization token in Drydock Settings. The CLI reads the secret only from `DRYDOCK_TOKEN` so it
does not appear in shell history or process arguments.

Workflow-gate scans are created by Drydock's signed GitHub webhook, not by the CLI. Await one with
its scan ID:

```sh
npx @resynapse/drydock scan --gate <workflow-gate-scan-id> --fail-on high
```

The threshold is evaluated against artifact risk, Drydock's authoritative fail-closed scan risk.
Human output also separates release and context risk. A completed scan at or above the threshold
exits `2`; API/configuration/scan failures exit `1`; a pass exits `0`. Use `--fail-on none` when the
command should report without enforcing a risk policy.

Self-hosted deployments can set `DRYDOCK_API_URL` or pass `--api-url`. Run
`npx @resynapse/drydock --help` for all options. The published package is scoped because the
unscoped `drydock` npm name belongs to an unrelated project; installing it still provides the
`drydock` executable for package scripts and global installs.

The CLI is a dependency-free API client. It downloads report JSON only; it never downloads,
installs, imports, builds, or executes package contents.
