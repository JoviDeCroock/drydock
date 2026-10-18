# Ops snapshot

`pnpm run ops:snapshot` is an operator-only script (`scripts/ops-snapshot.mjs`)
that captures a standard set of aggregate production metrics from D1 via
`wrangler d1 execute staged-publish-review --remote --json` and writes a
timestamped JSON report to `~/.drydock-ops/snapshots/`. It never runs in
`verify` or CI, and it needs local Wrangler auth (the same login that makes
`wrangler d1 --remote` work).

Queries: scan volume by day (last 14 days), scans by source and by status,
scans bucketed by finding count and by release risk, workflow-gate decisions by
outcome, scan events by type (last 14 days), failed-scan error codes, and
whether published staged reviews had their report opened before publication.

`published_staged_reviews_opened_before_publication` counts completed,
non-superseded staged reviews with evidence of publication, grouped by
`decided` (a Drydock decision was recorded, at any time), `publicationEvidence`
(`npm_publish_time` from the publication monitor, or `version_status`, which only
bounds publication from above), `reviewReady` (whether the review had completed
before publication: `before`, `after`, or `unknown`), and
`openedBeforePublication` (`opened` / `not_opened` / `unknown`, the rule in
[`product-analytics.md`](./product-analytics.md#report-views)). The share is
`opened / (opened + not_opened)` per `decided` group; report `unknown` beside
it rather than folding it into either side, and read `reviewReady = after` as a
report that did not exist yet, not one nobody opened. "Opened" means a member
loaded the report, not that anyone reviewed the release.

Per-rule finding counts are not available here: findings live only in each
scan's R2 `report.json`, so D1 can answer how many findings a scan carried but
not which rules fired. A per-rule breakdown needs an R2-side aggregation.

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
