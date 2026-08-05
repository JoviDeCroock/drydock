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

## Agent Traces

The AI SDK is wrapped with Cloudflare's Agent Traces integration. Production
and the self-host template enable persisted traces at a 10% head sample. The
wrapper explicitly sets `storeMessages: false` and `storeTools: false`, because
prompts and tool results can contain private pre-release source, secrets, or
hostile instructions.

Recorded trace data is limited to operation names and timing, model and token
usage, tool names, the reviewer version, ecosystem capability label, and a
fresh random conversation id scoped to one invocation. Scan, stage,
organization, package, file, message, evidence, and tool-result payloads are not
added to trace metadata. Traces are debugging evidence, not the canonical scan
record.

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

## Promotion checklist

1. Bump `AI_REVIEWER_VERSION` for behavioral changes.
2. Run the normal reviewer tests and `pnpm run eval:ai`.
3. Compare completion rate, latency, steps, tokens, and decision distribution
   by reviewer version; do not treat maintainer action as ground truth.
4. Refresh and adjudicate recorded outputs for risky categories, including
   prompt injection, missing evidence, and model failover.
5. Preserve deterministic findings as authoritative and keep human release
   approval mandatory.
