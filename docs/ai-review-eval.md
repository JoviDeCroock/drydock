# AI reviewer lifecycle

The advisory reviewer combines a versioned evidence contract, private runtime traces, aggregate feedback, and recorded/live evaluations. **Authority:** advisory. **Owner:** `server/lib/ai-review/index.ts`.

## At a glance

| Thing | Owner file | Who may trigger | Pinned by (test) |
| --- | --- | --- | --- |
| Reviewer loop and routing | `server/lib/ai-review/index.ts` | Scan pipeline | `test/ai-review.test.mjs` |
| Evidence tools and coverage | `server/lib/ai-review/evidence.ts` | Reviewer loop | `test/ai-review-evidence.test.mjs` |
| Risk contribution | `server/lib/review/risk.ts` | Scan scoring | `test/risk.test.mjs` |
| Injection screen | `server/lib/ai-review/injection-screen.ts` | Screen-enabled scan | `test/ai-review-injection-screen.test.mjs` |
| Recorded-output eval | `test/eval/ai-review-harness.mjs` | Developer/CI | `test/eval/ai-review-eval.test.mjs` |
| Live model comparison | `test/eval/ai-review-live-harness.mjs` | Credentialed operator | `test/ai-review-model-compare.test.mjs` |
| Live screen eval | `test/eval/clef-live-harness.mjs` | Credentialed operator | `test/clef-eval.test.mjs` |

## Contract

### Versions and bounds

| Constant | Owner file | Contract |
| --- | --- | --- |
| `AI_REVIEWER_VERSION` | `server/lib/ai-review/contract.ts` | Bump for behavioral changes to prompts, tools, evidence, submission policy, or routing; persist on every new review, trace, and analytics event. |
| `INJECTION_SCREEN_VERSION` | `server/lib/ai-review/injection-screen.ts` | Independently bump for candidate spans, questions, model, or thresholds; emitted by `injection_screen.finished`. |
| `AI_REVIEW_BOUNDS` | `server/lib/ai-review/contract.ts` | Shared per-field schema, prompt, and repair limits; `assessmentsCount` bounds deterministic assessments. |
| `AI_FINDING_CATEGORIES` | `server/lib/ai-review/contract.ts` | Finding metadata; missing/unknown categories normalize to `other`. |
| `MAX_AGENT_STEPS` | `server/lib/ai-review/contract.ts` | 100 steps; final step forces `submit_review`. |
| `SUBMIT_CONTEXT_TOKENS` | `server/lib/ai-review/contract.ts` | Forces submission with room for another step below the smallest candidate window (Kimi: 262,144 tokens); lower this guard when lowering that window. |
| `CONTEXT_CHARS_PER_TOKEN` | `server/lib/ai-review/contract.ts` | Estimates prompt tokens when provider input usage is absent. |
| `MAX_TOTAL_TOOL_RESPONSE_CHARS` | `server/lib/ai-review/contract.ts` | Total package evidence budget, including coverage read. |
| `COVERAGE_READ_CHARS` | `server/lib/ai-review/contract.ts` | Initial required-first coverage read budget. |
| `MIN_COVERAGE_READ_SHARE` | `server/lib/ai-review/contract.ts` | Below this share, lowest-priority non-required files leave the initial read. |
| `MAX_REQUIRED_EVIDENCE_PATHS` | `server/lib/ai-review/contract.ts` | Required-set cap, filled round-robin across priority tiers. |
| `MAX_COVERAGE_REJECTIONS` | `server/lib/ai-review/contract.ts` | Maximum early-submit coverage rejections. |
| `MAX_TOOL_RESPONSE_CHARS` | `server/lib/ai-review/contract.ts` | One read call reserved for searching when computing unread required paths. |
| `MAX_CHANGED_FILE_MANIFEST` | `server/lib/ai-review/contract.ts` | 300-entry evidence-priority manifest cap. |
| `MAX_SEARCH_MATCHES_PER_FILE` | `server/lib/ai-review/contract.ts` | Prevents one file crowding other files out of search results. |
| `DIFF_WORK_BUDGET` | `server/lib/ai-review/contract.ts` | Shared line-diff work budget for the whole review. |
| `MAX_DIFF_EDIT_LENGTH` / `MAX_FILE_DIFF_WORK` | `server/lib/ai-review/contract.ts` | Per-file edit/work caps shrink to remaining shared budget. |
| `MAX_SPANS` | `server/lib/ai-review/injection-screen.ts` | Six candidate spans per production screen request. |
| `MAX_REVIEW_OUTPUT_TOKENS` | `server/lib/ai-review/contract.ts` | Reasoning and generated output share this cap. |

