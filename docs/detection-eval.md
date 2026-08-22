# Detection eval harness

Drydock's core claim is that it catches risky package changes. That claim has to
be _measured_, not assumed. This harness measures detection quality and turns the
regex/sampling blind spots into numbers we can move.

It is deliberately separate from the golden corpus tests
(`test/security-corpus.test.mjs`, `test/security-corpus-pypi.test.mjs`,
`test/security-corpus-atpm.test.mjs`), which
assert exact rule output and exist to catch regressions. Two different jobs:

|            | Golden regression (existing)              | Eval harness (this)                                        |
| ---------- | ----------------------------------------- | ---------------------------------------------------------- |
| Asserts    | Exact `expectedFindings` + `expectedRisk` | Aggregate quality metrics                                  |
| Fails when | Any rule output changes                   | A gated threshold regresses                                |
| Corpus     | Hand-written to pass current rules        | Labeled by _truth_, plus evasion variants                  |
| Value      | Don't break a known case                  | Know our false-negative / false-positive / evasion profile |

The harness reuses the real detection code (`deterministicFindings` + risk for
npm, `createPyPiReleaseCandidateReview` for PyPI, and `atpmRecordFindings` for
atpm), so it can never drift from what production runs.

## Running it

```sh
pnpm run eval        # runs the gated thresholds and writes the report
```

The report is written to `.context/eval/detection-eval.md` (and `.json`), which
is gitignored. `pnpm test` also runs the gated thresholds, since the harness is
a normal Vitest file (`test/eval/detection-eval.test.mjs`).

## CI visibility

GitHub Actions uploads `.context/eval/detection-eval.*` as the
`detection-eval-report` artifact from the main check job. Pull requests also get
a sticky detection-eval comment that is updated on every run, so reviewers see
the gated regression numbers, reported frontier misses, benign hard-negative
false positives, and evasion robustness without digging through logs.

## Corpus layout

```
test/fixtures/security-corpus/
  cases/              npm golden cases     (regression set, also consumed by the eval)
  cases-pypi/         PyPI golden cases    (regression set)
  cases-vscode/       VS Code golden cases (regression set)
  cases-atpm/         atpm provenance golden cases (regression set)
  cases-dependencies/ dependency-artifact golden cases (regression set, NOT in the eval)
  cases-frontier/     truth-labeled hard cases the rules may MISS  (reported, not gated)
  cases-benign/       benign hard-negatives that the rules may flag (reported, not gated)
```

`cases/`, `cases-pypi/`, and `cases-atpm/` keep their existing golden schema; the eval infers
their labels. `cases-frontier/` and `cases-benign/` use the v2 schema below and
are eval-only (the golden tests never read them, so a frontier miss or a benign
false positive does not break the regression suite).

