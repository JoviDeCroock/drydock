# Cost model (napkin math)

Order-of-magnitude estimates for running staged-publish-review on Cloudflare. Numbers are based on Cloudflare's published rates for the Workers Paid plan and assume a typical scan profile (≤250 files, ≤64 KB per file textSample). Treat this as a sanity check, not a quote — Workers AI model choice is the dominant cost driver.

## Per-scan cost components

A single scan exercises the full pipeline (staged tarball download, previous-version tarball download, deterministic findings, AI review, persistence).

| Component | Approx per scan | Notes |
|---|---|---|
| Worker requests | ~5 | `POST /scans` + queue producer + queue consumer + 2 sandbox spins (staged + previous) |
| Worker CPU-ms | ~3,000 | Dominated by tar parse + sha256 hashing in the sandbox |
| D1 row writes | ~150 | one scans row + N scan_files + M scan_findings |
| Workers AI tokens | ~20k input / ~500 output | Only changed files are sent in; static safety preamble is prompt-cached via `AI_CACHE_AFFINITY` |
| KV write | 1 | Previous-version parsed payload cached in `COMPARE_CACHE` |
| Queue operations | 2 | Enqueue + consume |

## Per scan-detail view

Viewing a finished scan and re-diffing against alternate versions.

| Component | Approx per view | Notes |
|---|---|---|
| Worker requests | 3–8 | `GET /scans/:id` + `/versions` + `/compare` + N × `/compare/file` |
| D1 reads | ~5 | scan + files + findings + ownership checks |
| KV reads | 1–5 | One per `/compare` metadata fetch, one per file opened |
| Sandbox invocations | 0 cached / 1 cold | After the first global viewer of `package@version`, all subsequent compares are KV reads |

The sandbox cost for re-diff is amortized across every viewer of the same `package@version` thanks to the KV cache added in [`compare-cache.ts`](../server/lib/compare-cache.ts).

## Scenario rollups

| Scale | Scans/mo | Detail views/mo | Workers + D1 + KV + Queues | Workers AI | **Total/mo** |
|---|---|---|---|---|---|
| Small team (~5 users) | 200 | ~1,000 | ~$5 base | ~$3 | **~$8** |
| Growth SaaS (~100 customers) | 5,000 | ~25,000 | ~$10 | ~$65 | **~$75** |
| Heavy use | 50,000 | ~250,000 | ~$15 | ~$650 | **~$665** |

Workers AI is ~90% of the variable cost at every scale above the smallest tier.

## Pricing inputs used

- **Workers Paid plan**: $5/mo base, 10M requests + 30M CPU-ms included, then $0.30/M req and $0.02/M CPU-ms.
- **D1**: 50M writes + 25B reads/mo included on the paid plan, $1/M writes and $0.001/1k reads beyond. Storage $0.75/GB-mo.
- **KV**: $0.50/M reads, $5/M writes, $0.50/GB-mo storage. ~5 MB per cached `package@version` entry.
- **Queues**: $0.40/M operations.
- **Workers AI (current default Kimi K2.5)**: $0.60/M input + $0.10/M cached input + $3.00/M output tokens on the current Cloudflare pricing page. Kimi K2.6 is more expensive at $0.95/M input + $0.16/M cached input + $4.00/M output. Confirm against current Cloudflare AI pricing before sizing margins.
- **Dynamic Workers / Worker Loader**: treated as regular Worker billing; Cloudflare hasn't published a separate model at the time of writing.

## Where the money goes

- **Workers AI**: dominant at scale. Biggest levers: (a) keep only changed files in the input (already enforced in [`ai-review.ts`](../server/lib/ai-review.ts)); (b) keep the system prompt cache-friendly via `AI_CACHE_AFFINITY`; (c) pick the cheapest model that still produces useful structured output.
- **D1 storage growth**: ~500 KB–2 MB per scan retained. At 50k scans/mo that's 25–100 GB/mo accumulating. Add a retention/GC policy before this becomes a line item.
- **KV storage**: trivial. The added `COMPARE_CACHE` is essentially free across any realistic catalog of cached versions; it primarily saves sandbox CPU and tarball egress.
- **Sandbox compute**: bounded per scan (2 Dynamic Workers, ~3s CPU each). The KV cache means alternate-version diffs in the detail page no longer linearly multiply this cost.

## AI model strategy

Kimi is valuable for deep package-security review, but it should not necessarily be the always-on model for every staged release. The scanner's actual security boundary is deterministic analysis plus human npm approval; AI is advisory triage. A cost-effective production posture is:

1. run deterministic rules first;
2. use a cheaper capable model such as `@cf/qwen/qwen3-30b-a3b-fp8` for default AI triage;
3. escalate to Kimi (`@cf/moonshotai/kimi-k2.5` or newer) only for risky or ambiguous scans.

Escalate when deterministic findings are medium or higher, lifecycle scripts changed, dependencies/optional dependencies changed in unusual ways, entrypoints changed, previous-version comparison is missing, new binaries/native artifacts appear, credential/network/process/obfuscation indicators appear, or the default model returns suspicious/blocked/manual-review output.

Avoid using the cheapest micro model as the primary security reviewer. A very small model can summarize deterministic findings, but supply-chain review needs enough reasoning to notice prompt injection, install-time behavior, dependency lifecycle risk, and entrypoint/package-shape surprises.

## Pricing for margin

Budget roughly **$1–2 per scan** to absorb AI cost variance and leave room for D1 storage growth while model routing is still being validated. Per-scan or per-seat pricing of $0.30–0.50 stays solidly margin-positive once volume crosses the small-team threshold if default triage moves to a cheaper model; below that the $5 Workers base dominates the unit economics.

## What's not included

- Domain, email, support tooling, customer-support staff time.
- Egress for private-registry tarballs (Cloudflare doesn't charge egress for Workers, but a private registry might rate-limit or charge for tarball pulls).
- Better Auth costs only land in D1 (sessions, accounts) — no separate vendor bill.