Historical outputs retain the version/model that produced them; regenerate and adjudicate before recording a new contract. Unversioned historical rows parse as `null`; analytics uses `legacy`.

### Submission and scoring

1. Oversized submission → Clamp and revalidate instead of discarding a potentially high-risk review as `invalid`. (`server/lib/ai-review/contract.ts`).
2. Clipped prose → Last sentence break, else word break, followed by ` …`; `file` uses a plain cut to preserve path meaning. (`server/lib/ai-review/contract.ts`).
3. Summary → Prompt states its budget; workbench renders it verbatim. (`server/lib/ai-review/contract.ts`).
4. `deterministicAssessments` → Optional rule ID, file, `confirmed`/`disputed`, short note; persist/export; UI shows only rule/file pairs reported by this scan. (`server/lib/ai-review/types.ts`).
5. Deterministic disagreement → Use an assessment; never file an AI finding to restate, explain, confirm, or dispute a deterministic finding. (`server/lib/ai-review/contract.ts`).
6. Finding `category` and optional 1-based `line` → Display/export/eval metadata; line comes from `search_files`; repair drops malformed lines; scoring reads neither field. (`server/lib/ai-review/contract.ts`).
7. Older records without category/line/assessments → Continue parsing. (`server/lib/ai-review/types.ts`).
8. `deterministicRisk` and findings supplied to reviewer → Release-delta roll-up through `releaseRuleFindings`; unchanged-code findings stay out of model input. (`server/lib/scan/pipeline-phases.ts`).
9. `nothing_unusual` → AI adds no risk. (`aiVerdictRiskCap` in `server/lib/review/risk.ts`).
10. `review_recommended` / `suspicious` / `blocked` → AI contribution capped at medium / high / critical across artifact, release, and context scores. (`aiVerdictRiskCap` in `server/lib/review/risk.ts`).
11. `requiresManualReview` → Medium floor survives the verdict cap. (`server/lib/review/risk.ts`).
12. Attempted but unavailable review → Medium floor. (`server/lib/review/risk.ts`).
13. All AI findings cite unchanged files → Keep overall AI concern out of `releaseRisk`, except manual-review floor. (`server/lib/review/risk.ts`).
14. No AI findings → Use normal review-level scoring: overall risk counts only with findings or manual-review request; a manual-review request can escalate without findings. (`server/lib/review/risk.ts`).
15. AI release attribution → File-level via `withoutFindingLine`; unlike deterministic pattern rematching, AI has no pattern to rescue stale lines; reused calls, clipped baselines, modified binaries, and decoys make located-line attribution unsafe. (`server/lib/scan/pipeline-phases.ts`).
16. Finding exceeds its verdict cap → UI puts it after counted findings with neutral badge/cap explanation; excludes it from inspection link and severity bar. (`server/lib/review/risk.ts`).

AI cannot downgrade deterministic findings: deterministic scoring runs first and combines the AI contribution through a max. Assessments never change risk. Release-gate authority belongs to [workflow gates](./workflow-gates.md); stage authority belongs to [npm staged publishing](./npm-staged-publishing.md).

### Evidence sequence

