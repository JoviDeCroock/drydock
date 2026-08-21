# Ops snapshot

`pnpm run ops:snapshot` is an operator-only script (`scripts/ops-snapshot.mjs`)
that captures a standard set of aggregate production metrics from D1 via
`wrangler d1 execute staged-publish-review --remote --json` and writes a
timestamped JSON report to `~/.drydock-ops/snapshots/`. It never runs in
`verify` or CI, and it needs local Wrangler auth (the same login that makes
`wrangler d1 --remote` work).

Queries: scan volume by day (last 14 days), scans by source and by status,
finding counts by rule id, workflow-gate decisions by outcome, scan events by
type (last 14 days), and failed-scan error codes.

## Hard rules

- **Aggregates only.** This repository is public and ops output feeds public
  ops-loop issues, so nothing attributable may appear: no organization, user,
  package, stage, repository, or email identifiers in queries or results. The
  script enforces this twice — a forbidden-column check on every SQL statement
  and a declared-column allowlist on every result row — and
  `test/ops-snapshot.test.mjs` pins both.
- **Never inside the repo.** The script refuses to write when the output
  directory (default `~/.drydock-ops`, overridable with `DRYDOCK_OPS_DIR`)
  resolves inside the repository.
- **No secrets in output or logs.** The queries touch no token/credential
  columns, and the script prints only query names, row counts, and the output
  path.

## Local validation

`pnpm run ops:snapshot -- --local --database <name> --config <path> --persist-to <path>`
runs the same queries against local Wrangler D1 storage (for example the e2e
harness state) to validate query syntax without touching production.
