# Detection eval harness

Aggregate detection-quality metrics (recall, false positives, evasion, release injection) over the corpus, run through the real detection code. **Authority:** internal (a CI quality gate; it never affects a scan). **Owner:** `test/eval/harness.mjs`.

## At a glance

| Thing | Owner | Trigger | Pinned by |
| --- | --- | --- | --- |
| Gated thresholds | `test/eval/detection-eval.test.mjs` | `pnpm run eval`; also every `pnpm test` (normal Vitest file) | the test itself |
| Report | `writeReport` in `test/eval/harness.mjs` → `.context/eval/detection-eval.md` + `.json` (gitignored) | every eval run; a write failure fails the command | — |
| CI artifact + PR comment | `.github/workflows/ci.yml`, `scripts/comment-detection-eval.mjs` | main check job uploads `detection-eval-report`; PRs get one sticky comment, updated each run | — |
| Real-package FP sweep | `test/eval/npm-fp-sweep.test.mjs` | `pnpm run eval:npm-sweep` (network, report-only, never in `pnpm test`) | — |
| Golden regression (separate job) | `test/security-corpus*.test.mjs` | `pnpm test` | [`security-detection-corpus.md`](./security-detection-corpus.md) |

|  | Golden regression | Eval harness |
| --- | --- | --- |
| Asserts | Exact `expectedFindings` + `expectedRisk` | Aggregate quality metrics |
| Fails when | Any rule output changes | A gated threshold regresses |
| Corpus | Hand-written to pass current rules | Labeled by truth, plus evasion variants |
| Answers | Did a known case break? | What is the FN / FP / evasion profile? |

Engines reused (never a reimplementation): `deterministicFindings` + risk (npm), `createPyPiReleaseCandidateReview` (PyPI), `atpmRecordFindings` (atpm), `createVscodeExtensionReview` (VS Code).

## Contract

### Corpus layout

| Directory (`test/fixtures/security-corpus/`) | Role | Gated? |
| --- | --- | --- |
| `cases/`, `cases-pypi/`, `cases-atpm/`, `cases-vscode/` | Golden regression sets; eval infers missing labels | yes |
| `cases-frontier/` | Truth-labeled hard cases the rules may miss (v2 schema, eval-only) | reported |
| `cases-benign/` | Benign hard-negatives the rules may flag (v2 schema, eval-only) | yes (FP rate) |

The golden tests never read `cases-frontier/` or `cases-benign/`, so a frontier miss or benign FP does not break the regression suite.

### Fixture v2 schema

Additive over the golden schema; all golden fields still work.

```jsonc
{
  "id": "npm-assembled-require-exfil",
  "title": "…",
  "ecosystem": "npm", // npm | pypi | atpm | vscode (default npm)
  "verdict": "malicious", // malicious | benign
  "threatClass": "obfuscated-dropper", // taxonomy below
  "source": "synthetic-adversarial", // synthetic | synthetic-adversarial | real-sanitized | benign-popular
  "provenance": "incident + how it was defanged", // required for source: real-sanitized
  "intent": "what this models and why it is safe",
  "expectMinRisk": "high", // malicious must land >= this risk
  "expectAnyRule": [], // [] = any finding; else >= 1 of these rule ids must fire
  // npm: previousPackageJson, stagedPackageJson, previousFiles, stagedFiles
  // pypi: manifest, artifacts, previousArtifacts (as in cases-pypi/)
  // atpm: target/baseline record projections, archive digests, trustPublisher
}
```

Derived labels for golden fixtures: `verdict = benign` when `expectedRisk` is `low` with no finding ≥ medium, else `malicious`; `expectMinRisk = expectedRisk`; `expectAnyRule` = rule ids in `expectedFindings`; `threatClass` = `category`.

### Threat classes

| Kind | Classes |
| --- | --- |
| Malicious | `install-script-exfil`, `phantom-gyp`, `obfuscated-dropper`, `credential-steal`, `network-exfil`, `native-artifact-smuggle`, `files-allowlist-escape`, `typosquat-metadata`, `protestware`, `dependency-confusion`, `self-propagating-worm`, `wheel-integrity` (PyPI), `pth-injection` (PyPI); atpm adds invalid/missing/mismatched/regressed provenance classes plus a matching-provenance control |
| Benign hard-negative | `legit-build-infrastructure`, `legit-byte-codec`, `legit-childprocess`, `legit-dependency-patching`, `legit-documentation`, `legit-dynamic-require`, `legit-entrypoint-declaration`, `legit-env-detection`, `legit-env-read`, `legit-key-handling`, `legit-llm-tooling`, `legit-minified-bundle`, `legit-release-tooling`, `legit-secret-shaped-code`, `legit-test-suite` |

