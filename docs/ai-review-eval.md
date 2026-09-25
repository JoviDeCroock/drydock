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

The optional `deterministicAssessments` list (at most
`AI_REVIEW_BOUNDS.assessmentsCount` entries of rule id, file, `confirmed` or
`disputed`, and a short note) is where the reviewer agrees or disagrees with a
deterministic finding. The prompt forbids filing an AI finding to restate,
explain, or dispute one: before 1.8.0 the only way to discuss a rule finding was
a high AI finding, which scored as an escalation even when its text called the
rule a false positive. Assessments are persisted with the review and carried in
the report export; the scan's AI assessment section renders only those naming a
rule id and file this scan actually reported. Risk scoring never reads them.

## Risk contribution

`server/lib/review/risk.ts` owns how a completed review moves scores. The
deterministic score is computed first and the AI's contribution is combined with
it through a max, so every bound below limits the AI's upgrade and none can
lower a deterministic grade.

- **Verdict cap.** The review's overall risk and its findings' severities are
  capped by its own `releaseAssessment`: `nothing_unusual` adds nothing,
  `review_recommended` at most medium, `suspicious` at most high, `blocked` up
  to critical. `requiresManualReview` keeps its medium floor, and an attempted
  but unavailable review still floors at medium. The cap applies to
  `artifactRisk`, `releaseRisk`, and the AI share of `contextRisk`. The scan
  page reads the same cap (`aiVerdictRiskCap`): an AI finding above what its
  verdict allows is listed after the counted findings with a neutral badge and
  a line saying what the verdict holds it to, and it neither drives the
  "Inspect … findings" link nor fills the severity bar.
- **Release attribution.** `releaseRisk` gets the same verdict-bounded
  contribution, from the review's overall risk and its release-delta findings.
  A review whose findings all cite unchanged files stays out of `releaseRisk`
  (manual-review floor aside); a review with no findings is scored wholesale,
  because a reviewer told not to restate deterministic findings may escalate
  with none of its own. Attribution is file-level even when a finding records
  a line (`withoutFindingLine`): a rule finding's stale line is rescued by
  re-matching its pattern, but an AI finding has none, so a decoy on an
  unchanged line (the first search match) would otherwise pull a newly added
  call out of the release. Requiring a located line was tried and dropped: a
  reused call shape, a clipped baseline, or a modified binary cannot produce
  one, so it turned real AI-only detections into gate approvals.

Each finding carries an optional `category` (`AI_FINDING_CATEGORIES`, named
after the rule families; a missing or unknown value normalizes to `other`) and
an optional 1-based `line` the prompt tells the model to copy from a
`search_files` match. Both are display, export, and eval metadata that scoring
never reads; the repair clamp drops a malformed line rather than failing the
submission. Reviews recorded before 1.8.0 have neither and parse unchanged.
The reviewer's `deterministicRisk` input is the release-delta roll-up: the
pipeline hands it `releaseRuleFindings`, so findings on unchanged code never
reach the model.

## Evidence coverage

The loop does not rely on the model volunteering reads. `buildEvidenceIndex`
computes a priority-ordered required-evidence set: a changed manifest, targets
of consumer-install lifecycle entries (preinstall/install/postinstall) this
release added or modified (even when the target file itself is unchanged), files
with deterministic findings, changed native or executable payloads, and changed
entrypoints (or all entrypoints when the manifest's entrypoints changed). The
set is capped at `MAX_REQUIRED_EVIDENCE_PATHS` so two batched read calls cover
it, and the cap is filled round-robin across those tiers so a hostile lifecycle
hook naming many benign files cannot evict the changed entrypoint or payload.
Only npm's manifest summary carries `scripts`; PyPI and VS Code releases get
the same gate from the remaining tiers. The set ships as `requiredEvidencePaths` in the
task and every tool response reports `unreadRequiredPaths`.

`submit_review` refuses a submission while required paths remain unread, with
three release valves so the gate can only delay a verdict, never lose one: it
stops refusing after `MAX_COVERAGE_REJECTIONS`, once the shared evidence budget
is exhausted, and when fewer than two steps remain before the forced final
submit. A path counts as read from its head (offset 0, whatever came back, so a binary
payload or an empty post-budget read satisfies it) or when a continuation
returned text; `offset` is only accepted with a single path, so a batch cannot
satisfy the gate with empty windows.

The changed-file manifest, `list_files`, and `search_files` all walk paths in
evidence-priority order rather than alphabetically, so the 300-entry manifest
cap on a large dist rebuild drops chunks rather than the lifecycle script, and
a docs file with many hits cannot crowd the script out of a search result
(`MAX_SEARCH_MATCHES_PER_FILE` also caps hits per file). Search matches carry a
1-based `line`, and `read` accepts `offset` and returns `nextOffset` so the
model can walk a file longer than one call's share instead of only ever seeing
its head. Any change to this contract bumps `AI_REVIEWER_VERSION`.

## Agent Traces

The AI SDK is wrapped with Cloudflare's Agent Traces integration. Production
and the self-host template enable persisted traces at a head sample of 1 (every
invocation); head sampling is worker-wide and cannot be aimed at the reviewer,
and at 10% the few daily agent turns rarely reached the Agents dashboard. The
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

The test reads `test/fixtures/ai-review-eval/cases.json` and validates every
result through the real persisted-review schema and scores malicious catch
behavior, benign cleanliness, and safe uncertainty escalation through the
production `computeScanRisk` roll-up. Records under `cases` are the gated
current-version corpus: a stale `reviewerVersion` fails the gate. Records under
`historicalCases` retain their original version and are scored only as a
version-agnostic persisted-shape compatibility set. Corpus metadata, non-empty
required fields, and unique case ids across both sets are validated before
metrics are computed. The report keeps the two totals separate so historical
output cannot be mistaken for current reviewer coverage. The gate also compares
current and historical review bodies without their version field and rejects a
current record that merely relabels an old output. The current-version gate may
be empty immediately after a prompt or routing contract changes. In that state
the report says the current contract is not recorded, and the previous outputs
remain historical compatibility evidence; they must not be relabeled to make
the gate green. Reports are written to `.context/eval/ai-review-eval.json` and
`.context/eval/ai-review-eval.md`; a write failure fails the command.

Recorded outputs prove the scoring contract and guard outputs from the contract
that produced them; they do not prove the hosted model will reproduce them.
Historical records never contribute to the gated result. Before promoting a new
model or reviewer version, refresh the gated corpus from
controlled live runs, redact evidence, have a human assign the verdict and
threat class, then compare the new version by category. Keep model failover's
runtime behavior covered by the mocked orchestration tests in
`test/ai-review.test.mjs` as well.

## Live model comparison

The offline eval cannot rank hosted models, so model routing has its own
harness. Run:

```sh
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm run eval:ai:live
```

It drives the real `analyzeWithAi` agent loop against real Workers AI models
over the npm, PyPI, and VS Code security corpora, one model at a time (no
failover, or the comparison would measure the wrong model). Each ecosystem case
is built through its production acquisition/review helpers. atpm remains an
explicit skip because it is public-diff-only and does not run staged AI review.
It is paid and network-bound, so it is gated behind `AI_REVIEW_LIVE_EVAL` and
never runs in `pnpm test` or `pnpm run verify`. Reports land in
`.context/eval/ai-review-model-compare.json` and
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
   Each run also carries `releaseRisk`, scored through the production merge and
   roll-up, and the model summary reports a benign release escalation rate
   (benign fixtures the AI alone pushed to high or above), because the workflow
   gate reads release risk, not the artifact headline.
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
