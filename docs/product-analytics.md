# Product analytics

Analytics Engine counters measure review work, reviewer health, feedback, whether members open a completed review's report, and public diff reads. **Authority:** internal. **Owner:** `server/lib/analytics.ts`.

## At a glance

| Thing | Owner file | Who may call / trigger | Pinned by (test) |
| --- | --- | --- | --- |
| Vocabulary, encoding, sink | `server/lib/analytics.ts` | Worker | `test/analytics.test.mjs` |
| Scan funnel | `server/db/scan-decisions.ts` | Execution; authenticated decisions | `test/workers/analytics-events.test.ts` |
| Public reads | `server/routes/public-diff.ts` | Anonymous diff/badge requests | `test/workers/public-diff-routes.test.ts` |
| Report views | `server/lib/scan/report-view.ts`, `server/db/scan-views.ts` | `GET /api/v1/scans/:id` on a `complete` scan | `test/workers/scan-report-views.test.ts`, `test/report-view-verdict.test.ts` |

## Contract

### Binding and schema

| Setting | Value / rule | Owner |
| --- | --- | --- |
| Binding | `PRODUCT_ANALYTICS` (optional) | `server/env.d.ts` |
| Dataset | `drydock_product_events` | `wrangler.jsonc` |
| Positional version | `ANALYTICS_SCHEMA_VERSION`; bump when mappings change, never shift existing fields silently | `server/lib/analytics.ts` |
| Missing binding | `recordProductEvent` returns immediately; local dev/tests/self-hosting may omit it | `server/lib/analytics.ts`, `docs/examples/wrangler.self-host.jsonc` |
| Write failure | Warn event `analytics.write_failed`; request/job continues | `server/lib/analytics.ts` |

| Slot | Meaning |
| --- | --- |
| `index1` | Event name; sampling key prevents high-volume events starving low-volume events |
| `blob1` | Schema version |
| `blob2` | Event name, repeated for blob-only queries |
| `blob3` | Opaque organization id on authenticated events; `""` for anonymous events and reviewer attempts |
| `blob4` | Ecosystem, integration kind for `integration.connected`, or `""` when not applicable |
| `blob5+` | Event dimensions below, in listed order |
| `double1` | Machine duration in milliseconds, except a human wait (also milliseconds, hours or days) for `scan.decided` and `scan.viewed`; zero when inapplicable; absent for `badge.served` |
| `double2+` | Counts below, in listed order |

### Events

`toDataPoint` in `server/lib/analytics.ts` fixes these mappings: dimensions start at `blob5`, numbers at `double1`.

| Event | Trigger / emitter | Dimensions | Numbers |
| --- | --- | --- | --- |
| `publication.discrepancy` | Publication monitor; first-created alert | status, observation reason (`""` if none, e.g. `ai_flagged_without_decision`) | 0 |
| `scan.queued` | `POST /api/v1/scans`, discovery, gate runner | source | 0 |
| `scan.completed` | `recordCompletion` | source, release risk, artifact risk, context risk | duration, rule findings, AI findings |
| `scan.failed` | `executeScanJob`, gate runner; terminal failure only | source, error code | duration |
| `scan.discarded` | `executeScanJob`; queued work retired before execution | source, reason | duration |
| `scan.decided` | Both decision paths; per review in batches | decision, release risk, artifact risk, via | human time-to-decision |
| `scan.viewed` | `GET /api/v1/scans/:id`; once per scan, the load taking `report_view_count` from 0 to 1 | source, surface (`web` / `notification`), npm's last known version status (`superseded`, or `none` when unknown), `decided` / `undecided` | review completion to first load |
| `ai_review.finished` | `maybeRunAiReview` | status, model, reviewer version | duration, finding count, steps, input/cache/output/total tokens |
| `ai_review.attempted` | `analyzeWithAi` | outcome, action, model, reviewer version | duration, attempt, steps, input/cache/output/total tokens, coverage counts below |
| `ai_review.decided` | Both single-decision paths | decision, status, release assessment, model, reviewer version | 0 |
| `injection_screen.finished` | `withInjectionScreen` | status, reason, model, screen version | duration, spans screened, findings, input tokens |
| `npm_connection.validated` | npm connection validation | outcome | 0 |
| `public_diff.viewed` | `loadRequestedDiff`; successful version-pair request only | package name, cache, risk, client (`PUBLIC_DIFF_CLIENTS` or `other`) | duration |
| `badge.served` | `GET /public/badge/*`; proxy refresh, never impression | package name, dist-tag, outcome, route | None |
| `user.signed_up` | Better Auth user-create hook | method (`email_password` / `github`), outcome | 0 |
| `organization.created` | `POST /api/v1/organizations`; excludes lazy personal workspaces | None | 0 |
| `integration.connected` | npm / GitHub / Slack connection | outcome; integration kind occupies `blob4` | 0 |
| `workflow_gate.opened` | `deployment_protection_rule` webhook | None | 0 |
| `workflow_gate.reviewed` | Gate runner | recommendation, timeout state | duration, package count |
| `workflow_gate.decided` | Human route or automatic block | surface, decision | 0, package count |
| `dependency_review.completed` | Dependency review job, on the pass that publishes | conclusion | duration across every pass, bumps, held bumps |
| `dependency_review.approved` | Check-run Approve | None | 0, approved bumps |