### Metrics and gates

| Metric | Gated? | Threshold | Definition |
| --- | --- | --- | --- |
| Coverage floor | yes | regression ≥ npm 30, pypi 15, atpm 6, vscode 3; frontier npm ≥ 12; benign npm ≥ 12; every evasion transform > 0 samples | Deleting fixtures or a directory cannot turn into a vacuous 100%. |
| Regression malicious recall | yes | ≥ 90% | Over the four golden sets; ~100% by construction (regression protection, not quality). |
| Critical recall | yes | 100% | Every `expectMinRisk: critical` case caught. |
| Benign regression positives | yes | exact id list | Must equal the acknowledged list (currently `pypi-benign-docs-metadata-and-test-fixtures`); any new positive fails rather than being counted. |
| Benign hard-negative FP rate | yes | < 10% | Over `cases-benign/`; a case is a FP when the risk roll-up reaches `>= medium`, not when a finding fires. |
| Release injection | yes | 0 misses in each of `lines`, `minified`, `renamed`, `renamed-minified`; ≥ 20 samples each; every renamed sample paired | See below. |
| Evasion blocked rate | yes | 100% per transform; ≥ 20 samples each | Would the product still treat the payload as risky? |
| Evasion code-rule retention | no (reported) | — | Share of the original `code.*` rules still firing; the honest fragility measure. |
| Frontier recall | no (reported) | — | Recall over `cases-frontier/`; next ratchet candidate. |

Evasion samples are npm malicious cases currently caught that ship a `.js`/`.cjs`/`.mjs` file (only those files are rewritten).

Release injection:

1. Input: every malicious npm case whose release-delta findings include a `code.*` rule.
2. `lines` / `minified`: the payload is spliced as a modification into a carrier module that already uses network, process, environment, and dynamic-code primitives, as ordinary lines or one minified line.
3. `renamed` / `renamed-minified`: the same splice into a bundler chunk whose content hash changed (carrier padded with a module body, shipped last release under a hashed sibling name), so the payload file is added and pairs as a rename (`paired`).
4. Pass: `releaseRisk` (what the workflow gate reads) still reaches `expectMinRisk` through the real annotation and risk-breakdown path. No other metric exercises release-delta classification.

### Evasion transforms

| Transform | Rewrite | Countered by |
| --- | --- | --- |
| `splitStringLiterals` | `'child_process'` → `'chi'+'ld_process'` | Constant folding (`server/lib/review/rules/normalize.ts`). |
| `bracketifyMemberAccess` | `process.env` → `process['e'+'nv']` | Folding: concat → `process['env']` → `process.env`. |
| `base64Wrap` | Payload wrapped in `eval(atob("…"))` | Literal decodes folded as data; a decode consumed by a code-running call is scanned as code (marked obfuscated). |
| `controlBytePadding` | Raw NUL in a leading comment, re-classified by the parser's `decodeBodyText` | Script source keeps a sample (`control-bytes`); `file.control-bytes` reports the bytes. |
| `renameEntryToMin` | Code files the manifest names renamed to `.min.js`, manifest rewritten | Minified bundles are sampled and scanned as code; one nothing provably loads grades one step lower. |
| `pushPastWindow` | > 64 KB filler before the payload | The sandbox returns whole files (`summarizeFile` does not clip); truncation applies only to the persisted display sample (`scanFileRowsForArtifacts`). Kept as a guard against reintroducing a scan-time window. |

### Real-sanitized frontier cases

