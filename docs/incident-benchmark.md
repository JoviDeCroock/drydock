# Public Shai-Hulud and Nx behavior benchmark

The public page at [`/benchmarks/shai-hulud-nx`](https://drydock.org/benchmarks/shai-hulud-nx)
reports two sanitized incident-derived behavior models and two synthetic benign
controls. It includes individual findings, misses, controls, primary sources, a
citation section, and the downloadable [`v1.json`](../public/benchmarks/shai-hulud-nx/v1.json).
These are independently authored reconstructions, not original compromised
tarballs, historical baselines, or evidence of historical prevention.

## Reproduction

With repository dependencies installed, run:

```sh
pnpm run benchmark:incidents
```

This evaluates all four fixtures using the production npm deterministic
detectors and release-risk attribution, with AI disabled, and writes the public
JSON and its identical bundled UI copy. The ordinary test command checks the committed report without rewriting
it:

```sh
pnpm exec vitest run --project node test/eval/incident-benchmark.test.ts
```

The manifest and fixed case roster live in
[`test/fixtures/incident-benchmark/v1/`](../test/fixtures/incident-benchmark/v1/).
Source samples are JSON strings read as evidence. The harness never imports,
installs, builds, or executes their code. Scanner/AI subprocesses are replaced
with inert echo calls, egress uses `example.invalid`, credential paths are
defanged, and no secret values or destructive code are included.

The manifest records the evaluation date, suite version, and commit containing
the reviewed detection engine. The report adds the deterministic rules version,
exact fixture SHA-256 hashes, and corpus digest. The corpus digest hashes the
compact JSON encoding of an ordered array of `{path, sha256}` objects: manifest
first, then every fixture in declared order, with each digest over exact file
bytes. The public page renders this same report rather than maintaining separate
headline numbers. A generated copy under `src/features/public-content/` is
bundled for the public page; the snapshot test checks that its bytes equal the
public download. This keeps dev module requests out of the Worker-owned
`/public/*` route prefix.

After public release, preserve the v1 fixture inputs. A changed input suite needs
a new version/directory and report. When intentionally updating a result for a
new detector, update the engine revision and evaluation date, regenerate the
snapshot, and retain the prior report at a versioned download path as well as in repository history. Cite the suite,
rules version, engine commit, and corpus digest to identify a result precisely.
To reproduce an older result, use its benchmark fixture bytes with the recorded
engine source. Running against current main measures the current engine.

## Metrics and current result

A malicious model counts as caught only when release risk reaches at least
`high` **and** both `code.credential-access` and `code.process-execution` findings
belong to the release delta. A lifecycle warning alone cannot pass. A benign
control counts as a false positive when release risk reaches at least `medium`.
Every declared fixture stays in the denominator, including a miss.

Version 1.0.0 with deterministic rules 1.55.0 catches **2/2 malicious models**
and keeps **both benign controls at low release risk**, with **0/2 false positives**.
The attack and control fixture bytes are identical to the first report. The
[archived rules 1.47.0 report](../public/benchmarks/shai-hulud-nx/v1-rules-1.47.0.json)
retains the original **2/2 caught models and 2/2 benign false positives**.

The earlier attribution used changed display lines: compact package manifests
put the unchanged hook on the same line as the changed version field. Rules
1.48.0 compare effective parsed commands, keeping unchanged hooks as existing
package context. Payload findings still contribute to release risk, including
unchanged files newly activated by the install script's static import graph.
Artifact findings and severities are retained: the controls still have high
artifact risk from their existing install hooks. This fixes release attribution
rather than declaring install hooks harmless. Do not tune controls or omit cases
to improve a headline. The corpus digest changes with report metadata; per-fixture
SHA-256 values establish the identical source inputs across the two results.

Artifact risk and release risk are both reported. Artifact risk includes existing
capabilities; release risk scores attributed changes. Neither score replays an
actual publication gate. Two authored attack models and two controls cannot
establish real-world recall, a representative false-positive rate, campaign-wide
coverage, scanner superiority, or historical blocking.

The Shai-Hulud model covers credential harvesting and omits propagation and
workflow injection. The Nx model covers credentials, subprocesses, serialization,
and CLI egress; it omits the upstream workflow exploit, actual AI tool behavior,
repository creation, and shell modifications. Artifact downloading, archive
parsing, full malicious bundles, and production file limits are outside this
suite. The larger [`detection eval`](./detection-eval.md) remains the broader
coverage measurement.

## Incident evidence

The September 2025 Shai-Hulud reconstruction uses the behavior described by
[Socket's original tinycolor report](https://socket.dev/blog/tinycolor-supply-chain-attack-affects-40-packages)
and [StepSecurity's original analysis](https://www.stepsecurity.io/blog/ctrl-tinycolor-and-40-npm-packages-compromised),
both published September 15, 2025. It uses fictional package identities and
versions rather than implying that an invented baseline is an authentic clean
tinycolor release.

The August 2025 Nx/s1ngularity reconstruction uses the
[maintainer advisory](https://github.com/nrwl/nx/security/advisories/GHSA-cxm3-wv7p-598c),
[Nx postmortem](https://nx.dev/blog/s1ngularity-postmortem), and
[StepSecurity payload analysis](https://www.stepsecurity.io/blog/supply-chain-security-alert-popular-nx-build-system-package-compromised-with-data-stealing-malware).
The maintainer's postmortem confirms postinstall collection, use of local AI
tools, and upload to public GitHub repositories. The fixture's synthetic baseline
and disabled operations test selected static capabilities, not those original
bytes or every behavior in the incident.