| `ai_review.attempted` slot | Coverage count |
| --- | --- |
| `double8` | Changed files |
| `double9` | Changed files read to the end |
| `double10` | Required paths |
| `double11` | Required paths unread at the end |
| `double12` | Coverage rejections |
| `double13` | Evidence characters returned |
| `double14` | Coverage-read characters |

| Scan source | Meaning |
| --- | --- |
| `manual` | Staged publish started in Drydock, including “Check npm” discoveries |
| `auto_discovery` | Discovery cron |
| `workflow_gate` | Protected-job review |
| `published` | Already-public release pair, started from onboarding or `/diff`; requires neither npm token nor staged release |

Activation: per-organization `published` share of `scan.queued`; first `published` followed by `manual` or `workflow_gate`.

### Metrics

| Metric | Use | Avoid |
| --- | --- | --- |
| Badge serves | Relative breadth, distinct live packages, green/grey mix | Impressions or viewer counts |
| Reviewer outcomes | Status fractions of attempts; coverage versus `scan.completed` | Treating attempts as scans |
| Maintainer decisions | Disagreements for adjudication | Ground truth or direct reviewer promotion |
| Public-diff reads | Successful version-pair requests; people: `blob8 NOT IN ('dependency-pr', 'cli', 'mcp')`; agents and scripts: `blob8 IN ('cli', 'mcp')` | Counting `/file` requests |
| Report views | Whether a completed review was opened, how soon, from where; opened-before-publication from the [ops snapshot](./ops-snapshot.md) | Reading a view as a review of the release |
| Provider cost | `ai_review.attempted` model usage | Attributing fallback spend to the final model |
| Provider RPM | Gateway request metrics | Treating completed steps as exact request count |

