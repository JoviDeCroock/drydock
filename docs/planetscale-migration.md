# PlanetScale Migration Plan

Status: planning only. Do not execute until D1 pressure justifies the migration.
Target window: Q3 2026 unless growth forces it earlier.

Drydock should move canonical application state from Cloudflare D1 to
PlanetScale without losing rows, secrets, scan decisions, audit history, or
Better Auth state. R2 stays the long-term home for derived scan artifacts; the
SQL migration is for metadata and workflow state, not raw package contents or
large redacted samples.

## Goals

- Preserve every D1 row that represents user, organization, auth, credential,
  scan, workflow-gate, Slack, notification, and audit state.
- Keep existing Drizzle as the application data-access layer instead of
  replacing it with a new ORM.
- Avoid a big-bang cutover: backfill first, run dual writes, shadow reads, then
  flip reads only after consistency checks pass.
- Keep D1 available as rollback source until PlanetScale has been primary long
  enough to prove reliability.
- Keep package evidence trust boundaries unchanged: raw tarballs are still not
  retained, R2 artifacts are still digest-verified, and operational logs remain
  secret-redacted.

## Non-Goals

- Do not move R2 artifacts into PlanetScale.
- Do not migrate historical SQL files in `drizzle/` in place. D1 migrations stay
  as the D1 history.
- Do not rely on database foreign-key cascades for correctness during the first
  migration. The app already deletes in dependency order because D1 does not
  enforce foreign keys by default.
- Do not remove D1 bindings, D1 migrations, or D1 backups during the cutover
  window.

## Target Shape

Default target: PlanetScale Postgres reached from the Cloudflare Worker through
Hyperdrive, with Drizzle's PostgreSQL schema and driver. Cloudflare recommends
using Hyperdrive with a direct PostgreSQL driver such as `node-postgres` or
Postgres.js for PlanetScale Postgres rather than the PlanetScale serverless
driver. Use Hyperdrive first because this app is already Cloudflare-first and
`wrangler.jsonc` already enables `nodejs_compat`.

MySQL/Vitess is no longer the default migration target. Keep it only as a
fallback if the pre-migration spike finds a concrete PlanetScale Postgres
blocker.

Expected application changes:

- Add a database backend selector with modes like `d1`, `planetscale`, and
  `dual`.
- Split the D1-specific schema from the target schema, for example
  `server/db/schema.d1.ts` and `server/db/schema.planetscale-pg.ts`, or create
  a shared logical schema layer with dialect-specific table declarations.
- Add a new migration output folder such as `drizzle-planetscale-postgres/`.
- Update the production database factory in `server/db/client.ts` so callers
  still receive an `AppDb`, while the factory hides D1 versus PlanetScale
  construction.
- Update Better Auth's Drizzle adapter provider from `sqlite` to `pg` at
  cutover.
- Keep local and Worker tests able to run against D1 until the PlanetScale test
  harness exists.

## Pre-Migration Decisions

Make these decisions before writing migration code:

1. Confirm there are no PlanetScale Postgres blockers for Workers runtime,
   Hyperdrive, migrations, branching, backups, and operational limits.
2. Confirm the Worker connection path: Hyperdrive plus `node-postgres` by
   default; Postgres.js only if the spike shows better runtime behavior.
3. Decide when to enable database-enforced foreign keys. Initial recommendation:
   generate the Postgres schema with explicit constraints after validating and
   cleaning the D1 export, but keep application-level cleanup paths because the
   cutover should not rely on cascades for correctness.
4. Choose timestamp storage. The safest target is `timestamptz(3)` with Drizzle
   `mode: "date"`, with export validation normalized back to epoch
   milliseconds.
5. Define the rollback retention period. Initial recommendation: keep D1
   dual-written and restorable for at least 14 days after full read cutover.

## Drizzle Conversion Checklist

The current schema uses `drizzle-orm/sqlite-core`, D1's `drizzle-orm/d1`
driver, and `drizzle-kit` with `dialect: "sqlite"` and `driver: "d1-http"`.
The Postgres target schema must be generated separately.

Key conversion work:

- Replace `sqliteTable` declarations with `pgTable` declarations.
- Keep semantically unbounded values as `text`: reasons, evidence, ciphertext,
  nonces, serialized errors, and large string payloads. Use bounded `varchar`
  only where the value already has a real domain limit, such as IDs, status
  fields, roles, and short provider names.
- Move JSON columns from SQLite text JSON mode to `jsonb` only after verifying
  Drizzle and Better Auth return the same shapes the app expects.
- Replace SQLite boolean integers with Postgres `boolean`.
- Preserve `.returning()` where Postgres supports it, but still audit every
  compare-and-set update helper so affected-row checks and concurrency semantics
  remain explicit.
