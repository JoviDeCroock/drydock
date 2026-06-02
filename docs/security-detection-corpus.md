# Security detection corpus

Drydock's deterministic findings are the authoritative review signal while AI review is unavailable behind the default-off Flagship gate. The detection corpus exists to make those findings measurable: every rule change should be checked against small, reviewable package scenarios with explicit expected rule IDs, severities, and risk.

This is a **safe synthetic corpus**, not a malware zoo. It captures techniques observed in npm supply-chain research without vendoring live malicious packages, encrypted malware archives, real credentials, or customer artifacts.

## Research basis

The fixture taxonomy is based on the current Drydock rule surface plus public npm malware research:

- [OpenSSF malicious-packages](https://github.com/ossf/malicious-packages) publishes OSV-format reports and explicitly scopes in typosquatting, account takeover, malicious prebuilt binaries, dependency confusion, and manifest confusion. It also warns that telemetry, obfuscation, and protestware need context before they are treated as malicious.
- [OpenSSF Package Analysis](https://github.com/ossf/package-analysis) tracks package behavior by asking what files packages access, what addresses they connect to, and what commands they run. Its public case studies are useful for behavior taxonomy, but Drydock should not execute packages.
- [Datadog's malicious-software-packages-dataset](https://github.com/DataDog/malicious-software-packages-dataset/) is human-triaged and useful for taxonomy validation, but its samples are actively malicious and distributed as encrypted `infected` archives. Do not copy those samples into this repository.
- Recent npm detection benchmark research reports a curated dataset of 6,420 malicious and 7,288 benign npm packages, with 11 behavior categories and 8 evasion categories. The most common behaviors were command execution, data collection, and data exfiltration; install scripts were used by about 72% of malicious packages in that study, and preinstall hooks were the dominant install-time entry point.
- The same benchmark highlights the central detection trade-off: benign and malicious packages often call the same APIs. A single `process.env` or `https` use is capability evidence, while chains such as collect → serialize → exfiltrate are stronger intent evidence.
- Network-only code follows that trade-off: unchanged network-only files are suppressed as package context, added network-only files remain medium-severity contextual evidence, and added network access escalates to high when it is tied to lifecycle scripts, process execution, dynamic evaluation, or credential access.

## Safety policy

Corpus fixtures must follow the same artifact-retention posture as production scans:

- Use synthetic `FileRecord` JSON, not raw tarballs.
- Use `example.invalid` for URLs.
- Use obviously fake secrets only when testing redaction/secret rules.
- Do not include runnable malware, live C2 endpoints, exploit payloads, encrypted samples, or proprietary package bytes.
- Keep fixtures minimal enough that reviewers can understand why each expected finding exists.

## Fixture format

Fixtures live under `test/fixtures/security-corpus/cases/*.json` and are evaluated by `test/security-corpus.test.mjs`.

Required fields:

- `id` — stable fixture identifier.
- `title` — human-readable scenario.
- `category` — taxonomy bucket.
- `intent` — what behavior the fixture is meant to protect.
- `stagedFiles` — sandbox-shaped `FileRecord[]` for the staged package.
- `expectedRisk` — expected deterministic risk from `computeRisk()`.
- `expectedFindings` — exact expected `{ ruleId, severity, file }` entries.

Optional fields:

- `previousFiles` — previous-version `FileRecord[]`; defaults to empty.
- `previousPackageJson` / `stagedPackageJson` — summaries for package-json diff assertions and deterministic manifest review.
- `expectedPackageJsonDiff` — assertions for diff-only signals.
- `coverageGaps` — signals represented in the fixture but not yet promoted to deterministic findings.

The test intentionally compares exact rule IDs, severities, files, and risk. If a rule change is intentional, update the fixture expectation in the same PR and explain why.

Adapter-level scan tests should include at least one baseline-backed fixture that asserts a `diff.*` rule ID. This keeps ecosystem adapters from accidentally dropping the package diff before deterministic findings run.

## Initial taxonomy

The first corpus slice covers:

- benign version bump control;
- preinstall credential/environment collection with command and network capability;
- implicit `node-gyp rebuild` from root `binding.gyp` plus native artifact review;
- base64/dynamic evaluation plus network-capable code;
- secret-looking file addition;
- large opaque binary addition;
- files that appear in the tarball outside a declared `package.json.files` allowlist;
- malformed `package.json` parse failure;
- dependency and entrypoint package-json diff changes; unusual non-registry dependency specs now raise deterministic findings while entrypoint changes remain a documented coverage gap.

## Known coverage gaps

The corpus deliberately records some product gaps instead of hiding them:

- Plain dependency additions are visible in `packageJsonDiff`, but they do not yet raise deterministic findings unless they use unusual specs such as `github:`, `git+ssh:`, `http(s):`, `file:`, or `npm:` aliases. Newly added optional dependencies also raise deterministic findings because they can fail softly while still running install-time lifecycle hooks.
- Entrypoint changes are visible in `packageJsonDiff`, but they do not yet raise deterministic findings or risk.
- Maintainer/package transfer signals, new publisher signals, package reputation, and OpenSSF/package intelligence integrations are not implemented.
- Behavior-chain detection is regex-based and does not yet prove source-to-sink intent.
- Anti-analysis and environment-detection patterns are not deeply modeled because Drydock intentionally avoids package execution.

## Adding fixtures

1. Add a new JSON file under `test/fixtures/security-corpus/cases/`.
2. Keep the fixture synthetic and minimal.
3. Add exact expected findings and risk.
4. If the scenario is important but not yet detected, add `coverageGaps` and assert the current diff-only behavior where possible.
5. Run `pnpm run test:node -- security-corpus.test.mjs` before opening the PR.

## PyPI corpus

The PyPI adapter (`server/lib/adapters/pypi/index.ts`) has its own golden corpus under
`test/fixtures/security-corpus/cases-pypi/`, evaluated by `test/security-corpus-pypi.test.mjs`. It is a
separate harness, not an extension of the npm one, because PyPI findings legitimately carry two rule
versions (see the invariant below).

### Rule families and versions

A PyPI review runs two rule families over the staged artifacts:

- `pypi.*` findings come from `pyPiReleaseFindings` and carry `PYPI_RULES_VERSION` (currently `0.2.0`).
- shared `file.*` / `code.*` / `diff.*` findings come from `deterministicFindings` and carry
  `DETERMINISTIC_RULES_VERSION` (currently `1.6.1`).

The harness asserts this per family: every `pypi.*` finding must equal `PYPI_RULES_VERSION` and every
other finding must equal `DETERMINISTIC_RULES_VERSION`. Bump the relevant constant **and** update the
fixtures in the same PR whenever a rule family's coverage changes (`PYPI_RULES_VERSION` in the adapter,
`DETERMINISTIC_RULES_VERSION` in `review.ts`). The PyPI adapter opts the shared `code.*` rules into
Python-aware matching in `1.6.0` (subprocess/os.system, urllib.request/requests/socket,
exec/`__import__`/base64-decode, os.environ/getpass/keyring) while npm keeps the JavaScript matcher;
the same Python matcher must be used when annotating modified-file findings so release-risk
classification stays consistent for extensionless Python files. `pypi.*` grew `startup-hook`,
`record-mismatch`, and `unusual-dependency` in `0.2.0`, and
`setup-install-command` was upgraded to fire on the top-level sdist `setup.py` install-time code, not
just `cmdclass`.

### Fixture format

Required fields:

- `id`, `title`, `category`, `intent` — metadata.
- `manifest` — parsed by `parsePyPiReleaseManifest`: schema `drydock.release-artifacts.v1`, ecosystem
  `pypi`, `package`, `version`, and `artifacts[{path, sha256 (64 hex), url?}]`.
- `artifacts` — `[{path, files: FileRecord[]}]`. Artifact paths must **exactly** match the manifest's
  artifact paths or `assertManifestArtifactSet` throws.
- `expectedRisk` — expected risk from `computeRisk()`.
- `expectedFindings` — exact `{ruleId, severity, file}` entries.

Optional fields:

- `previousArtifacts` — previous-version `[{path, files}]`; enables `diff.*` findings.
- `coverageGaps` — documented-only blind spots (not asserted).

`FileRecord = {path, size, sha256, flags[], textSample?}`. A wheel fixture should include a
`*.dist-info/WHEEL` file with a `Tag:` header so the diff namespace is deterministic; binary artifacts
use `flags: ["binary"]` and omit `textSample`.

### The two `expectedFindings[].file` namespacing schemes

This is the most error-prone part of authoring fixtures. `pypi.*` findings and shared findings namespace
file paths differently — `test/pypi.test.mjs` is the live oracle.

- **Scheme A — `pypi.*` findings.** `namespacedPath(artifactPath, rawFilePath)`: the literal manifest
  artifact path, then `/`, then the file's in-archive path. For **sdists** the in-archive path is first
  root-stripped (`demo_package-1.2.0/setup.py` → `setup.py`). The `.dist-info` directory is **not**
  normalized.
  - wheel install-root `.pth`: `dist/demo_package-1.2.0-py3-none-any.whl/inject.pth`
  - sdist `setup.py`: `dist/demo_package-1.2.0.tar.gz/setup.py`
  - wheel METADATA: `dist/demo_package-1.2.0-py3-none-any.whl/demo_package-1.2.0.dist-info/METADATA`
- **Scheme B — shared `file.*`/`code.*`/`diff.*` findings.** `artifactDiffNamespace(artifact)` + `/` +
  `normalizePyPiDiffFilePath(rootStrippedPath)`. The namespace is `sdist` for sdists and
  `wheel/<WHEEL Tag headers, sorted, joined with +>` for wheels (falling back to the `.whl` filename's
  last three tags). `normalizePyPiDiffFilePath` collapses `<name>.dist-info/` → `.dist-info/`.
  - shared finding on a wheel module: `wheel/py3-none-any/demo_package/collect.py`
  - shared finding on a sdist `setup.py`: `sdist/setup.py`
  - shared finding on wheel METADATA (as a diff entry): `wheel/py3-none-any/.dist-info/METADATA`

A single file can fire findings from both families with different paths — e.g. an sdist `setup.py` with
top-level `os.system`/`urllib.request` produces `pypi.setup-install-command` at
`dist/…tar.gz/setup.py` (Scheme A) **and** `code.process-execution`/`code.network-access` at
`sdist/setup.py` (Scheme B). List both tuples.
For startup-hook fixtures, only files installed at Python's site root are expected to fire:
top-level wheel files and wheel `.data/{purelib,platlib}/` files count; package-internal files such as
`demo_package/sitecustomize.py` or `demo_package/inject.pth` do not.

### Known coverage gaps (PyPI)

The corpus records these intentional blind spots rather than hiding them:

- RECORD **hash** verification: only undeclared-file detection ships. RECORD digests are
  `sha256=<base64url-nopad>` while `FileRecord.sha256` is hex, so digest comparison needs a format
  conversion that is deferred. Truncated RECORD samples are skipped to avoid false positives.
- `[build-system] backend-path` / PEP 517 in-tree build backends (arbitrary code at build time) are not
  flagged; moderate false-positive risk with maturin/Cython.
- Credential → network **taint chains**: capability tokens are flagged individually, not proven
  source-to-sink.
- Typosquatting / dependency-confusion name distance, maintainer/transfer signals, and package
  reputation are not modeled (need registry intelligence; high false-positive risk).
- `Requires-Dist` **diffing** between versions, `entry_points`/`console_scripts`, wheel `*.data/scripts/`,
  and `.pyc`-only distribution are not yet analyzed.
- Native `.so`/`.pyd` presence stays high severity but is a known false-positive source for legitimate
  compiled packages (NumPy etc.).
- Regexes are not a parser: even Python-aware, obfuscation can evade the `code.*` rules.

### Running

- PyPI corpus only: `pnpm run test:node -- security-corpus-pypi.test.mjs`
- Regression net after a rules-version bump: `pnpm run test:node -- security-corpus.test.mjs pypi.test.mjs`
- Full pre-commit parity: `pnpm run verify`