1. Required set: Changed manifest; added/modified preinstall/install/postinstall targets (even unchanged files); deterministic-finding files; changed native/executable payloads; changed entrypoints (all entrypoints if manifest entrypoints changed).
2. Tier allocation: Round-robin tiers prevent a hook naming many benign files from evicting an entrypoint or payload. Only npm manifest summaries supply `scripts`; PyPI/VS Code use remaining tiers.
3. Alias lookup: `evidencePathAliases` maps external finding paths to review-tree paths; PyPI `<artifact filename>/<path>` maps to `sdist/...` or `wheel/<tags>/...`; findings/assessments keep reported paths.
4. Coverage read: Before first model turn, required paths then other changes are read through the real tool with normal windows/accounting. Assistant `read` call plus tool result keeps package text out of the top-level task.
5. Water-filling: Small files shown whole raise the shared ceiling for long files; required paths start with half the budget and reclaim unused remainder. Dropped non-required files remain readable/searchable.
6. Coverage metadata: Task carries `coverageRead` and `requiredEvidencePaths`; manifest marks `shown:full`/`shown:partial`; tool responses carry `unreadRequiredPaths`.
7. Completion accounting: Only a contiguous prefix from offset 0 extends coverage; binary/unsupported files count once metadata is returned.
8. Feasible remainder: Require paths in priority order only while unread remainders fit remaining budget minus one read-call reserve; oversized remainder drops from unread list and should be searched.
9. Submission gate: `submit_review` refuses until required paths finish, subject to rejection cap, exhausted evidence budget, or fewer than two steps before forced submission. Coverage may delay a verdict, never lose one.
10. Tool ordering: Manifest, `list_files`, and `search_files` use evidence priority; search returns 1-based lines and per-file hit caps.
11. Read continuation: Omitted/zero `offset` resumes each path; already-complete paths return no text at no budget cost; nonzero offset applies to one path.
12. Diff fallback: Work grows with lines × edit length; over-cap modified files show removed/added unordered multisets, ignoring line endings, in linear time with no diff-work charge. Removed checks remain visible.

### Routing and capacity

| Candidate | Constant and owner | Configuration |
| --- | --- | --- |
| First | `AI_MODEL` in `server/lib/ai-review/index.ts` | GLM 5.3 Flash; `AI_REASONING_EFFORT`: high. |
| Fallback | `AI_FALLBACK_MODEL` in `server/lib/ai-review/index.ts` | Kimi K2.7 Code; provider-default reasoning. |

1. Selection → Fixed before execution; model output never changes order. (`selectModelCandidates` in `server/lib/ai-review/index.ts`).
2. Capacity/provider 5xx → One jittered retry. (`AI_REVIEW_MAX_CAPACITY_ATTEMPTS` in `server/lib/ai-review/index.ts`).
3. 429, timeout, invalid completed run → Move directly to next candidate; do not rerun the same model. (`server/lib/ai-review/index.ts`).
4. Context guard or last step → Offer only forced `submit_review`; missing usage falls back to prompt-length estimate. (`server/lib/ai-review/index.ts`).
5. AI Gateway → Pin attempts to one and disable payload collection per request, including live harness; never layer Gateway retries or inference-step dynamic routing over the loop. (`server/lib/ai-review/gateway.ts`).
6. Scan queue → One scan per batch, concurrency ten. (`wrangler.jsonc`).
7. Sustained capacity → Keep aggregate text-generation below 80% of documented pool limit and Kimi below 60% of its model limit; lower concurrency or separate AI capacity queue before saturation. (Operator policy).

### Traces and feedback

