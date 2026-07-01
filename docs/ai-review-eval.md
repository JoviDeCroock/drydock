# AI reviewer eval harness

Drydock's AI reviewer (`server/lib/ai-review.ts`) is an advisory, agentic
Workers AI loop. It is default-off behind the `ai-review` flag and pinned to a
model order (`AI_MODEL` primary, `AI_FALLBACK_MODEL` secondary). When we want to
switch to a cheaper model — or add a new fallback — we need to _measure_ whether
it still catches what the current one does, rather than eyeballing a few scans.

This harness scores the AI reviewer on the labeled security corpus and compares
several models side by side (recall, benign false positives, error rate, agent
steps, tokens, latency, and optional $ cost). It is the AI-reviewer analogue of
the deterministic [detection eval](./detection-eval.md).

## What it measures — and what it doesn't

- It exercises the **real** reviewer code path. Each corpus case is turned into
  the exact `SelectiveAiReviewOptions` the scan pipeline builds
  (`deterministicFindings` + file/manifest diff over the fixture's staged and
  previous files), then run through `analyzeWithAi` with the model under test.
  Nothing mocks the reviewer contract, tools, or retry/fallback logic.
- It scores the **model's own verdict** — the `risk`/`releaseAssessment` the
  model reports — not the production risk roll-up (`computeScanRisk`). That is
  deliberate: the roll-up folds in the deterministic findings, which on this
  corpus are strong, and would mask the model's contribution. The eval isolates
  "would this model, on its own, flag the release?"
- Only **npm** cases are scored. The npm fixture payload maps 1:1 to the npm
  reviewer options; PyPI cases use a different artifact shape and are skipped.

It reuses the same corpus and labels as the detection eval (`cases/`,
`cases-frontier/`, `cases-benign/`; see
[security-detection-corpus.md](./security-detection-corpus.md)), so the two
evals never drift on what "malicious"/"benign" means.

## Running it

```sh
pnpm run eval:ai
```

Unlike `pnpm run eval`, this is **not** part of `pnpm test` or CI: it makes
live, paid, non-deterministic Workers AI calls. It lives in its own Vitest
config (`vitest.ai-eval.config.ts`) and is excluded from the default node
project. Without credentials the run skips cleanly, so an accidental invocation
never fails.

### Credentials

`createWorkersAI` runs in credentials mode, so the eval works from Node without
a Worker binding:

- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account id.
- `CLOUDFLARE_API_TOKEN` — an API token with Workers AI run permission
  (`WORKERS_AI_API_TOKEN` is also accepted).

By default requests route through the `drydock-gateway` AI Gateway (so runs show
up in gateway logs/cost analytics). Set `AI_EVAL_NO_GATEWAY=1` to bypass it or
`AI_EVAL_GATEWAY_ID=<id>` to use a different gateway.

### Configuration

All via environment variables:

| var | default | meaning |
| --- | --- | --- |
| `AI_EVAL_MODELS` | shipped candidates + a couple cheaper models | comma-separated model ids to compare |
| `AI_EVAL_GATEWAY_ID` | `drydock-gateway` | AI Gateway id to route through |
| `AI_EVAL_NO_GATEWAY` | unset | set to bypass the gateway |
| `AI_EVAL_PRICES` | `{}` | JSON `{ "<model>": { "input": usdPer1MInput, "output": usdPer1MOutput } }` for cost estimates |
| `AI_EVAL_CONCURRENCY` | `4` | per-model case concurrency |
| `AI_EVAL_LIMIT` | all | cap the number of cases (smoke runs) |

Example — compare the current primary against a cheaper model, with prices:

```sh
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
AI_EVAL_MODELS='@cf/moonshotai/kimi-k2.7-code,@cf/meta/llama-3.3-70b-instruct-fp8-fast' \
AI_EVAL_PRICES='{"@cf/meta/llama-3.3-70b-instruct-fp8-fast":{"input":0.29,"output":2.25}}' \
pnpm run eval:ai
```

Cost is only shown for models with a price entry; everything else prints `n/a`
rather than guessing. Token counts and latency are always reported and are the
model-agnostic proxy for "cheaper".

## Output

The report is written to `.context/eval/ai-review-eval.{md,json,tsv}`
(gitignored). The `.md` is the human summary, `.json` includes every per-case
result for debugging, and `.tsv` renders as a table in Slack.

## Metrics

Per model, over the npm corpus:

- **recall** — malicious cases the model's risk reaches the case's labeled
  `expectMinRisk`. The headline "does the cheaper model still catch the bad
  ones" number.
- **risky-recall** — malicious cases the model rolls up to `>= medium`. A
  looser, model-agnostic bar (useful when a model is consistently one notch
  less severe).
- **benign FP rate** — benign hard-negatives the model rolls up to `>= medium`.
  Precision cost of the model.
- **error rate** — cases that did not complete (`invalid`/`unavailable`,
  including model failures, which fail safe to `unavailable`).
- **avg steps / input tokens / output tokens / latency** — cost and speed.
- **est. cost** — from `AI_EVAL_PRICES`, or `n/a`.

Misses (uncaught malicious) and benign false positives are listed per model so a
regression is diagnosable, not just a number.

## Extending

- Add cases the same way as the detection eval — new corpus fixtures under
  `test/fixtures/security-corpus/` are picked up automatically.
- The harness (`test/eval/ai-review-harness.mjs`) is pure except for
  `evaluateModel`; `summarize`/rendering/`estimateCost` are unit-tested with
  mock reviewer output in `test/eval/ai-review-harness.test.mjs`.
