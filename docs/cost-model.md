# Cost model (napkin math)

Order-of-magnitude estimates for running Drydock on Cloudflare. Numbers are based on Cloudflare's published rates for the Workers Paid plan and assume a typical scan profile (≤250 files, ≤64 KB per file textSample). Treat this as a sanity check, not a quote.

> **AI review is Flagship-gated and off by default**. The Workers-AI lines below describe what scans cost for organizations where the per-organization `ai-review` flag is enabled; until then, the dominant per-scan cost is the sandbox + D1 path. The cost-model scenarios already reflect AI as the dominant variable cost for the paid-tier rollout.

## Per-scan cost components

A single scan exercises the deterministic pipeline (staged tarball download, previous-version tarball download, deterministic findings, persistence). When the organization's `ai-review` flag is enabled it adds the Workers-AI tokens line below.

| Component         | Approx per scan | Notes                                                                                                                                            |
| ----------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker requests   | ~5              | `POST /scans` + queue producer + queue consumer + 2 sandbox spins (staged + previous)                                                            |
| Worker CPU-ms     | ~3,000          | Dominated by tar parse + sha256 hashing in the sandbox                                                                                           |
| D1 row writes     | ~150            | one scans row + N scan_files + M scan_findings                                                                                                   |
| Workers AI tokens | flag-gated      | When AI review is enabled: compact manifest input plus bounded evidence-tool turns; static safety preamble prompt-cached via `AI_CACHE_AFFINITY` |
| KV write          | 1               | Previous-version parsed payload cached in `COMPARE_CACHE`                                                                                        |
| Queue operations  | 2               | Enqueue + consume                                                                                                                                |

## Per scan-detail view

Viewing a finished scan and re-diffing against alternate versions.

| Component           | Approx per view   | Notes                                                                                    |
| ------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| Worker requests     | 3–8               | `GET /scans/:id` + `/versions` + `/compare` + N × `/compare/file`                        |
| D1 reads            | ~5                | scan + files + findings + ownership checks                                               |
| KV reads            | 1–5               | One per `/compare` metadata fetch, one per file opened                                   |
| Sandbox invocations | 0 cached / 1 cold | After the first global viewer of `package@version`, all subsequent compares are KV reads |

The sandbox cost for re-diff is amortized across every viewer of the same `package@version` thanks to the KV cache added in [`compare-cache.ts`](../server/lib/compare-cache.ts).

## Scenario rollups

| Scale                        | Scans/mo | Detail views/mo | Workers + D1 + KV + Queues | Workers AI | **Total/mo** |
| ---------------------------- | -------- | --------------- | -------------------------- | ---------- | ------------ |
| Small team (~5 users)        | 200      | ~1,000          | ~$5 base                   | ~$5        | **~$10**     |
| Growth SaaS (~100 customers) | 5,000    | ~25,000         | ~$10                       | ~$95       | **~$105**    |
| Heavy use                    | 50,000   | ~250,000        | ~$15                       | ~$950      | **~$965**    |

Workers AI is ~90% of the variable cost at every scale above the smallest tier.

## Pricing inputs used

- **Workers Paid plan**: $5/mo base, 10M requests + 30M CPU-ms included, then $0.30/M req and $0.02/M CPU-ms.
- **D1**: 50M writes + 25B reads/mo included on the paid plan, $1/M writes and $0.001/1k reads beyond. Storage $0.75/GB-mo.
- **KV**: $0.50/M reads, $5/M writes, $0.50/GB-mo storage. ~5 MB per cached `package@version` entry.
- **Queues**: $0.40/M operations.
- **Workers AI (Kimi)**: `server/lib/ai-review.ts` still declares `AI_MODEL = "@cf/moonshotai/kimi-k2.5"`, but Cloudflare scheduled Kimi K2.5 requests to auto-alias to Kimi K2.6 on May 30, 2026. Treat K2.6 pricing ($0.95/M input + $0.16/M cached input + $4.00/M output) as the effective current margin model until the constant is migrated; K2.5's listed legacy price was $0.60/M input + $0.10/M cached input + $3.00/M output. Confirm against current Cloudflare AI pricing before sizing margins.
- **Dynamic Workers / Worker Loader**: treated as regular Worker billing; Cloudflare hasn't published a separate model at the time of writing.

