# Product analytics

Aggregate counters for the questions that outlive a debugging session: how many
scans run, how long they take, how often they fail, whether the AI reviewer is
healthy, whether maintainers agree with the risk grade, and how many package
diffs get read.

Scope is deliberately narrow: it counts work done across the review funnel and
successful public diff reads. Marketing page views and channel attribution were
removed — they measured traffic rather than work done, and every event they
produced sat in the hot path of serving a static document.

Implementation: `server/lib/platform/analytics.ts`. Binding: `PRODUCT_ANALYTICS`
(Cloudflare Analytics Engine, dataset `drydock_product_events`).

## Why this exists

Scan lifecycle events (`scan.started`, `scan.queued`, `scan.completed`,
`scan.failed`, `npm_connection.used`, `staged_publishes.scans_started`) used to
be D1 `scan_events` rows. They were ~97% of that table and carried no audit
value, so [`audit-log.md`](./audit-log.md) removed them and pointed operational
visibility at Workers Logs.

That was right for the audit log and wrong for measurement. Workers Logs is a
short-retention debugging stream: it answers "what happened to this scan an hour
ago", not "what did scan volume, latency, and failure rate do last month". After
the change, none of the latter was answerable at all.

Analytics Engine keeps the aggregate without keeping the row. The audit log stays
lean, and the product stays measurable.

## Privacy

Matching [`security-model.md`](./security-model.md):

- **No PII.** No user ids, emails, IP addresses, user agents, or session data.
- **No package contents.** No evidence, finding text, file paths, or versions.
- **Organization ids only on authenticated events.** They are opaque internal
  identifiers, so per-organization adoption stays answerable without
  identifying a person.
- **Public-diff analysis events record only the package name**, which is already
  public in the request URL, the response cache key, and the page's own Open
  Graph metadata.
- **No traffic data.** Referrers, campaign parameters, and page views of the
  landing and docs surfaces are not classified, counted, or stored anywhere.
- **Nothing is written from the browser.** No client script, no beacon
  endpoint, no cookie — and therefore no new anonymous surface to rate-limit or
  document. Every event is emitted by the Worker while it is already handling
  the request that caused it.

`test/analytics.test.mjs` asserts the no-PII property against every event in the
union, and fails if an arm is added without being exercised — so a new event
cannot ship without a privacy assertion.

## Known gaps

**No client instrumentation.** In-page interactions are invisible. `/diff`
view-through is counted; a click on its "Create account" call-to-action is not.
So the diff → signup conversion **rate** cannot be computed from this data —
only its numerator (signups) and a view count. Closing that needs a client
beacon and the public-endpoint review the security model requires for one. Do
not add one casually.

**`ai_review.finished` counts attempted reviews, not scans.** A scan whose
organization has the `ai-review` killswitch off — or any deployment without a
`FLAGS` binding, where the reviewer is off for everything — returns before the
reviewer is invoked and emits nothing. Read the status breakdown as a share of
attempts; compare against `scan.completed` to get coverage. It is emitted from
whichever reviewer ran: `maybeRunAiReview` for an inline review, the deferred
follow-up job (`server/lib/scan/ai-review-job.ts`) for a staged-publish one.