1. `badge.served` counts proxy refreshes behind shields.io, GitHub Camo, and Worker colo cache (up to three caches); never publish or plan against it as views.
2. Camo strips referrers; images cannot carry beacons; Drydock cannot control embeds. Per-viewer README impressions are unrecoverable.
3. Badge cache response is `cache-control: public, max-age=300` in `server/routes/public-reports.ts`; lowering TTL improves resolution while multiplying anonymous requests.
4. Reserved `/b/*` images are unimplemented; own-origin images could remove shields and one cache layer, but GitHub Camo remains.
5. Badge `blob5` package, `blob6` tag, `blob8` route require an answering review; all are empty for `not_reviewed`, excluding attacker-chosen names/tags.
6. Badge `blob7` outcomes: `approved`, `blocked`, `reviewed`, `superseded`, `superseded_blocked`, `superseded_unapproved`, `not_reviewed`.
7. Badge routes: `default` needs no opt-in; `listed` is deliberate listing; `post_release` is a publisher decision after release.
8. `superseded_blocked` means declined after npm publication, or rejected before npm published anyway; `superseded_unapproved` means publisher's monitor saw publication without approval and no decision yet.
9. No client instrumentation: `/diff` view-through counts, “Create account” clicks do not; diff → signup conversion rate cannot be computed from signups and view counts alone. A client beacon requires public-endpoint security review.
10. `ai_review.finished` counts attempts: disabling the organization's `ai-review` killswitch or omitting `FLAGS` returns before invocation and emits nothing.
11. `ai_review.decided` is feedback, never ground truth: publish may accept known risk; discard may be unrelated. Find disagreements for adjudication; never tune/promote directly on raw agreement rate ([review rules](./ai-review-eval.md)).
12. Filter `blob2` before `quantile(0.95)(double1)`: machine durations otherwise mix with the hours/days of human wait in `scan.decided` and `scan.viewed`.
13. Decision ecosystem is the path: `gate` for gates; `npm` staged; `npm` / `pypi` published pairs.
14. `scan.decided` `blob8` is `single` through either route, or `batch` via `POST /api/v1/scans/batch-approval`; batches emit one event per review and no `ai_review.decided`.
15. Lifecycle `blob4` knows its path only: `npm` for staged/auto-discovered; `npm` / `pypi` for published pairs.
16. `/file` shares the diff loader but emits no view: file opens must not multiply views or bias cache mix toward `hit`.
17. Public-diff `blob8` is the client: `dependency-pr` for comment-workflow CI fetching once per PR push ([workflow](./dependency-pr-diff-links.md)); `cli` for the Drydock CLI's `diff` command; `mcp` for a `compare_package_versions` call on the hosted MCP endpoint, one row per tool call (each changed-file page is a call); `other` for the browser `/diff` page and any caller without the header. CLI and MCP calls are tagged, not dropped: agent adoption is a signal, and a separate value keeps it out of the page-view number. The value comes from the caller's `x-drydock-client` header (the MCP route sets it on its in-process dispatch), so it separates traffic shapes and proves nothing.
18. Missing provider usage is zero, including failed attempts without reported steps; zero is not a measured free invocation. Use status/model context.
19. Completed-step usage survives later failure; use `ai_review.attempted` for fallback costs by model, not the final `ai_review.finished` model.
20. `publication.discrepancy` counts first-created alerts only, without package name, tarball content, or credentials; rechecks and acknowledgments do not increment.
21. `scan.viewed` does not claim whether the load came before publication (usually unknown when it happens); read that from the [ops snapshot](./ops-snapshot.md). Reloads and reviews older than view tracking emit nothing.

### Compatibility

| Existing dataset rows | Interpretation |
| --- | --- |
| `scan.decided` without `blob8` | Single decisions |
| Lifecycle and non-gate decision rows predating published-pair reviews | Literal `npm`; indistinguishable from staged npm, which those rows were |
| `public_diff.viewed` without `blob8` | Predates client dimension and CI summary fetching |
| `public_diff.viewed` with `blob8 = 'other'` before the `cli`/`mcp` values existed | Includes CLI and MCP calls; the people filter keeps them |
| `scans` rows created before view tracking | `report_view_count` null: earlier loads went unrecorded, `report_first_viewed_at` is only the earliest recorded load, and the verdict can prove `opened` and nothing else |
| Reviewer attempts before reviewer 1.9.0 | Coverage doubles `double8`–`double14` are zero; mapping owner: `server/lib/analytics.ts` |

### Report views

Answers "did anyone in the organization open this report before npm published it?" A view means the report was opened (a member fetched it), never that the release was reviewed.