- Audit `db.batch(...)` call sites. D1 batching does not map one-for-one to all
  target drivers; use Postgres transactions where the writes must be atomic and
  explicit ordered writes where they do not.
- Remove or rename D1-specific insert chunking such as `chunkForD1` once the
  target parameter and payload limits are known. Keep chunking for large scan
  rows if it still protects latency and memory use.
- Re-check raw SQL fragments like `sql\`${rateLimits.count} + 1\`` against the
  Postgres dialect.
- Update Better Auth tables and adapter provider in the same branch as the
  target schema.

## Migration Phases

### Phase 0: Readiness Trigger

Start implementation only when at least one trigger is true:

- D1 storage or write volume is trending toward an operational limit within one
  quarter.
- D1 p95/p99 query latency materially affects dashboard, scan detail, webhook,
  or queue processing paths.
- D1 migration, backup, or compaction operations become a recurring operational risk.
- Scan or workflow-gate growth requires SQL capabilities D1 cannot provide
  safely.

Before starting, complete artifact backfill as far as possible so large scan
samples are already in R2 and the SQL migration mostly moves compact metadata.

### Phase 1: Provision Target

1. Create the PlanetScale database, production branch, and a development branch
   for schema work.
2. Create least-privilege application credentials and separate migration
   credentials.
3. Create the Hyperdrive config and bind it in `wrangler.jsonc` behind a new
   environment-specific binding, leaving `DB` intact.
4. Add target-only secrets and document rotation.
5. Generate target migrations from the target Drizzle schema into
   `drizzle-planetscale-postgres/`; do not hand-write migrations.
6. Apply target migrations to a development branch first, then promote through
   PlanetScale's deployment workflow.

### Phase 2: Export And Backfill

1. Take a D1 export or backup snapshot and record its creation time, row counts,
   and schema migration level.
2. Build an idempotent migration runner under `scripts/` that reads from D1 and
   writes to PlanetScale in primary-key order.
3. Backfill tables in dependency order. A safe initial order is:
   `user`, `organizations`, `organization_members`,
   `organization_invitations`, `organization_notification_recipients`,
   `npm_connections`, `organization_slack_connections`,
   `github_app_installations`, `github_release_targets`,
   `github_workflow_gates`, `scans`, `scan_files`, `scan_findings`,
   `scan_events`, `session`, `account`, `verification`, `two_factor`, and then
   optional ephemeral `rate_limits`.
   If target foreign-key constraints are enabled, split the
   `github_workflow_gates.scan_id` and `scans.gate_id` cycle into an insert
   pass with nullable links followed by an update pass.
4. Copy encrypted secret material verbatim. Do not decrypt npm or Slack tokens
   during migration; the same production encryption key must remain configured.
5. Normalize dates and JSON through typed transforms, not ad hoc string edits.
6. Make every write idempotent so the runner can resume from a table and primary
   key cursor after interruption.

### Phase 3: Consistency Baseline

Run validation before any production dual write:

- Per-table row counts.
- Per-table canonical hashes over rows sorted by primary key, with timestamps
  normalized to epoch milliseconds and JSON serialized with stable key order.
- Target query checks for the highest-risk paths:
  authentication session lookup, active organization resolution, scan list,
  scan detail metadata, workflow-gate claim/update, npm connection lookup, Slack
  connection lookup, invitation acceptance, account deletion, and rate limiting.
- R2 artifact manifest checks for artifact-backed scans. The database rows must
  still point to existing R2 keys and matching digests.

Do not proceed until mismatches are understood and either corrected or explicitly
accepted as non-authoritative ephemeral data.

### Phase 4: Dual Writes

Add a dual-write mode where D1 remains the primary read and primary write, and
PlanetScale receives every durable mutation.

Requirements:

- Mutations must carry deterministic IDs where possible so retries are safe.
- Shadow write failures must be durable, not just logged. Add a small D1-backed
  migration outbox or queue message containing the operation identity and enough
  safe metadata to replay it.
- Queue jobs and webhook handlers must not acknowledge work that cannot be
  recovered into the target database.
- Emit structured operational events for dual-write success, failure, replay,
  and lag, without raw errors, headers, cookies, package contents, or secrets.
- Track target lag by table and by operation age.

Keep this phase running until a full backfill plus all captured deltas validate
cleanly.

### Phase 5: Shadow Reads

With D1 still serving users, read selected production paths from both databases
and compare normalized results out of band.

Start with read-only paths:

- `GET /api/v1/scans`
- `GET /api/v1/scans/:id`
- active organization resolution
- npm connection status reads
- GitHub release target and workflow-gate reads

Then shadow critical mutation preconditions:

- scan claim compare-and-set eligibility
- workflow-gate review claim eligibility
- invitation token lookup
- account deletion preflight

Do not compare raw encrypted values or package evidence in logs. Compare digests,
counts, IDs, timestamps, and safe status fields.

### Phase 6: Cutover

Use a short write freeze unless dual-write lag has stayed at zero under load for
long enough to justify a live flip.

Cutover sequence:

1. Disable scheduled discovery and pause new manual scan creation.
2. Drain or pause queue consumers after in-flight jobs finish.
3. Keep read-only routes available if they can tolerate D1 reads.
4. Run the migration runner in final-delta mode until the D1 and PlanetScale
   hashes match.
5. Flip production reads and writes to PlanetScale.
6. Re-enable queues, scheduled discovery, webhooks, and manual scan creation.
7. Keep D1 dual-written as rollback source during the retention period.

Initial rollout should be environment-gated and reversible through config, not a
new deploy-only rollback path.

### Phase 7: Rollback

Rollback is allowed while D1 is still dual-written.

Rollback steps:

1. Flip reads and writes back to D1.
2. Leave PlanetScale writes enabled only if they are known healthy; otherwise
   disable target writes and preserve the target database for inspection.
3. Replay any migration outbox items needed to restore D1 completeness.
4. Validate row counts and critical-path reads against D1.
5. Do not delete PlanetScale data or R2 artifacts during rollback.

Once D1 dual writes stop, rollback becomes a forward recovery from PlanetScale
back into a restored D1 database and needs a separate runbook.

### Phase 8: Contract

After the retention period:

1. Take a final D1 export and store it with the release artifacts.
2. Remove dual-write code and migration outbox processing.
3. Remove the D1 binding from production config only after all environments have
   a tested PlanetScale path.
4. Archive D1-specific migrations and docs instead of deleting history.
5. Update `README.md`, `docs/architecture.md`, `docs/artifact-storage.md`,
   `docs/release-safety.md`, and deployment docs to describe PlanetScale as the
   canonical metadata store.

## Verification Matrix

Before cutover:

- `pnpm run verify`
- Worker-route tests for auth, organization scoping, scan routes, webhooks,
  queue enqueueing, rate limits, and account deletion against the target DB path.
- Node tests for migration transforms and canonical row hashing.
- Fake-registry e2e for staged-publish scan flow and workflow-gate flow.
- Backfill dry run against a recent D1 export.
- Shadow-read comparison with zero unexplained mismatches.
- Load test for scan creation, scan completion persistence, scan list, scan
  detail metadata, workflow-gate updates, and rate-limit increments.

After cutover:

- Monitor database error rate, p95/p99 query latency, queue retry rate, webhook
  failure rate, dual-write lag, migration outbox depth, auth sign-in failures,
  scan completion failures, and artifact fallback reads.
- Keep an operator checklist for reverting the database backend flags.

## Known Risks

- Postgres does not preserve every SQLite/Drizzle behavior. JSON mode, boolean
  mode, timestamp mode, conflict/upsert behavior, transactions, and constraint
  enforcement need focused tests.
- PlanetScale Postgres foreign-key constraints are an explicit cutover choice.
  If they are enabled, historical D1 rows must be cleaned and validated before
  import so constraints do not block the final delta.
- Existing code intentionally cleans up child rows in application code. That
  behavior must stay correct even if the target database later enables
  constraints.
- Better Auth schema or adapter behavior may differ by provider. Sign-up,
  sign-in, email verification, sessions, password reset, TOTP, and account
  deletion need end-to-end coverage.
- Rate limiting depends on atomic conflict updates. Confirm target behavior
  under concurrent requests before moving write traffic.
- A dual-write failure that only logs is data loss. Failed target writes must be
  durably replayable.
- Long text and JSON values can exceed packet or row-size assumptions. Keep R2 as
  the artifact store and load-test large scan summaries before cutover.

## References

- Cloudflare Workers PlanetScale guide:
  https://developers.cloudflare.com/workers/databases/third-party-integrations/planetscale/
- Cloudflare Workers database connection guidance:
  https://developers.cloudflare.com/workers/databases/connecting-to-databases/
- Cloudflare Workers best practice for external databases:
  https://developers.cloudflare.com/workers/best-practices/workers-best-practices/#use-hyperdrive-for-external-database-connections
- Cloudflare Hyperdrive PlanetScale Postgres guide:
  https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/planetscale-postgres/
- PlanetScale Postgres docs:
  https://planetscale.com/docs/postgres
- PlanetScale Postgres with Drizzle:
  https://planetscale.com/docs/postgres/tutorials/planetscale-postgres-drizzle
- Drizzle PlanetScale Postgres guide:
  https://orm.drizzle.team/docs/connect-planetscale-postgres
