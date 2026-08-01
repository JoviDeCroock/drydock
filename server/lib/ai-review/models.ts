// Reviewer model identifiers, kept in their own dependency-free module.
//
// `ai-review/index.ts` pulls in the Vercel AI SDK and workers-ai-provider, which
// is why every caller loads it lazily. Callers that only need to *name* the
// model — the deferred-review fail-safe, which records "a reviewer was supposed
// to run" — would otherwise drag that whole graph into a cron isolate to read a
// string constant.

// Reviewer model order: prefer the strongest affordable model, then fail over.
//
// Both candidates must survive this loop's shape, not just answer a prompt: up
// to MAX_AGENT_STEPS re-sends of a prefix that grows to the evidence cap. That
// makes the cached-input price, not the headline input price, the cost driver,
// and it makes the context window a floor rather than a feature — evidence is
// capped at MAX_TOTAL_TOOL_RESPONSE_CHARS, so anything past ~64k is unusable
// spend. The fallback is deliberately an agentic model with a deep cache
// discount rather than the cheapest listing: a failover that cannot finish the
// loop returns `invalid`, which floors the scan at medium and escalates to
// manual review, so a "cheap" model that misses the submission costs more than
// it saves. Re-check both against docs/ai-review-eval.md's live comparison
// before changing either; changing them is a routing change, so bump
// AI_REVIEWER_VERSION with it.
export const AI_MODEL = "@cf/moonshotai/kimi-k2.7-code";
export const AI_FALLBACK_MODEL = "@cf/deepseek-ai/deepseek-v4-flash-0731";
export const AI_MODEL_CANDIDATES = [AI_MODEL, AI_FALLBACK_MODEL] as const;