## Where the money goes

- **Workers AI**: dominant at scale. Biggest levers: (a) choose the correct tag-aware comparison baseline so changed files reflect the release channel under review; (b) start AI review with a compact package manifest instead of full changed-file samples; (c) let the model request only targeted redacted file/diff/search evidence through app-owned tools; (d) keep the system prompt cache-friendly via `AI_CACHE_AFFINITY`; (e) pick the cheapest model that still produces useful structured output. See [`diff-baseline.md`](./diff-baseline.md).
- **D1 storage growth**: ~500 KB–2 MB per scan retained. At 50k scans/mo that's 25–100 GB/mo accumulating. Add a retention/GC policy before this becomes a line item.
- **KV storage**: trivial. The added `COMPARE_CACHE` is essentially free across any realistic catalog of cached versions; it primarily saves sandbox CPU and tarball egress.
- **Sandbox compute**: bounded per scan (2 Dynamic Workers, ~3s CPU each). The KV cache means alternate-version diffs in the detail page no longer linearly multiply this cost.

## AI model strategy (Flagship-gated, planned paid tier)

AI review is wired into the pipeline through `maybeRunAiReview`, but the per-organization Flagship `ai-review` flag is off by default. This section documents the design used when that paid-tier flag is enabled. The module — `server/lib/ai-review.ts` — remains active behind the gate and returns an `unavailable` review when the flag is off.

The scanner's actual security boundary is deterministic analysis plus human npm approval; AI is advisory triage. The intended production posture, implemented in [`server/lib/ai-review.ts`](../server/lib/ai-review.ts), is:

1. run deterministic rules first;
2. send the resulting evidence to Kimi for AI review. The code currently points at `AI_MODEL = "@cf/moonshotai/kimi-k2.5"`, but Cloudflare aliases that model to Kimi K2.6 as of May 30, 2026; migrate the constant before enabling paid AI review.

The reviewer in [`server/lib/ai-review.ts`](../server/lib/ai-review.ts) uses the Vercel AI SDK with the Workers AI provider. The first prompt contains deterministic findings, a normalized manifest diff, ecosystem id, and a changed-file manifest. The model can then call app-owned tools to read bounded redacted file evidence — the `read` tool batches up to 10 paths per call and auto-returns a unified text diff for changed files (or the staged sample otherwise), `search_files` batches up to 5 literal queries, `list_files` filters file subsets — and finally submit the review through a schema-validated `submit_review` tool. The controller enforces max steps, per-tool character caps, a total evidence budget, and scan-ID-suffixed cache affinity; the model never gets raw tarballs, arbitrary filesystem access, network access, or package execution.

Every scan that opts into AI review goes straight to Kimi — there is no cheaper triage tier and no escalation logic. Avoid swapping in a micro model as the primary security reviewer. Supply-chain review needs enough reasoning to notice prompt injection, ecosystem-specific install/build-time behavior, dependency lifecycle risk, artifact metadata integrity, startup hooks, and entrypoint/package-shape surprises, and the persisted `aiJson` records which model produced the review.

## Pricing for margin

Budget roughly **$1–2 per scan** to absorb AI cost variance and leave room for D1 storage growth while model routing is still being validated. Per-scan or per-seat pricing of $0.30–0.50 stays solidly margin-positive once volume crosses the small-team threshold if default triage moves to a cheaper model; below that the $5 Workers base dominates the unit economics.

## What's not included

- Domain, email, support tooling, customer-support staff time.
- Egress for private-registry tarballs (Cloudflare doesn't charge egress for Workers, but a private registry might rate-limit or charge for tarball pulls).
- Better Auth costs only land in D1 (sessions, accounts) — no separate vendor bill.