`cases-dependencies/` is deliberately outside the eval's scope for now. The eval
scores a _staged artifact_ as malicious or benign; a dependency-artifact fixture
describes two packages and asks a different question ("what does approving this
release start shipping?"), so folding it into the same recall/FP rates would
average two incomparable populations. Its golden harness
(`test/security-corpus-dependencies.test.mjs`) carries the regression weight,
including two explicit calibration cases — a benign new dependency and a native
`node-gyp` build — that pin the false-positive posture the eval would otherwise
measure. Bringing dependency review into the eval, with its own labeled
population, is follow-up work; see
[`dependency-review.md`](./dependency-review.md).

## Fixture v2 schema

Additive over the golden schema — all golden fields still work.

```jsonc
{
  "id": "npm-assembled-require-exfil",
  "title": "…",
  "ecosystem": "npm",                  // npm | pypi | atpm (default npm)
  "verdict": "malicious",              // malicious | benign | suspicious
  "threatClass": "obfuscated-dropper", // taxonomy, see below
  "source": "synthetic-adversarial",   // synthetic | synthetic-adversarial | real-sanitized | benign-popular
  "provenance": "incident + how it was defanged", // required for source: real-sanitized
  "intent": "what this models and why it is safe",
  "expectMinRisk": "high",             // malicious must land >= this risk
  "expectAnyRule": [],                 // [] = any finding is fine; else >=1 of these rule ids must fire
  // npm payload (same shape as golden fixtures):
  "previousPackageJson": { … }, "stagedPackageJson": { … },
  "previousFiles": [ … ], "stagedFiles": [ … ]
  // pypi payload: "manifest", "artifacts", "previousArtifacts" (as in cases-pypi/)
  // atpm payload: target/baseline record projections, archive digests, trustPublisher
}
```

If `verdict`/`expectMinRisk`/`expectAnyRule` are omitted (golden fixtures), the
harness derives them: `verdict = benign` when `expectedRisk` is `low` with no
finding ≥ medium, otherwise `malicious`; `expectMinRisk = expectedRisk`;
`expectAnyRule` = the rule ids in `expectedFindings`.

### Threat-class taxonomy

Recall is measured per class so blind spots are visible. Malicious:
`install-script-exfil`, `phantom-gyp`, `obfuscated-dropper`, `credential-steal`,
`network-exfil`, `native-artifact-smuggle`, `files-allowlist-escape`,
`typosquat-metadata`, `protestware`, `dependency-confusion`,
`wheel-integrity` (PyPI), `pth-injection` (PyPI). Benign hard-negatives:
`legit-build-infrastructure`, `legit-childprocess`, `legit-documentation`,
`legit-dynamic-require`, `legit-entrypoint-declaration`, `legit-test-suite`.
atpm golden cases add release-provenance classes for invalid, missing, mismatched,
or regressed attestations plus a matching-provenance control.

## Metrics

- **Regression recall (gated).** Malicious recall over `cases/` + `cases-pypi/` +
  `cases-atpm/`.
  This set is golden-tuned, so it is ~100% by construction — its job is
  regression protection, not quality measurement.
- **Frontier recall (reported).** Recall over `cases-frontier/`, which are
  labeled by _truth_ and intentionally hard. These are where real detection gaps
  show up. Starts low; that is the point.
- **Benign false-positive rate (gated, < 10%).** Over `cases-benign/`. Popular
  packages that legitimately use scary capabilities (native binaries, build-time
  `child_process`, reading `process.env`). A case counts as a false positive when
  the **risk roll-up** surfaces it as risky (`>= medium`), not merely when a
  finding fires — these packages are expected to emit findings; weighted
  multi-signal scoring (`computeRisk`, issue #193) is what keeps the roll-up low.
  Promoted from reported to gated once that scoring brought the rate under the
  ratchet target.
- **Evasion robustness (reported).** For each transform, over npm malicious cases
  we currently catch:
  - `blockedRate` — would the product still treat it as risky? (often high,
    because manifest signals like `preinstall` survive code obfuscation)
  - `codeRetention` — how many of the original `code.*` rules still fire? (the
    honest measure of how fragile the regex code-scanner is)

### Evasion transforms

- `splitStringLiterals` — `'child_process'` → `'chi'+'ld_process'`; defeats
  literal-based matches like `require('https')`. Now defeated by the
  constant-folding pre-pass (`server/lib/review/rules/normalize.ts`), which folds
  the chain back to `'child_process'` before the regex set runs, so
  `codeRetention` is back to baseline.
- `bracketifyMemberAccess` — `process.env` → `process['e'+'nv']`. Also folded
  back (concat → `process['env']` → member access → `process.env`).
- `base64Wrap` — wrap the payload in `eval(atob("…"))`. Note this _trips_ the
  dynamic-evaluation rule, so the file stays "blocked" while the specific
  network/process/credential rules are lost — the report shows that split.
- `pushPastWindow` — prepend >64KB of filler so the payload sits past the old
  per-file sandbox window. This is the acceptance test for the "scan full bytes,
  persist a bounded sample" refactor (issue #191), and it now passes: the sandbox
  returns whole files (`summarizeFile` no longer clips; truncation moved to the
  persistence display sample in `scanFileRowsForArtifacts`), so the transform no
  longer truncates and `blockedRate`/`codeRetention` are back to 100%. The metric
  is kept in the report as a regression guard against re-introducing a scan-time
  window.

## Gated thresholds (and the ratchet)

Gated metrics (`detection-eval.test.mjs`):

- malicious recall ≥ 90%
- every `expectMinRisk: critical` case caught (100%)
- zero false positives on benign controls (no `>= medium` finding on a clean
  regression control)
- benign hard-negative FP rate < 10% (risk roll-up `>= medium`)

Frontier recall and evasion robustness are reported, not gated, so they can start
red. The benign FP gate was the first ratchet step and landed with weighted
multi-signal scoring (issue #193). Full-bytes scanning has now landed too (issue
#191), so `pushPastWindow` already sits at 100% blocked/retained. Remaining
ratchet plan as the corpus and detector improve: gate frontier recall, then gate
`pushPastWindow` survival to lock that in.

## Corpus expansion

Three tracks, in priority order:

1. **Benign hard-negatives (`benign-popular`).** Cheapest, immediately exposes
   the false-positive rate. Popular packages that legitimately use native
   binaries / `child_process` / env reads.
2. **Synthetic adversarial (`synthetic-adversarial`).** Written to _evade_, not
   to pass — string assembly, dynamic indirection, payload past the window.
3. **Real-sanitized (`real-sanitized`).** Distilled from published supply-chain
   incidents and public datasets (OpenSSF `malicious-packages`, npm advisories,
   vendor write-ups). Store the _behavioral shape_, never a live payload:
   - replace exfil/C2 hosts with `example.invalid`;
   - strip real secrets and tokens;
   - keep the technique (the `child_process` + `https` + env-read shape);
   - record `source: real-sanitized` and a `provenance` note (the incident and
     how it was defanged).

This is the corpus that proves Drydock would catch the real thing rather than a
mock of its own rules. It is part of the ongoing detection-defensibility track.

The first real-sanitized batch lives in `cases-frontier/` and is truth-labeled,
so frontier recall now reflects real technique coverage rather than synthetic
shapes only:

| case                                  | technique               | provenance                         | caught today                                                                                                        |
| ------------------------------------- | ----------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `npm-eslint-scope-npmrc-exfil`        | credential-steal        | eslint-scope 3.7.2 (2018)          | yes (postinstall + network)                                                                                         |
| `npm-ua-parser-js-preinstall-dropper` | install-script-exfil    | ua-parser-js (2021)                | yes (preinstall dropper)                                                                                            |
| `npm-event-stream-flatmap-decrypt`    | obfuscated-dropper      | event-stream/flatmap-stream (2018) | yes (env read + dynamic eval)                                                                                       |
| `npm-shai-hulud-secret-harvest`       | credential-steal        | Shai-Hulud worm (2025)             | yes (postinstall harvest)                                                                                           |
| `npm-miasma-phantom-gyp`              | phantom-gyp             | Miasma / Phantom Gyp (2026)        | yes (root `binding.gyp` command substitution)                                                                       |
| `npm-prebuilt-node-addon-smuggle`     | native-artifact-smuggle | OpenSSF prebuilt-addon family      | yes (native artifact)                                                                                               |
| `npm-dependency-confusion-beacon`     | dependency-confusion    | Birsan research (2021)             | yes (preinstall beacon)                                                                                             |
| `npm-node-ipc-protestware-wiper`      | protestware             | node-ipc 10.1.x (2022)             | yes (rules >= 1.12.0) — modified-file network + dynamic-eval co-occur to high (fs wiping itself is still unmodeled) |
| `npm-solana-web3js-keytheft`          | network-exfil           | @solana/web3.js (2024)             | **no** — key read from a function arg, modified-file network only medium                                            |
| `npm-aws-credential-file-steal`       | credential-steal        | OpenSSF cloud-stealer family       | yes (rules >= 1.9.0) — file-path credential read + co-located network egress                                        |

The remaining misses are the point: each documents a concrete residual gap
(function-argument secret flows) for the rules to ratchet against.
`npm-aws-credential-file-steal` was such a gap until rules 1.9.0 taught the JS
credential rule to match sensitive credential file paths (`.aws/credentials`,
`.ssh/id_`, `.netrc`) and to escalate `code.credential-access` to high when a
network egress path co-occurs in the same file. `npm-node-ipc-protestware-wiper`
was a gap until rules 1.12.0 replaced the max-severity risk roll-up with weighted
multi-signal scoring: its two individually-medium capabilities (modified-file
network + dynamic-eval) now co-occur to high, even though the destructive `fs`
loop itself is still unmodeled. Never commit a live payload — keep hosts at
`example.invalid` and reduce destructive loops to inert stubs.