| Case | Technique | Provenance | Caught |
| --- | --- | --- | --- |
| `npm-eslint-scope-npmrc-exfil` | credential-steal | eslint-scope 3.7.2 (2018) | yes (postinstall + network) |
| `npm-ua-parser-js-preinstall-dropper` | install-script-exfil | ua-parser-js (2021) | yes (preinstall dropper) |
| `npm-event-stream-flatmap-decrypt` | obfuscated-dropper | event-stream/flatmap-stream (2018) | yes (env read + dynamic eval) |
| `npm-shai-hulud-secret-harvest` | credential-steal | Shai-Hulud worm (2025) | yes (postinstall harvest) |
| `npm-miasma-phantom-gyp` | phantom-gyp | Miasma / Phantom Gyp (2026) | yes (root `binding.gyp` command substitution) |
| `npm-prebuilt-node-addon-smuggle` | native-artifact-smuggle | OpenSSF prebuilt-addon family | yes (native artifact) |
| `npm-dependency-confusion-beacon` | dependency-confusion | Birsan research (2021) | yes (preinstall beacon) |
| `npm-node-ipc-protestware-wiper` | protestware | node-ipc 10.1.x (2022) | yes: modified-file network + dynamic eval co-occur to high; the destructive `fs` loop itself is unmodeled |
| `npm-solana-web3js-keytheft` | network-exfil | @solana/web3.js (2024) | yes: `code.key-material-exfiltration` traces `keypair.secretKey` from a function argument into the `fetch` header |
| `npm-aws-credential-file-steal` | credential-steal | OpenSSF cloud-stealer family | yes: credential file path read + co-located network egress |
| `pypi-litellm-pth-credential-stealer` | pth-injection | LiteLLM 1.107.0 (2026) | yes: `.data/purelib` `.pth` import + install-root `sitecustomize.py`; `.data/data` and package-form variants also covered |

The remaining frontier cases are synthetic (`install-root-*`, `npm-install-hook-worm-propagation`, `npm-assembled-require-exfil`). Read the current frontier recall and any misses from the report, not from this doc.

## Invariants

1. The harness calls production detection code, so it cannot drift from what scans run (`test/eval/harness.mjs`).
2. Benign FPs are judged on the risk roll-up, not on findings: popular packages are expected to emit findings (`detection-eval.test.mjs`).
3. A real-package FP found by the sweep becomes a distilled `cases-benign/` fixture before the rule changes, so the gated eval keeps the fix.
4. Sweep tarballs are only ever parsed as data, never executed or installed.
5. `real-sanitized` cases store the behavioral shape, never a live payload: hosts are `example.invalid`, secrets stripped, destructive loops reduced to inert stubs, and a `provenance` note records the incident and the defanging.
6. Sanitized cases measure selected incident behaviors; they do not prove detection of authentic compromised artifacts or historical prevention (see [`incident-benchmark.md`](./incident-benchmark.md)).

## Real-package false-positive sweep

`pnpm run eval:npm-sweep` pulls consecutive releases of `test/eval/npm-fp-sweep-packages.json` from the public registry and runs each pair through the production public-diff path (sandbox parser, `buildNpmFindings`, redaction, release-delta annotation, risk breakdown, AI off).

A pair whose `releaseRisk` reaches medium or `artifactRisk` reaches high is listed in `.context/npm-fp-sweep/report.md` with finding, line, and excerpt; it is a triage candidate, not a proven FP.

| Env var | Effect |
| --- | --- |
| `NPM_FP_SWEEP_DEPTH` | Release pairs per package (default 1) |
| `NPM_FP_SWEEP_CONCURRENCY` | Sweep concurrency (default 6) |
| `NPM_FP_SWEEP_PACKAGES` | Comma-separated names replacing the curated list |
| `NPM_FP_SWEEP_CACHE` | Moves the compressed tarball cache (default `.context/npm-fp-sweep/tarballs`) |

## Change checklist

| If you change | Also |
| --- | --- |
| A rule | Run `pnpm run eval`; update the golden fixture and [`detection-rule-history.md`](./detection-rule-history.md). |
| A gate threshold or coverage floor | Edit `test/eval/detection-eval.test.mjs` and the Metrics and gates table above. |
| The report shape | Check `scripts/comment-detection-eval.mjs` and the CI upload in `.github/workflows/ci.yml`. |
| Add corpus | Priority: `benign-popular` hard-negatives (cheapest FP signal), then `synthetic-adversarial` (written to evade: string assembly, indirection, payload past a window), then `real-sanitized` (OpenSSF `malicious-packages`, npm advisories, vendor write-ups). |
