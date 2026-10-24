/** The AI Gateway every Workers AI call Drydock makes is routed through. */
export const AI_GATEWAY_ID = "drydock-gateway";

/**
 * Per-request Gateway policy every caller sends, so it holds in code whatever
 * the gateway's dashboard settings say.
 *
 * - One Gateway attempt: account-level retries would be invisible to
 *   per-attempt usage accounting, so retry and fallback stay with the caller.
 * - No payload logging: prompts carry changed files of releases that may not
 *   be public yet, including embargoed security fixes. Metadata (model, token
 *   counts, status, the `cf-aig-metadata` ids) is still logged.
 */
export const AI_GATEWAY_POLICY_HEADERS = {
  "cf-aig-max-attempts": "1",
  "cf-aig-collect-log-payload": "false",
} as const;