| Rule | Contract |
| --- | --- |
| Recorded by | `GET /api/v1/scans/:id` for a `complete` scan, after the response through `waitUntil`, so the write can neither slow nor fail the read (`recordReportView` in `server/lib/scan/report-view.ts`); a failed write emits `scan.report_view_record_failed` |
| Not views | Loads of queued, running, or failed reviews (no report yet); public share links, `/diff`, the report export, and the status poll record nothing |
| Storage | `scans` columns from migration `0044_eager_tombstone` (`drizzle/0044_eager_tombstone.sql`); writes never touch `updated_at`, since a view is not a change to the review |
| `report_first_viewed_at` / `report_last_viewed_at` | First and latest counted load |
| `report_view_count` | Loads, including reloads and the reload after a change on the page; at most one per `REPORT_VIEW_THROTTLE_MS` (60 s, `server/db/scan-views.ts`), enforced in the UPDATE's WHERE so a skipped write costs no extra read; the first load is never throttled. Written as 0 at scan creation; null on rows created before view tracking |
| `report_first_view_surface` | `notification` when the first load landed from an email or Slack link (`?via=notification`, `server/lib/notify/links.ts`; the page drops it from its address and passes it on until a load returns the completed report); `web` otherwise, including GitHub comment links. A counting hint, never authority |
| Verdict | `reportOpenedBeforePublication` in `server/db/scan-views.ts` returns `opened`, `not_opened`, or `unknown` for a completed, non-superseded staged review (`manual` / `auto_discovery`), and null without evidence of publication; served as `scan.reportOpenedBeforePublication` on the scan detail |
| Publication evidence 1 | `registry_published_at`: npm's own publication time, stamped by this organization's [publication monitor](./publication-monitor.md) only on reviews whose stage SHA-1 matches the published bytes. The first view orders against it, except within `REPORT_VIEW_CLOCK_SKEW_MS` (10 s) either side, which is `unknown` because the clocks are independent |
| Publication evidence 2 | A `published` or `deleted` [version status](./registry-version-status.md), which only says the release was out by `registry_version_status_at`: a view before that observation (plus the skew margin) is `unknown`; only a later view, or none, is `not_opened` |
| Not publication | A stage leaving npm's stage list, a `blocked` status, or no status; the answer is null |
| `not_opened` | Also requires `report_view_count` non-null (counted since creation); an older review can prove `opened` and nothing else. Describes the organization, not a person, and never says who should have looked |
| Aggregate | [Ops snapshot](./ops-snapshot.md) applies the same rule in SQL; `test/report-view-verdict.test.ts` runs both over the same rows |

### Queries and alerts

Cloudflare SQL API:

```sh
curl "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -d "SELECT blob2 AS event, count() AS n
      FROM drydock_product_events
      WHERE timestamp > now() - INTERVAL '7' DAY
      GROUP BY event ORDER BY n DESC"
```

| Query | Rule |
| --- | --- |
| Sampled counts | Under load, replace `count()` with `SUM(_sample_interval)` |
| Screen fire rate | `SUM(double3 > 0)` over completed `injection_screen.finished` with `double2 > 0`, by screen version |
| Screen rollout | Read per-organization fire rate before widening `clef-injection-screen` |
| Screen reason (`blob6`) | `none`, `no_candidates`, or why Clef gave no answer |
| Exact provider RPM | AI Gateway request metrics; attempt steps (`double3`) only approximate requests |
| Routing/fallback | Analytics Engine, without private identifiers |

Alert on any condition over a rolling five-minute window:

| Condition | Threshold / action |
| --- | --- |
| `rate_limited` | Non-zero or above 0.1% of attempts |
| `capacity` | Above 1% |
| `fallback` | Above 2% |
| Terminal failures | Above 0.5% |
| Completed agent steps (`SUM(double3)`) | Above 80% of current documented text-generation allocation |
| Kimi steps | Above 60% of current model-specific allocation |
| Oldest pending scan | More than two minutes old |
| Numeric provider RPM allocations | Keep in Cloudflare alert configuration; limits can change |

## Invariants