**`scan.completed` risk and finding counts exclude a deferred AI review.** On
the staged-publish path the review runs after the scan is persisted (see
[`architecture.md`](architecture.md#advisory-ai-review-is-off-the-critical-path)),
and `recordCompletion` fires before it exists — so `releaseRisk`/`artifactRisk`
are the deterministic grades and `aiFindingCount` is 0, even for scans the
review later escalates. The counter is not re-emitted afterwards, because that
would double-count scan volume. Read it as "the deterministic grade at
completion"; AI escalation is not currently answerable from this dataset and
would need its own event.

**`ai_review.decided` is feedback, not ground truth.** A publish can accept
known risk, and a discard can be unrelated to the review. Use it to find
disagreement worth adjudicating; do not tune or promote a reviewer directly on
raw agreement rate.

**`double1` is not one quantity.** It is a machine duration in milliseconds for
every event except `scan.decided`, where it is a human hold time — also in
milliseconds, but on a scale of hours or days. A dataset-wide
`quantile(0.95)(double1)` mixes the two; always filter by `blob2` first.

**Ecosystem on `scan.decided` is the decision path, not the registry.** The
staged-publish route reports `npm`; every gated decision reports `gate`,
because the gate decision route resolves a package scan rather than an adapter.

## Schema

Analytics Engine columns are **positional** (`blob1`, `double1`, …), not named,
so reordering silently rewrites the meaning of every historical query. Positions
are fixed per `ANALYTICS_SCHEMA_VERSION`; bump it rather than shifting a field.

| slot       | meaning                                          |
| ---------- | ------------------------------------------------ |
| `index1`   | event name — the sampling key                    |
| `blob1`    | schema version                                   |
| `blob2`    | event name (repeated so queries need only blobs) |
| `blob3`    | organization id, or `""` for anonymous events    |
| `blob4`    | ecosystem                                        |
| `blob5+`   | event-specific dimensions, in declaration order  |
| `double1`  | duration in ms (0 when not applicable)           |
| `double2+` | event-specific counts                            |

The event name is the sampling index so a high-volume event can never starve a
low-volume one out of the dataset.

## Events

| event                      | emitted from                  | answers                                     |
| -------------------------- | ----------------------------- | ------------------------------------------- |
| `scan.queued`              | `POST /api/v1/scans`          | queued → completed drop-off                 |
| `scan.completed`           | `recordCompletion`            | volume, latency, risk mix, finding counts   |
| `scan.failed`              | `executeScanJob`, gate runner | failure rate by error code                  |
| `scan.discarded`           | `executeScanJob`              | queued scans retired before they ever ran   |
| `scan.decided`             | both decision paths           | time-to-decision; agreement with the grade  |
| `ai_review.finished`       | inline + deferred reviewers   | reviewer health — the silent-failure rate   |
| `ai_review.decided`        | both decision paths           | feedback by assessment and reviewer version |
| `npm_connection.validated` | npm connection validation     | onboarding funnel                           |
| `public_diff.viewed`       | `loadRequestedDiff`           | growth-loop traffic, cache hit rate         |
| `user.signed_up`           | Better Auth user-create hook  | acquisition — the funnel's numerator        |
| `organization.created`     | `POST /api/v1/organizations`  | teams, excluding lazy personal workspaces   |
| `integration.connected`    | npm / GitHub / Slack connect  | activation, by integration kind             |
| `workflow_gate.opened`     | `deployment_protection_rule`  | gate volume                                 |
| `workflow_gate.reviewed`   | gate runner                   | recommendation mix; review latency          |
| `workflow_gate.decided`    | human route + auto-block path | approval rate, human vs automatic           |

`scan.failed` fires only on a terminal failure, so a scan that succeeds on retry
is not filed as a failure. Both the npm queue path and the workflow-gate runner
emit it — counting completions from every ecosystem while counting failures from
only one would bias the derived failure rate low for exactly the ecosystems that
release solely through a gate.

`public_diff.viewed` fires for the version-pair request only. `/file` funnels
through the same loader and is called once per file the visitor opens, so
counting it would report one page view as thirty and skew the cache column
toward `hit` (only the first request of a session can miss).

`ai_review.finished` is the highest-value counter here. A review that returns
`invalid`/`unavailable` is handled safely — `computeScanRisk` floors the scan at
medium and `displayedAiResult` refuses to render it as "low risk / nothing
unusual" — but it is otherwise completely silent. Counting the status makes the
reviewer's failure rate a number instead of a thing nobody sees.

Its dimensions also include model and reviewer version; doubles carry duration,
finding count, steps, input/cache/output/total tokens, in that order. Null
provider usage is written as zero, so distinguish "not reported" only through
the status/model context rather than treating zero as a measured free
invocation.

`ai_review.decided` joins a later maintainer action to the already-persisted AI
review without retaining a scan id or package data. Disabled-review placeholders
emit no feedback event. Its dimensions are decision, status, release assessment,
model, and reviewer version. See
[`ai-review-eval.md`](./ai-review-eval.md) for promotion and adjudication rules.

## Reading the data

Analytics Engine is queried through the Cloudflare SQL API:

```sh
curl "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -d "SELECT blob2 AS event, count() AS n
      FROM drydock_product_events
      WHERE timestamp > now() - INTERVAL '7' DAY
      GROUP BY event ORDER BY n DESC"
```

Sampling: Analytics Engine samples under load and exposes `_sample_interval`.
Multiply by it (`SUM(_sample_interval)`) for counts, rather than using
`count()`, once volume is high enough for sampling to engage.

## Optional binding

The binding is optional everywhere. `recordProductEvent` returns immediately
when it is absent, and a write failure degrades to a `analytics.write_failed`
warn log — analytics is the least important thing happening in any request that
emits one. Local dev, the test suite, and self-hosted deployments that omit the
block in `docs/examples/wrangler.self-host.jsonc` behave exactly as they did before.
