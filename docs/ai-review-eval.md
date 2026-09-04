# AI reviewer lifecycle

The advisory reviewer has a small, versioned improvement loop: sampled runtime
traces explain how it executed, aggregate product events show cost and eventual
maintainer action, and a truth-labeled recorded-output corpus gates known safety
behaviors before the reviewer contract changes.

## Version contract

`AI_REVIEWER_VERSION` in `server/lib/ai-review/contract.ts` identifies the
prompt, evidence tools, model routing, and response contract as one unit. Every
new review persists that version and includes it in traces and analytics. Bump
it whenever a change can alter reviewer behavior. Historical recorded outputs
keep the version and model that actually produced them; regenerate and
adjudicate the corpus before marking a new contract as recorded. Historical
rows without a version parse as `null` and analytics labels them `legacy`.

## Submission bounds

`AI_REVIEW_BOUNDS` in the same file is the single source of the per-field length
limits, shared by the submission schema, the system prompt's stated budget, and
`clampAiReviewSubmission`. A submission that overshoots is clamped and
re-validated rather than discarded, because rejecting the whole call would
collapse a high-risk review into the low-risk `invalid` fallback.

Clamping prose is maintainer-visible: the summary is rendered verbatim in the
scan workbench, so a hard mid-word cut reads as the reviewer crashing. Prose
fields are cut on the last sentence break inside the budget, else the last word
break, and always end in a ` …` marker; only `file` keeps a plain cut, since a
trailing ellipsis on a path reads as part of the filename. The prompt states
the summary budget so the model finishes its verdict inside it instead of
relying on the clamp.

## Agent Traces

The AI SDK is wrapped with Cloudflare's Agent Traces integration. Production
and the self-host template enable persisted traces at a 10% head sample. The
wrapper explicitly sets `storeMessages: false` and `storeTools: false`, and the
call sets `recordInputs: false` and `recordOutputs: false`, because prompts and
tool results can contain private pre-release source, secrets, or hostile
instructions.

Trace identity follows the AI SDK v7 shape: `telemetry.functionId` names the
agent, and `agentId`, `agentVersion`, `conversationId`, and `ecosystem` travel
in the call's `runtimeContext`, each opted onto the span through
`telemetry.includeRuntimeContext`. v7 removed `telemetry.metadata`; runtime
context is an application-data channel, so anything not named there stays off
the span.

Recorded trace data is limited to operation names and timing, model and token
usage, tool names, the reviewer version, ecosystem capability label, and a
fresh random conversation id scoped to one invocation. The reviewer gives the
provider a narrow Workers AI binding facade that omits `aiGatewayLogId`, so the
trace cannot become an index into Gateway records carrying private review
metadata. Scan, stage, organization, package, file, message, evidence, and
tool-result payloads are not added to trace metadata. Traces are debugging
evidence, not the canonical scan record.

## Aggregate execution and decision feedback

`ai_review.finished` records status, final model, reviewer version, duration,
finding count, steps, and token counts in Analytics Engine. It answers
review-level availability and latency without storing package evidence.

`ai_review.attempted` records every model-level agent attempt, including attempts
that are recovered by a retry or fallback. Its dimensions are outcome
(`complete`, `invalid`, `rate_limited`, `capacity`, `timeout`, or `error`), next
action (`done`, `retry`, `fallback`, or `stop`), model, and reviewer version;
doubles carry duration, attempt number, steps, and token counts. It deliberately
has no organization, scan, stage, package, prompt, or evidence identifier. Use
this event for model cost, throttling, and failover analysis: attributing all
tokens in `ai_review.finished` to its final model would miss an invalid model's
already-spent budget.

When a maintainer later publishes or discards a reviewed release,
`ai_review.decided` records that action beside the persisted review's status,
assessment, model, and reviewer version. This is behavioral feedback, **not a
correctness label**: a maintainer may accept known risk, discard for unrelated
reasons, or make a mistake. Promotion decisions need confirmed incident labels
or a separately adjudicated corpus, not raw agreement rates.
Disabled-review placeholders do not emit this event because no reviewer attempt
occurred.

## Model routing and capacity

Routing is fixed before a model runs: every release uses GLM 5.3 Flash first,
with `reasoning_effort: "high"`. Kimi K2.7 Code remains the fallback when GLM
is unavailable, times out, exhausts the step budget, or submits an invalid
review. Kimi keeps its provider-default reasoning configuration. Model output
never changes this order.

The agent is capped at 20 steps. A capacity/5xx failure gets one jittered retry;
a 429 or timeout moves directly to the next model because a sub-second retry
cannot escape a minute quota. An invalid completed run also moves to the next
model without re-running the same model. Do not add AI Gateway retries on top of
this loop: each request pins Gateway attempts to one so account-level retry
settings cannot multiply requests invisibly. Dynamic routing at individual
inference-step granularity can also mix models inside one review.

Cloudflare's queue consumer already limits scan concurrency to ten and processes
one scan per batch, smoothing ordinary bursts. Track the aggregate text-generation
pool below 80% of its documented limit and Kimi below 60% of its model-specific
limit; lower queue concurrency or split AI review into a dedicated capacity
queue before those budgets become sustained constraints.

## Offline eval

Run:

```sh
pnpm run eval:ai
```