1. Never add PII: no user ids, emails, IP addresses, user agents, or session data (`server/lib/analytics.ts`, `test/analytics.test.mjs`).
2. Never retain package evidence, finding text, file paths, or versions in analytics (`server/lib/analytics.ts`, `test/analytics.test.mjs`).
3. Organization ids are opaque and authenticated-only; anonymous diff package names are already public in request URLs, response cache keys, and Open Graph metadata (`server/routes/public-diff.ts`).
4. `ai_review.attempted` always has blank organization; `ai_review.decided` carries organization, ecosystem, decision, status, assessment, model, and reviewer version only. Neither retains a scan, stage, package, prompt, evidence, or Gateway log identifier (`server/lib/analytics.ts`, `server/lib/ai-review/index.ts`).
5. Every union arm requires a privacy assertion; exhaustive comparison enforces this (`test/analytics.test.mjs`).
6. No referrers, campaigns, landing/docs page views, browser scripts, beacons, or cookies (`server/lib/analytics.ts`; [security model](./security-model.md)).
7. Report views are per scan, never per user: the scan row keeps when, how often, and via which surface its report was first loaded, never who; per-user rows would turn "did anyone look before publication" into individual activity tracking for no extra answer (`server/db/scan-views.ts`).
8. Worker emit events; browser instrumentation requires public-endpoint security review (`server/lib/analytics.ts`).
9. Scan failures are terminal only, including queue and workflow-gate paths; successful retries are not failures (`server/lib/scan/job.ts`, `server/lib/workflow-gate-job.ts`).
10. Disabled placeholders emit no feedback (`server/db/scan-decisions.ts`).
11. Invalid/unavailable AI results floor scan risk at medium and cannot display as “low risk / nothing unusual” (`server/lib/scan/pipeline.ts`; [review contract](./ai-review-eval.md)).
12. Keep Gateway metadata logs and one-attempt override enabled; payload collection off (`server/lib/ai-review/gateway.ts`).
13. Requests pin `cf-aig-max-attempts: 1` and `cf-aig-collect-log-payload: false`; dashboard settings cannot re-enable evidence payload logging (`server/lib/ai-review/gateway.ts`).

## Failure modes

| Symptom / condition | Cause | What happens | Fix |
| --- | --- | --- | --- |
| No counters anywhere | `PRODUCT_ANALYTICS` (optional) absent | Immediate no-op | Configure binding/dataset if measurement is required |
| `analytics.write_failed` | Dataset write throws | Warn log; application work continues | Inspect Workers Logs and binding |
| Missing reviewer coverage | `FLAGS` absent or `ai-review` disabled | No reviewer invocation or finished event | Check flag/binding; compare completions with attempts |
| Reviewer `invalid` / `unavailable` | Attempt could not yield usable result | Risk safely floored; status counter exposes failure | Inspect status/model/version and adjudicate |
| Zero steps despite provider traffic | Provider omitted usage after failed attempt | Step-based RPM undercounts | Use Gateway request metrics |
| Report opened before a status read reads `unknown` | No publication-monitor observation; publication is only bounded by the last version-status read | Verdict `unknown` rather than `opened` | Watched packages get npm's exact publication time |
| `not_opened` wrong during a deploy | A scan created by new code (count 0) read through an older Worker that records nothing | Possible false `not_opened`; scans old code created stay null and are safe | Discount the rollout window |
| View recorded with nobody looking | A page left open while a review runs reloads when it completes | Counted load | None; a view is a load, not a read |
| `not_opened` on a report that did not exist yet | Review completed after npm published | Indistinguishable in the verdict | Use the snapshot's `reviewReady` column (exact publication times only) |
| Script or CLI read counted as `web` | API-key reads of `GET /api/v1/scans/:id` (for example `drydock approve`) take the same path as a browser load ([API keys](./api-keys.md)) | Counted load attributed to the organization | Read views as "fetched", not "read by a person" |

## Change checklist

| If you change | Also update / run |
| --- | --- |
| Event union or positional slots | Update `ANALYTICS_EVENT_NAMES`, bump `ANALYTICS_SCHEMA_VERSION` for mapping changes, update every privacy arm in `test/analytics.test.mjs` |
| Emitters | Preserve queue/gate parity; run `pnpm exec vitest run --project node test/analytics.test.mjs` and `pnpm exec vitest run --project workers test/workers/analytics-events.test.ts` |
| Public-diff, badge, or client instrumentation | Check [security model](./security-model.md), [public badge](./public-badge.md), privacy assertions, and view/serve semantics |
| AI routing or attempt logging | Check [AI review eval](./ai-review-eval.md), Gateway headers, per-model attribution, and Cloudflare alerts |
| Troubleshooting | Workers Logs for debugging; [audit log](./audit-log.md) for human actions; [ops snapshot](./ops-snapshot.md) for production aggregates |