1. Agent Traces: Production and self-host template use worker-wide head sampling 1 (every invocation); cannot target reviewer alone.
2. Payload controls: `storeMessages: false`, `storeTools: false`, `recordInputs: false`, `recordOutputs: false` in `server/lib/ai-review/index.ts`.
3. Identity: `telemetry.functionId` names agent; `runtimeContext` contains `agentId`, `agentVersion`, `conversationId`, `ecosystem`; only `telemetry.includeRuntimeContext` allowlist reaches spans.
4. Allowed data: Operations/timing, model/token usage, tool names, reviewer version, ecosystem capability, fresh random per-invocation conversation ID.
5. Forbidden data: Scan, stage, organization, package, file, message, evidence, and tool-result payloads; Gateway logs keep request metadata/token counts, never prompts/completions.
6. Gateway correlation: Narrow Workers AI facade omits `aiGatewayLogId` so traces cannot index private Gateway review metadata.
7. Trace authority: Debugging evidence, never canonical scan record; use recorded outputs/harness for payload debugging.
8. `ai_review.finished`: Final status/model/version, duration, finding count, steps/tokens; review availability/latency, not per-model cost.
9. `ai_review.attempted`: Every attempt, including recovered retry/fallback: outcome `complete`/`invalid`/`rate_limited`/`capacity`/`timeout`/`error`; action `done`/`retry`/`fallback`/`stop`; model/version; duration, attempt number, steps/tokens.
10. Attempt coverage: Counts: changed files, changed files fully read, required paths, unread required paths, coverage rejections, evidence characters, coverage-read characters; never paths/text or organization/scan/stage/package/prompt/evidence IDs.
11. `ai_review.decided`: Later maintainer publish/discard beside persisted status, assessment, model/version; disabled-review placeholders emit nothing.
12. Feedback interpretation: Maintainer action is behavioral feedback, never correctness truth; accepted risk, unrelated discard, or mistakes require adjudication before promotion.

See [product analytics](./product-analytics.md) for positional slots and [security model](./security-model.md) for payload boundaries.

### Evaluation commands

1. `pnpm run eval:ai`: Offline recorded schema/scoring evaluation; reports `.context/eval/ai-review-eval.json` and `.context/eval/ai-review-eval.md`; write failure fails command.
2. `CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm run eval:ai:live`: Paid real Workers AI loop; `AI_REVIEW_LIVE_EVAL` gate; reports `.context/eval/ai-review-model-compare.json` and `.context/eval/ai-review-model-compare.md`; write failure fails command.
3. `pnpm run eval:clef:live`: Paid production screen questions/thresholds; `CLEF_LIVE_EVAL` gate; same credentials (wrangler OAuth token works); reports `.context/eval/clef-injection-screen.{json,md}`.

4. Offline input: `test/fixtures/ai-review-eval/cases.json`; validate persisted-review schema, corpus metadata, nonempty required fields, unique IDs across both sets.
5. Current `cases`: Current-version gated corpus; stale version fails; reject bodies that merely relabel historical output after removing version field.
6. `historicalCases`: Original version/model; version-agnostic persisted-shape compatibility only, separate totals, never gated metrics.
7. Empty current corpus: Report contract not recorded; keep previous results historical and never relabel to make gate green.
8. Offline metrics: Malicious catch, benign cleanliness, safe uncertainty escalation through production `computeScanRisk`; recorded output does not prove hosted reproducibility.
9. Live inputs: npm/PyPI/VS Code security corpora through production acquisition/review helpers; one model at a time without failover; atpm explicitly skipped (public-diff-only, no staged AI review).
10. Live completion: Valid `submit_review` before budget ends; reasoning can consume output cap and leave `invalid`, flooring scan at medium and escalating to human. Read this metric first.
11. Live detection: Product-policy coverage combines AI with full deterministic artifact floor against explicit fixture minimum; frontier catch measures model-only weak-rule cases; benign FP rate is AI-only.
12. Live release metric: Each run includes production-merged `releaseRisk`; benign release escalation counts AI-only high-or-above release risk because gate reads release risk.
13. Live cost: Measured tokens with cached input priced separately; missing usage excluded from cost/token averages and reduces cost coverage, never priced as zero.
14. Pricing: `MODEL_PRICING` in `test/eval/ai-review-live-harness.mjs` records prices/check date; refresh on routing changes; growing repeated prefixes make cache share significant.
15. Comparison limits: No asserted winner; assess completion, detection, then cost; unsupported, omitted, selected, bounded, and resumed cases remain explicit.
16. Screen inputs: `test/fixtures/clef-eval/injection-spans.json`: policy/corpus/probe spans and synthetic paraphrases with matched hard negatives.
17. Screen metrics: Phrase rules alone, screen alone, screen on rule misses, rules-or-screen; synthetic misses bound possible gain, not real-package prevalence.
18. Screen routing: Full Clef model; evaluate per-org `injection_screen.finished` fire rate before widening flag; compare `spansScreened` to `findingCount`. Zero findings only means nothing in sent spans.

