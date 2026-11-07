# Product analytics

Analytics Engine counters measure review work, reviewer health, feedback, and public diff reads. **Authority:** internal. **Owner:** `server/lib/analytics.ts`.

## At a glance

| Thing | Owner file | Who may call / trigger | Pinned by (test) |
| --- | --- | --- | --- |
| Vocabulary, encoding, sink | `server/lib/analytics.ts` | Worker | `test/analytics.test.mjs` |
| Scan funnel | `server/db/scan-decisions.ts` | Execution; authenticated decisions | `test/workers/analytics-events.test.ts` |
| Public reads | `server/routes/public-diff.ts` | Anonymous diff/badge requests | `test/workers/public-diff-routes.test.ts` |

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
| `double1` | Machine duration in milliseconds, except human hold time for `scan.decided`; zero when inapplicable; absent for `badge.served` |
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
| `ai_review.finished` | `maybeRunAiReview` | status, model, reviewer version | duration, finding count, steps, input/cache/output/total tokens |
| `ai_review.attempted` | `analyzeWithAi` | outcome, action, model, reviewer version | duration, attempt, steps, input/cache/output/total tokens, coverage counts below |
| `ai_review.decided` | Both single-decision paths | decision, status, release assessment, model, reviewer version | 0 |
| `injection_screen.finished` | `withInjectionScreen` | status, reason, model, screen version | duration, spans screened, findings, input tokens |
| `npm_connection.validated` | npm connection validation | outcome | 0 |
| `public_diff.viewed` | `loadRequestedDiff`; successful version-pair request only | package name, cache, risk, client | duration |
| `badge.served` | `GET /public/badge/*`; proxy refresh, never impression | package name, dist-tag, outcome, route | None |
| `user.signed_up` | Better Auth user-create hook | method (`email_password` / `github`), outcome | 0 |
| `organization.created` | `POST /api/v1/organizations`; excludes lazy personal workspaces | None | 0 |
| `integration.connected` | npm / GitHub / Slack connection | outcome; integration kind occupies `blob4` | 0 |
| `workflow_gate.opened` | `deployment_protection_rule` webhook | None | 0 |
| `workflow_gate.reviewed` | Gate runner | recommendation, timeout state | duration, package count |
| `workflow_gate.decided` | Human route or automatic block | surface, decision | 0, package count |

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
| Public-diff reads | Successful version-pair requests | Counting `/file` requests |
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
12. Filter `blob2` before `quantile(0.95)(double1)`: machine durations otherwise mix with hours/days of human hold time.
13. Decision ecosystem is the path: `gate` for gates; `npm` staged; `npm` / `pypi` published pairs.
14. `scan.decided` `blob8` is `single` through either route, or `batch` via `POST /api/v1/scans/batch-approval`; batches emit one event per review and no `ai_review.decided`.
15. Lifecycle `blob4` knows its path only: `npm` for staged/auto-discovered; `npm` / `pypi` for published pairs.
16. `/file` shares the diff loader but emits no view: file opens must not multiply views or bias cache mix toward `hit`.
17. Public-diff `blob8` is `dependency-pr` for comment-workflow CI fetching once per PR push, `other` otherwise; filter `blob8 != 'dependency-pr'` for reader traffic. Self-reported `x-drydock-client` proves nothing ([workflow](./dependency-pr-diff-links.md)).
18. Missing provider usage is zero, including failed attempts without reported steps; zero is not a measured free invocation. Use status/model context.
19. Completed-step usage survives later failure; use `ai_review.attempted` for fallback costs by model, not the final `ai_review.finished` model.
20. `publication.discrepancy` counts first-created alerts only, without package name, tarball content, or credentials; rechecks and acknowledgments do not increment.

### Compatibility

| Existing dataset rows | Interpretation |
| --- | --- |
| `scan.decided` without `blob8` | Single decisions |
| Lifecycle and non-gate decision rows predating published-pair reviews | Literal `npm`; indistinguishable from staged npm, which those rows were |
| `public_diff.viewed` without `blob8` | Predates client dimension and CI summary fetching |
| Reviewer attempts before reviewer 1.9.0 | Coverage doubles `double8`–`double14` are zero; mapping owner: `server/lib/analytics.ts` |

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
4. `ai_review.attempted` always has blank organization; retain no scan, stage, package, prompt, evidence, or Gateway log identifier (`server/lib/analytics.ts`, `server/lib/ai-review/index.ts`).
5. Every union arm requires a privacy assertion; exhaustive comparison enforces this (`test/analytics.test.mjs`).
6. No referrers, campaigns, landing/docs page views, browser scripts, beacons, or cookies (`server/lib/analytics.ts`; [security model](./security-model.md)).
7. Worker emit events; browser instrumentation requires public-endpoint security review (`server/lib/analytics.ts`).
8. Scan failures are terminal only, including queue and workflow-gate paths; successful retries are not failures (`server/lib/scan/job.ts`, `server/lib/workflow-gate-job.ts`).
9. Disabled placeholders emit no feedback (`server/db/scan-decisions.ts`).
10. Invalid/unavailable AI results floor scan risk at medium and cannot display as “low risk / nothing unusual” (`server/lib/scan/pipeline.ts`; [review contract](./ai-review-eval.md)).
11. Keep Gateway metadata logs and one-attempt override enabled; payload collection off (`server/lib/ai-review/gateway.ts`).
12. Requests pin `cf-aig-max-attempts: 1` and `cf-aig-collect-log-payload: false`; dashboard settings cannot re-enable evidence payload logging (`server/lib/ai-review/gateway.ts`).

## Failure modes

| Symptom / condition | Cause | What happens | Fix |
| --- | --- | --- | --- |
| No counters anywhere | `PRODUCT_ANALYTICS` (optional) absent | Immediate no-op | Configure binding/dataset if measurement is required |
| `analytics.write_failed` | Dataset write throws | Warn log; application work continues | Inspect Workers Logs and binding |
| Missing reviewer coverage | `FLAGS` absent or `ai-review` disabled | No reviewer invocation or finished event | Check flag/binding; compare completions with attempts |
| Reviewer `invalid` / `unavailable` | Attempt could not yield usable result | Risk safely floored; status counter exposes failure | Inspect status/model/version and adjudicate |
| Zero steps despite provider traffic | Provider omitted usage after failed attempt | Step-based RPM undercounts | Use Gateway request metrics |

## Change checklist

| If you change | Also update / run |
| --- | --- |
| Event union or positional slots | Update `ANALYTICS_EVENT_NAMES`, bump `ANALYTICS_SCHEMA_VERSION` for mapping changes, update every privacy arm in `test/analytics.test.mjs` |
| Emitters | Preserve queue/gate parity; run `pnpm exec vitest run --project node test/analytics.test.mjs` and `test/workers/analytics-events.test.ts` |
| Public-diff, badge, or client instrumentation | Check [security model](./security-model.md), [public badge](./public-badge.md), privacy assertions, and view/serve semantics |
| AI routing or attempt logging | Check [AI review eval](./ai-review-eval.md), Gateway headers, per-model attribution, and Cloudflare alerts |
| Troubleshooting | Workers Logs for debugging; [audit log](./audit-log.md) for human actions; [ops snapshot](./ops-snapshot.md) for production aggregates |
