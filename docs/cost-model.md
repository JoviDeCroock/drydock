# Resource planning

This note gives order-of-magnitude resource expectations for self-hosted Drydock
instances on Cloudflare. It is not a quote or capacity guarantee; measure your
own instance under representative release artifacts before relying on these
numbers.

AI review is feature-gated and off by default. When an organization enables
`ai-review`, Workers AI becomes the dominant variable resource consumer. Without
AI review, the main resource drivers are Dynamic Worker CPU, D1 writes, R2
artifact storage, and queue throughput.

## Per-scan components

A single scan exercises the deterministic pipeline: staged tarball download,
previous-version tarball download when metadata is available, deterministic
findings, redaction, persistence, and report artifact writes.

| Component         | Approx per scan | Notes                                                                                                                                      |
| ----------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker requests   | ~5              | `POST /scans` + queue producer + queue consumer + 2 sandbox spins (staged via gateway; previous fetched by the parent, then parsed inline) |
| Worker CPU-ms     | ~3,000          | Dominated by archive parse and SHA-256 hashing in the sandbox                                                                              |
| D1 row writes     | ~150            | one scans row plus file/finding metadata on degraded or legacy paths                                                                       |
| R2 writes         | 4               | artifact-backed completed scans write canonical report, redacted file sample bundle, diff bundle, and manifest JSON                        |
| Workers AI tokens | feature-gated   | compact manifest input plus bounded evidence-tool turns when AI review is enabled                                                          |
| KV write          | 1               | previous-version parsed payload cached in `COMPARE_CACHE`                                                                                  |
| Queue operations  | 2               | enqueue + consume                                                                                                                          |

The default archive limits are the first sizing boundary: at most 2,500 file
records, a 25 MiB expanded-archive cap, and 128 KiB persisted display samples per
eligible file. Detection scans whole eligible file text inside the expanded cap;
the persisted/display sample is clipped separately.

## Per scan-detail view

Viewing a finished scan and re-diffing against alternate versions uses smaller,
read-heavy resources.

| Component           | Approx per view   | Notes                                                                           |
| ------------------- | ----------------- | ------------------------------------------------------------------------------- |
| Worker requests     | 3-8               | `GET /scans/:id` + `/versions` + `/compare` + N x `/compare/file`               |
| D1 reads            | ~5                | scan + files + findings + ownership checks                                      |
| R2 reads            | 4 when backed     | manifest, canonical report digest check, file sample bundle, and diff bundle    |
| KV reads            | 1-5               | one per `/compare` metadata fetch, one per file opened                          |
| Sandbox invocations | 0 cached / 1 cold | after the first global viewer of `package@version`, later compares are KV reads |

The sandbox cost for alternate-version compare is amortized across every viewer
of the same `package@version` thanks to the KV cache added in
[`compare-cache.ts`](../server/lib/compare-cache.ts).

## Capacity scenarios

These scenarios are useful for load testing and queue sizing. They intentionally
avoid business-model assumptions.

| Instance shape | Scans/mo | Detail views/mo | Expected pressure point                                      |
| -------------- | -------- | --------------- | ------------------------------------------------------------ |
| Small team     | 200      | ~1,000          | local operator setup, D1/R2 correctness, alerting            |
| Busy org       | 5,000    | ~25,000         | queue throughput, Workers AI quota if enabled, R2 read paths |
| Heavy use      | 50,000   | ~250,000        | AI quota, artifact storage growth, observability volume      |

At higher scan volumes, tune and verify:

- `SCAN_QUEUE` retry and dead-letter behavior;
- worker CPU duration during archive parsing;
- R2 artifact write verification and fallback reads;
- D1 list-query latency after scan history grows;
- KV hit rate for alternate-version compares;
- observability volume and redaction.

## Resource drivers

- **Workers AI:** dominant when enabled. Keep review evidence diff-first, rely on
  deterministic findings first, and use bounded app-owned evidence tools. The
  reviewer prompt requires concise summaries and a final `submit_review` call so
  a run that reaches its step budget still records an assessment.
- **D1 storage:** new artifact-backed scans keep compact metadata in D1 while
  storing redacted samples in R2. Legacy scans may still carry historical D1 text
  samples until backfill and compaction.
- **R2 storage:** long-term home for canonical reports, redacted samples, diffs,
  and manifests. Do not store raw tarballs by default.
- **KV storage:** primarily saves sandbox CPU and repeated tarball downloads for
  compare views.
- **Sandbox compute:** bounded per scan. The KV cache prevents alternate-version
  diffs in the detail page from multiplying sandbox work linearly.
- **Private registry egress:** Cloudflare Worker egress is not the only possible
  constraint; private registries may rate-limit or restrict tarball pulls.

## AI model strategy

AI review is wired into the pipeline through `maybeRunAiReview`, but the
per-organization Flagship `ai-review` flag is off by default. The module
[`server/lib/ai-review.ts`](../server/lib/ai-review.ts) returns an `unavailable`
review when the flag is off.

The scanner's security boundary is deterministic analysis plus human approval;
AI is advisory triage. When enabled, the intended posture is:

1. run deterministic rules first;
2. send the resulting evidence to Kimi for AI review, with Qwen as a secondary
   route only after transient Kimi capacity, overload, or rate-limit failures
   exhaust bounded retries.

The reviewer uses the Vercel AI SDK with the Workers AI provider. The first
prompt contains deterministic findings, a normalized manifest diff, ecosystem id,
and a changed-file manifest with visible truncation metadata. The model can then
call app-owned tools to read bounded redacted file evidence, search files
literally, list focused subsets, and finally submit schema-validated JSON through
`submit_review`.

The controller enforces max steps, per-tool character caps, total evidence
budget, output-token cap, and scan-ID-suffixed cache affinity. The model never
gets raw tarballs, arbitrary filesystem access, network access, or package
execution.
