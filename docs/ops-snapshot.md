# Ops snapshot

The operator-only snapshot captures aggregate D1 metrics in a timestamped JSON report outside the repository. **Authority:** internal. **Owner:** `scripts/ops-snapshot.mjs`.

## At a glance

| Thing | Owner file | Who may call / trigger | Pinned by (test) |
| --- | --- | --- | --- |
| Aggregate snapshot | `scripts/ops-snapshot.mjs` | Operator with local Wrangler auth; never verify or CI | `test/ops-snapshot.test.mjs` |

## Contract

| Command | Result |
| --- | --- |
| `pnpm run ops:snapshot` | Production D1 via `wrangler d1 execute staged-publish-review --remote --json`; requires local Wrangler login |
| `pnpm run ops:snapshot -- --local --database <name> --config <path> --persist-to <path>` | Same queries against local Wrangler D1, such as e2e storage; validates SQL without production access |

| Output / query | Contract |
| --- | --- |
| Destination | Timestamped JSON in `~/.drydock-ops/snapshots/`; `DRYDOCK_OPS_DIR` overrides the base directory |
| Time window | Last 14 days for scan volume by day and event type; `FOURTEEN_DAYS_SQL` in `scripts/ops-snapshot.mjs` |
| Scan aggregates | Source, status, finding-count buckets, release-risk buckets and failed-scan error codes |
| Gate aggregates | Workflow-gate decisions by outcome |
| Per-rule counts | Unavailable in D1: findings live in R2 `report.json`; requires R2-side aggregation |

## Invariants

1. Queries/results contain no organization, user, package, stage, repository or email identifiers; public ops-loop issues require unattributable aggregates (`assertAggregateOnly`, `assertRowShape` in `scripts/ops-snapshot.mjs`).
2. Every SQL statement passes a forbidden-column check and every result row passes its declared-column allowlist (`test/ops-snapshot.test.mjs`).
3. Output must never resolve inside the repository, including with `DRYDOCK_OPS_DIR` (`resolveSnapshotDir` in `scripts/ops-snapshot.mjs`).
4. Queries touch no credential/token columns; normal progress output contains only query names, row counts and output path (`scripts/ops-snapshot.mjs`).

## Failure modes

| Symptom/condition | Cause | What happens | Fix |
| --- | --- | --- | --- |
| Query/result rejected | Identifier column, nonaggregate SQL or undeclared result column | Snapshot aborts before report write | Keep aggregates only; update query and result allowlist together |
| Output directory rejected | Path resolves inside repository | Script refuses to write | Use default or an external `DRYDOCK_OPS_DIR` |
| Remote D1 fails | Missing Wrangler auth/access | No report written | Authenticate locally or validate with `--local` |

## Change checklist

- If queries/output change → keep aggregate-only guards and external destination; run `pnpm exec vitest run --project node test/ops-snapshot.test.mjs`.
- If finding-level metrics are needed → use verified R2 reports; see [artifact storage](./artifact-storage.md).
