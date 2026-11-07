# Public Shai-Hulud and Nx behavior benchmark

A fixed, public benchmark of two sanitized incident-derived behavior models and two synthetic benign controls, scored by the production npm detectors. **Authority:** internal (a static public page and download; no API surface). **Owner:** `test/eval/incident-benchmark.mjs`.

Public page: [`/benchmarks/shai-hulud-nx`](https://drydock.org/benchmarks/shai-hulud-nx) with individual findings, misses, controls, primary sources, a citation section, and the downloadable [`v1.json`](../public/benchmarks/shai-hulud-nx/v1.json). These are independently authored reconstructions, not original compromised tarballs, historical baselines, or evidence of historical prevention.

## At a glance

| Thing | Owner | Trigger | Pinned by |
| --- | --- | --- | --- |
| Manifest + fixed case roster | [`test/fixtures/incident-benchmark/v1/`](../test/fixtures/incident-benchmark/v1/) | — | `test/eval/incident-benchmark.test.ts` |
| Public report | `public/benchmarks/shai-hulud-nx/v1.json` | `pnpm run benchmark:incidents` | snapshot test |
| Bundled UI copy | `src/features/public-content/incident-benchmark-v1.json` | same command | bytes must equal the public download |
| Archived prior result | [`v1-rules-1.47.0.json`](../public/benchmarks/shai-hulud-nx/v1-rules-1.47.0.json) | — | — |

## Reproduction

```sh
pnpm run benchmark:incidents                                            # regenerate public JSON + bundled copy
pnpm exec vitest run --project node test/eval/incident-benchmark.test.ts  # check committed report, no rewrite
```

Runs all four fixtures through the production npm deterministic detectors and release-risk attribution, AI disabled.

## Contract

### Scoring

| Case kind | Counts as | Condition |
| --- | --- | --- |
| Malicious model | caught | Release risk ≥ `high` **and** both `code.credential-access` and `code.process-execution` belong to the release delta (a lifecycle warning alone cannot pass) |
| Benign control | false positive | Release risk ≥ `medium` |
| Any declared fixture | in the denominator | Always, including misses |

Artifact risk (includes existing capabilities) and release risk (scores attributed changes) are both reported. Neither replays an actual publication gate.

### Current result

| Report | Rules | Malicious caught | Benign FPs |
| --- | --- | --- | --- |
| `v1.json` (suite 1.0.0) | 1.57.0 | 2/2 | 0/2 (both controls low release risk) |
| `v1-rules-1.47.0.json` (archived) | 1.47.0 | 2/2 | 2/2 |

- Attack and control fixture bytes are identical across both reports; per-fixture SHA-256 values prove it (the corpus digest differs because it covers report metadata).
- The difference is release attribution: rules 1.48.0 attribute install hooks by effective parsed command, so an unchanged hook on the same compact manifest line as a changed version field stays package context.
- Payload findings still count, including unchanged files newly activated by the install script's static import graph.
- The controls keep high artifact risk from their existing install hooks; this fixes attribution and does not declare install hooks harmless.

### Report identity

| Field | Meaning |
| --- | --- |
| Manifest | `evaluatedOn`, `suiteVersion`, `engineRevision` (commit containing the reviewed engine) |
| `rulesVersion` | Deterministic rules version |
| Fixture hashes | Exact SHA-256 per fixture |
| `corpusSha256` | SHA-256 of the compact JSON of an ordered `[{path, sha256}]` array: manifest first, then each fixture in declared order, each digest over exact file bytes |

Cite suite, rules version, engine commit, and corpus digest to identify a result. To reproduce an older result, use its fixture bytes with the recorded engine source; running against current main measures the current engine.

## Invariants

1. Source samples are JSON strings read as evidence; the harness never imports, installs, builds, or executes their code.
2. Scanner/AI subprocesses are inert echo calls, egress uses `example.invalid`, credential paths are defanged, and no secret values or destructive code are included.
3. The public page renders the same report; there are no separately maintained headline numbers.
4. The bundled copy under `src/features/public-content/` keeps dev module requests out of the Worker-owned `/public/*` route prefix.
5. After public release, v1 fixture inputs are frozen: a changed input suite needs a new version/directory and report.
6. An intentional result update for a new detector updates engine revision and evaluation date, regenerates the snapshot, and retains the prior report at a versioned download path and in git history.
7. Never tune controls or omit cases to improve a headline.

## Limits

| Limit | Detail |
| --- | --- |
| Sample size | Two attack models and two controls cannot establish real-world recall, a representative FP rate, campaign-wide coverage, scanner superiority, or historical blocking. |
| Shai-Hulud model | Covers credential harvesting; omits propagation and workflow injection. |
| Nx model | Covers credentials, subprocesses, serialization, and CLI egress; omits the upstream workflow exploit, actual AI tool behavior, repository creation, and shell modifications. |
| Out of suite | Artifact downloading, archive parsing, full malicious bundles, production file limits. |
| Broader measurement | [`detection-eval.md`](./detection-eval.md). |

## Incident evidence

| Model | Sources | Notes |
| --- | --- | --- |
| Shai-Hulud (September 2025) | [Socket's tinycolor report](https://socket.dev/blog/tinycolor-supply-chain-attack-affects-40-packages), [StepSecurity's analysis](https://www.stepsecurity.io/blog/ctrl-tinycolor-and-40-npm-packages-compromised) (both September 15, 2025) | Fictional package identities and versions; no implication that an invented baseline is an authentic clean tinycolor release. |
| Nx/s1ngularity (August 2025) | [maintainer advisory](https://github.com/nrwl/nx/security/advisories/GHSA-cxm3-wv7p-598c), [Nx postmortem](https://nx.dev/blog/s1ngularity-postmortem), [StepSecurity payload analysis](https://www.stepsecurity.io/blog/supply-chain-security-alert-popular-nx-build-system-package-compromised-with-data-stealing-malware) | Postmortem confirms postinstall collection, local AI tool use, and upload to public GitHub repos; the fixture's synthetic baseline and disabled operations test selected static capabilities only. |
