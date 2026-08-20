# AI reviewer lifecycle

The advisory reviewer has a small, versioned improvement loop: sampled runtime
traces explain how it executed, aggregate product events show cost and eventual
maintainer action, and a truth-labeled recorded-output corpus gates known safety
behaviors before the reviewer contract changes.

## Version contract

`AI_REVIEWER_VERSION` in `server/lib/ai-review/contract.ts` identifies the
prompt, evidence tools, model routing, and response contract as one unit. Every
new review persists that version and includes it in traces and analytics. Bump
it whenever a change can alter reviewer behavior; copy or regenerate the eval
records for the new version in the same change. Historical rows parse with a
`null` version and analytics labels them `legacy`.

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
wrapper explicitly sets `storeMessages: false` and `storeTools: false`, because
prompts and tool results can contain private pre-release source, secrets, or
hostile instructions.

Recorded trace data is limited to operation names and timing, model and token
usage, tool names, the reviewer version, ecosystem capability label, and a
fresh random conversation id scoped to one invocation. The reviewer gives the
provider a narrow Workers AI binding facade that omits `aiGatewayLogId`, so the
trace cannot become an index into Gateway records carrying private review
metadata. Scan, stage, organization, package, file, message, evidence, and
tool-result payloads are not added to trace metadata. Traces are debugging
evidence, not the canonical scan record.

## Aggregate execution and decision feedback

`ai_review.finished` records status, model, reviewer version, duration, finding
count, steps, and token counts in Analytics Engine. It answers availability,
latency, model-routing, and cost questions without storing package evidence.

When a maintainer later publishes or discards a reviewed release,
`ai_review.decided` records that action beside the persisted review's status,
assessment, model, and reviewer version. This is behavioral feedback, **not a
correctness label**: a maintainer may accept known risk, discard for unrelated
reasons, or make a mistake. Promotion decisions need confirmed incident labels
or a separately adjudicated corpus, not raw agreement rates.
Disabled-review placeholders do not emit this event because no reviewer attempt
occurred.

## Offline eval

Run:

```sh
pnpm run eval:ai
```

The test reads `test/fixtures/ai-review-eval/cases.json`, validates every result
through the real persisted-review schema, requires the current reviewer
version, and scores malicious catch behavior, benign cleanliness, and safe
uncertainty escalation. The baseline includes prompt-injection-shaped hostile
evidence, unavailable evidence, and a fallback-model result. Reports are
written best-effort to `.context/eval/ai-review-eval.json` and
`.context/eval/ai-review-eval.md`.

These are recorded outputs, so a green run proves the scoring contract and
guards known outputs; it does not prove the current hosted model will reproduce
them. Before promoting a new model or reviewer version, refresh the corpus from
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
over the npm security corpus, one model at a time (no failover, or the
comparison would measure the wrong model). It is paid and network-bound, so it
is gated behind `AI_REVIEW_LIVE_EVAL` and never runs in `pnpm test` or
`pnpm run verify`. Reports land in `.context/eval/ai-review-model-compare.json`
and `.context/eval/ai-review-model-compare.md`.

Environment: `AI_REVIEW_LIVE_MODELS` (comma-separated ids, defaults to the two
routed models), `AI_REVIEW_LIVE_LIMIT` (cap fixtures while iterating; the report
states how many were dropped), `AI_REVIEW_LIVE_GATEWAY`.

It reports three things, in priority order:

1. **Completion rate.** How often the model lands a valid `submit_review`
   before the step budget ends. Every candidate on the Workers AI catalog is a
   reasoning model, and reasoning tokens bill against `MAX_REVIEW_OUTPUT_TOKENS`
   — a model can spend the whole budget thinking and never submit. That returns
   `invalid`, which floors the scan at medium and escalates the release to a
   human. A model that scores well on the cases it finishes but often fails to
   finish is worse for the product than a duller model that always submits.
2. **Detection quality.** Catch rate on malicious fixtures and false-positive
   rate on benign hard-negatives, scored with the same predicates the recorded
   eval uses so the two reports mean the same thing.
3. **Cost.** Measured tokens priced per model, with cached input billed
   separately. The loop re-sends a prefix that grows to the evidence cap, up to
   `MAX_AGENT_STEPS` times, so cached-input share dominates the bill: a model
   with no published cache tier re-bills the whole prefix every step and can
   cost more than one with double its list price. `MODEL_PRICING` in
   `test/eval/ai-review-live-harness.mjs` carries the list prices and the date
   they were checked — refresh it with any routing change, because a stale table
   silently reorders the comparison.

Two things the harness deliberately does not do. It asserts no winner: picking a
model is a judgement call across all three axes. And it covers npm-shaped
fixtures only: today that is 46 fixtures (33 malicious, 13 benign). The 14 PyPI
fixtures carry adapter-shaped inputs and appear in the report's `skipped` list
rather than being dropped silently; VS Code fixtures are not loaded by the
detection corpus loader at all, so covering VSIX means extending `loadCorpus`
first.

Context window is not a selection criterion. Evidence is capped at
`MAX_TOTAL_TOOL_RESPONSE_CHARS`, so any window past that is spend on capacity
the reviewer refuses to use; treat it as a floor to clear, not a feature to buy.

## Promotion checklist

1. Bump `AI_REVIEWER_VERSION` for behavioral changes. Model routing is part of
   that contract: changing `AI_MODEL` or `AI_FALLBACK_MODEL` is a version bump,
   and the recorded eval records must be reissued at the new version in the
   same change.
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