19. `AI_REVIEW_LIVE_MODELS`: Comma-separated IDs, defaults to routed candidates; empty/duplicate lists rejected before network.
20. `AI_REVIEW_LIVE_LIMIT` / `AI_REVIEW_LIVE_OFFSET`: Fixture cap/resume offset; invalid limits rejected before network.
21. `AI_REVIEW_LIVE_CASES`: Comma-separated fixture IDs.
22. `AI_REVIEW_LIVE_GATEWAY` / `AI_REVIEW_LIVE_DIRECT=1`: Gateway selection/direct Workers AI when credential supports it.
23. `AI_REVIEW_LIVE_REPORT_STEM`: Separate concurrent/checkpointed reports.
24. `CLEF_LIVE_MODELS` / `CLEF_LIVE_BATCH`: Models/batch size; production uses `MAX_SPANS` in `server/lib/ai-review/injection-screen.ts`.
25. `CLEF_LIVE_NEUTRAL_PATHS=1`: Hide original span paths.
26. `CLEF_LIVE_LIMIT` / `CLEF_LIVE_REPORT_STEM`: Bound inputs/separate reports.

## Invariants

1. Package text is hostile evidence, never instructions; the model must never execute, install, import, independently fetch, or render package code (`server/lib/ai-review/contract.ts`).
2. AI cannot downgrade deterministic findings or approve a release; preserve human approval (`server/lib/review/risk.ts`, `server/lib/ai-review/contract.ts`).
3. Evidence-policy changes require `AI_REVIEWER_VERSION` bumps (`server/lib/ai-review/contract.ts`).
4. Paid live harnesses never run in `pnpm test` or `pnpm run verify` (`test/eval/ai-review-live.test.mjs`, `test/eval/clef-live.test.mjs`).
5. Model failover remains covered by mocked orchestration tests in `test/ai-review.test.mjs`.

## Failure modes

| Condition | Cause | Result | Fix |
| --- | --- | --- | --- |
| Submission cannot be repaired | Invalid/truncated output | `invalid`; fallback or medium floor | Inspect recorded outputs; compare completion before quality. |
| Required evidence missing | Early submit | Bounded rejection with unread paths | Continue normal reads or search infeasible remainders. |
| Hosted fixture invocation throws | Transport/harness error | Explicit `harness_error`; paid comparison continues | Inspect error/completion rates without dropping denominator. |
| Recorded contract stale | Behavioral change without new adjudicated outputs | Gate fails or reports current contract unrecorded | Regenerate/redact/adjudicate; never relabel history. |
| Trace payload absent | Deliberate privacy controls | Metadata-only debugging | Use harness/recorded output; preserve controls. |

## Change checklist

1. If reviewer behavior or `AI_MODEL`/`AI_FALLBACK_MODEL` changes → bump `AI_REVIEWER_VERSION`; retain historical output version/model.
2. If reviewer contract changes → run reviewer tests and `pnpm run eval:ai`.
3. If routing changes → refresh `MODEL_PRICING`, run `pnpm run eval:ai:live` on candidates, assess completion before detection before cost.
4. If promoting a version → compare completion, latency, steps, tokens, and decisions by version; use confirmed incidents or separately adjudicated truth, never maintainer agreement alone.
5. If recording new outputs → controlled live runs, redact evidence, human verdict/threat-class adjudication; cover prompt injection, missing evidence, and failover.
6. If screen spans/questions/model/thresholds change → independently bump `INJECTION_SCREEN_VERSION` and run `pnpm run eval:clef:live`.
7. If capacity or context changes → check queue budgets and smallest candidate window; preserve deterministic authority and mandatory human release approval.