The test reads `test/fixtures/ai-review-eval/cases.json`, validates every result
through the real persisted-review schema, requires every result to match the
corpus's explicit recorded reviewer version, and scores malicious catch
behavior, benign cleanliness, and safe uncertainty escalation through the
production `computeScanRisk` roll-up. Corpus metadata, non-empty required fields,
and unique case ids are validated before metrics are computed; the gate also
holds minimum verdict/scenario coverage. The report shows the historical version
beside the current runtime version so an old output can never be relabeled as
evidence from a new model or routing contract, and says explicitly whether the
current contract has recorded coverage. The baseline includes
prompt-injection-shaped hostile evidence, unavailable evidence, and a fallback
model result. Reports are written to `.context/eval/ai-review-eval.json` and
`.context/eval/ai-review-eval.md`; a write failure fails the command.

These are historical recorded outputs, so a green run proves the scoring
contract and guards known outputs; it does not prove the current hosted model
will reproduce them. Before treating the corpus as evidence for a new model or
reviewer version, refresh it from controlled live runs, redact evidence, have a
human assign the verdict and threat class, then update its recorded provenance
and compare the new version by category. Keep model failover's runtime behavior
covered by the mocked orchestration tests in `test/ai-review.test.mjs` as well.

## Live model comparison

The offline eval cannot rank hosted models, so model routing has its own
harness. Run:

```sh
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm run eval:ai:live
```

It drives the real `analyzeWithAi` agent loop against real Workers AI models
over the npm, PyPI, and VS Code security corpora, one model at a time (no
failover, or the comparison would measure the wrong model). Each ecosystem case
is built through its production acquisition/review helpers and projects the
same per-side capability delta production sends in the initial reviewer
payload. atpm remains an explicit skip because it is public-diff-only and does
not run staged AI review. It is paid and network-bound, so it is gated behind
`AI_REVIEW_LIVE_EVAL` and never runs in `pnpm test` or `pnpm run verify`.
Reports land in `.context/eval/ai-review-model-compare.json` and
`.context/eval/ai-review-model-compare.md`; a write failure fails the command.

Environment: `AI_REVIEW_LIVE_MODELS` (comma-separated ids, defaults to the two
routed models), `AI_REVIEW_LIVE_LIMIT` (cap fixtures while iterating),
`AI_REVIEW_LIVE_OFFSET` (resume after completed fixtures),
`AI_REVIEW_LIVE_CASES` (comma-separated fixture ids),
`AI_REVIEW_LIVE_GATEWAY`, `AI_REVIEW_LIVE_DIRECT=1` (bypass Gateway when a
credential can call Workers AI directly), and `AI_REVIEW_LIVE_REPORT_STEM`
(isolate reports from concurrent or checkpointed runs). Reports state bounded,
selected, and resumed coverage explicitly.

The harness rejects empty/duplicate model lists and invalid limits before any
network call. A thrown fixture invocation becomes an explicit `harness_error`
run and the comparison continues, preserving the rest of a paid run while
keeping completion and error rates honest.

It reports three things, in priority order:

1. **Completion rate.** How often the model lands a valid `submit_review`
   before the step budget ends. Every candidate on the Workers AI catalog is a
   reasoning model, and reasoning tokens bill against `MAX_REVIEW_OUTPUT_TOKENS`
   — a model can spend the whole budget thinking and never submit. That returns
   `invalid`, which floors the scan at medium and escalates the release to a
   human. A model that scores well on the cases it finishes but often fails to
   finish is worse for the product than a duller model that always submits.
2. **Detection quality.** Product-policy coverage combines the AI result with
   the fixture's full deterministic artifact-risk floor and compares it with
   that fixture's explicit minimum risk. Frontier AI catch separately measures
   model-only detection where deterministic coverage is deliberately weak.
   Benign false-positive rate remains AI-only, so deterministic package context
   cannot make a clean model response look noisy.
3. **Cost.** Measured tokens priced per model, with cached input billed
   separately. The loop re-sends a prefix that grows to the evidence cap, up to
   `MAX_AGENT_STEPS` times, so cached-input share dominates the bill: a model
   with no published cache tier re-bills the whole prefix every step and can
   cost more than one with double its list price. `MODEL_PRICING` in
   `test/eval/ai-review-live-harness.mjs` carries the list prices and the date
   they were checked — refresh it with any routing change, because a stale table
   silently reorders the comparison. Runs without provider usage are excluded
   from token and cost averages and reduce the reported cost coverage instead of
   being priced as zero-cost calls.

The harness deliberately asserts no winner: picking a model is a judgement call
across all three axes. Unsupported ecosystems and fixtures omitted by `--limit`
remain explicit in the report rather than disappearing from its denominator.

Context window is not a selection criterion. Evidence is capped at
`MAX_TOTAL_TOOL_RESPONSE_CHARS`, so any window past that is spend on capacity
the reviewer refuses to use; treat it as a floor to clear, not a feature to buy.

## Promotion checklist

1. Bump `AI_REVIEWER_VERSION` for behavioral changes. Model routing is part of
   that contract: changing `AI_MODEL` or `AI_FALLBACK_MODEL` is a version bump,
   but historical outputs must keep their original version and model until they
   are regenerated under the new contract.
2. Run the normal reviewer tests and `pnpm run eval:ai`.
3. For a routing change, run `pnpm run eval:ai:live` over the candidate set and
   read completion rate before detection quality before cost. Refresh
   `MODEL_PRICING` first.
4. Compare completion rate, latency, steps, tokens, and decision distribution
   by reviewer version; do not treat maintainer action as ground truth.
5. Refresh and adjudicate recorded outputs for risky categories, including
   prompt injection, missing evidence, and model failover.
6. Preserve deterministic findings as authoritative and keep human release
   approval mandatory.
