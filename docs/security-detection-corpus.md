# Security detection corpus

Drydock's deterministic findings are the authoritative review signal; AI review stays advisory behind the `ai-review` killswitch and cannot downgrade them. The detection corpus exists to make those findings measurable: every rule change should be checked against small, reviewable package scenarios with explicit expected rule IDs, severities, and risk.

This is a **safe synthetic corpus**, not a malware zoo. It captures techniques observed in npm supply-chain research without vendoring live malicious packages, encrypted malware archives, real credentials, or private artifacts.

## Research basis

The fixture taxonomy is based on the current Drydock rule surface plus public npm malware research:

- [OpenSSF malicious-packages](https://github.com/ossf/malicious-packages) publishes OSV-format reports and explicitly scopes in typosquatting, account takeover, malicious prebuilt binaries, dependency confusion, and manifest confusion. It also warns that telemetry, obfuscation, and protestware need context before they are treated as malicious.
- [OpenSSF Package Analysis](https://github.com/ossf/package-analysis) tracks package behavior by asking what files packages access, what addresses they connect to, and what commands they run. Its public case studies are useful for behavior taxonomy, but Drydock should not execute packages.
- [Datadog's malicious-software-packages-dataset](https://github.com/DataDog/malicious-software-packages-dataset/) is human-triaged and useful for taxonomy validation, but its samples are actively malicious and distributed as encrypted `infected` archives. Do not copy those samples into this repository.
- Recent npm detection benchmark research reports a curated dataset of 6,420 malicious and 7,288 benign npm packages, with 11 behavior categories and 8 evasion categories. The most common behaviors were command execution, data collection, and data exfiltration; install scripts were used by about 72% of malicious packages in that study, and preinstall hooks were the dominant install-time entry point.
- [Aikido's AsyncAPI incident report](https://www.aikido.dev/blog/asyncapi-npm-packages-backdoored-via-github-actions) documents a compromised GitHub Actions publishing path that injected a rotating string-table wrapper around a detached `node -e` child process in shipped JavaScript. The safe `asyncapi-rotating-string-table-dropper` fixture preserves that detection shape without retaining its endpoint, identifier, or payload.
- The same benchmark shows the central detection trade-off: benign and malicious packages often call the same APIs. Broad environment reads and secret-like environment names are capability evidence, while common runtime flags such as `process.env.NODE_ENV` or `import.meta.env.DEV` are not credential sources. Chains such as collect → serialize → exfiltrate are stronger intent evidence.
- Network-only code follows that trade-off: unchanged network-only files are suppressed as package context, added network-only files remain medium-severity contextual evidence, and added network access escalates to high when it is tied to lifecycle scripts, process execution, dynamic evaluation, or credential access.
- Documentation and prose files remain available as package evidence, but deterministic `code.*` rules do not treat them as executable capability evidence. Secret checks in documentation use only high-confidence token formats; generic key/value examples such as `token = localStorage.getItem("token")` are not `file.secret-content` findings. Python packaging metadata (`PKG-INFO`, `*.dist-info/METADATA`) embeds the README long-description and gets the same treatment under the Python pattern set, and URL-with-credentials matches that are doc-style placeholders (`http://user:pass@proxy`, template passwords like `<password>`/`${VAR}`) are excluded from findings everywhere — but weak-word passwords with a non-placeholder username (`svc:secret@db`) still flag, and redaction always applies the broad pattern.
- TypeScript declaration files (`.d.ts`/`.d.cts`/`.d.mts`) keep a diffable text sample but are excluded from `code.*` and `file.secret-content` content scanning (`isTypeDeclarationPath`). Declarations are never executed and carry only type signatures, so scanning large bundled declarations is pure perf/memory cost and a signature like `fetch(url: string)` would only produce false positives. Cheap path-based checks (credential filenames, the files-allowlist) still apply.

## Safety policy

Corpus fixtures must follow the same artifact-retention posture as production scans:

- Use synthetic `FileRecord` JSON, not raw tarballs.
- Use `example.invalid` for URLs.
- Use obviously fake secrets only when testing redaction/secret rules.
- Do not include runnable malware, live C2 endpoints, exploit payloads, encrypted samples, or proprietary package bytes.
- Keep fixtures minimal enough that reviewers can understand why each expected finding exists.

## Fixture format

npm fixtures live under `test/fixtures/security-corpus/cases/*.json` and are evaluated by
`test/security-corpus.test.mjs`. Ecosystem-specific schemas and harnesses are documented below.

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
- credential file-path reads (`.aws/credentials`, `.ssh/id_`, `.netrc`) in addition to broad environment reads and known token names, matching the Python rule coverage while excluding common non-secret JS runtime flags and npm's own lifecycle variables (`npm_command`, `npm_lifecycle_event`, `npm_package_name`, …) — but not `npm_config_*`, which can carry live registry auth such as `npm_config__authToken`;
- the collect-and-exfiltrate sink: a single file that reads credentials and has a network egress path escalates `code.credential-access` to high even on a modified (not newly added) module;
- implicit `node-gyp rebuild` from root `binding.gyp`, GYP command substitution that executes package JavaScript, and native artifact review — by extension and by magic-byte flags, so extensionless Linux/macOS platform binaries are held to the same bar as a Windows `.exe`;
- base64/dynamic evaluation plus network-capable code, including the `WebAssembly.instantiateStreaming(fetch(...))` loader idiom (the whole `compile`/`compileStreaming`/`instantiate`/`instantiateStreaming` family counts as dynamic evaluation) and literal `node -e`/`node --eval` child-process launches;
- javascript-obfuscator-style rotating string tables around code capabilities, recognized from the combined hexadecimal lookup, `while (!![])`, `parseInt`, and `push(shift())` wrapper shape rather than any one minifier-like token;
- secret-looking file addition;
- large opaque binary addition;
- files that appear in the tarball outside a declared `package.json.files` allowlist;
- malformed `package.json` parse failure;
- releases whose manifest declares a `main`/`exports`/`bin` path the artifact does not contain;
- dependency and entrypoint package-json diff changes; unusual non-registry dependency specs raise deterministic findings, a newly added runtime dependency initially raises `dependency.added` (replaced by the terminal dependency-artifact result when that review runs) and a spec crossing a major version boundary raises `dependency.major-bump` (the release pulls third-party code outside the parent artifact — the node-ipc/peacenotwar and event-stream/flatmap-stream vector), and a newly added `bin` command raises `diff.bin-added` because npm links it onto the consumer's install path;
- install-time self-propagation: code a consumer's install executes that invokes a registry publish (`propagation.registry-publish`) or writes into the directory the package manager unpacks dependencies into (`propagation.package-mutation`). Both are ordinary developer actions elsewhere — a release CLI publishes, a patch tool rewrites `node_modules` — so the family gates on install-time reachability rather than on the pattern, with `legit-release-cli-publish` and `legit-patch-tooling-node-modules` as the hard negatives that pin that gate;
- atpm release provenance: unverifiable bundles, subjects copied from another artifact, builds outside the declared trusted publisher, missing attestations, and loss of provenance present on the baseline. A matching verified build is the benign control.

## Rule inventory

The complete deterministic ruleset across all ecosystems. Scoring roles are declared per rule in the
manifest (`DETERMINISTIC_RULES` in `server/lib/review/rules/rule-ids.ts`): `anchor` severities map
straight to risk and set a floor, `capability` rules score by co-occurrence, and a
`weak-lone-capability` de-escalates to low when it fires alone. Standing-danger rules are evidence of
active compromise, so release memory never discounts them as previously-approved context. `pypi.*`
and `vscode.*` rules live in their ecosystem registries (`PYPI_RULE_IDS`, `VSCODE_RULE_IDS`) and
always anchor.

`test/detection-rule-coverage.test.mjs` machine-checks this table against the registries: the rule
IDs must match exactly, every rule needs a corpus fixture asserting it (or an explicit exception in
that test naming the unit-test layer that covers it), and fixtures may only assert registered IDs.

| Rule                                      | Registry      | Scored as            | Standing danger |
| ----------------------------------------- | ------------- | -------------------- | --------------- |
| `atpm.provenance-invalid`                 | deterministic | anchor               | no              |
| `atpm.provenance-missing`                 | deterministic | anchor               | no              |
| `atpm.provenance-publisher-mismatch`      | deterministic | anchor               | no              |
| `atpm.provenance-subject-mismatch`        | deterministic | anchor               | no              |
| `atpm.trusted-publishing-lost`            | deterministic | anchor               | no              |
| `code.credential-access`                  | deterministic | capability           | no              |
| `code.dynamic-evaluation`                 | deterministic | capability           | no              |
| `code.network-access`                     | deterministic | capability           | no              |
| `code.process-execution`                  | deterministic | weak-lone-capability | no              |
| `code.remote-shell`                       | deterministic | capability           | yes             |
| `dependency.added`                        | deterministic | anchor               | no              |
| `dependency.major-bump`                   | deterministic | anchor               | no              |
| `dependency.optional-added`               | deterministic | anchor               | no              |
| `dependency.unusual-spec`                 | deterministic | anchor               | no              |
| `diff.bin-added`                          | deterministic | anchor               | no              |
| `diff.credential-file-added`              | deterministic | anchor               | no              |
| `diff.large-new-file`                     | deterministic | anchor               | no              |
| `file.large-binary`                       | deterministic | anchor               | no              |
| `file.native-artifact`                    | deterministic | anchor               | no              |
| `file.outside-files-list`                 | deterministic | anchor               | no              |
| `file.secret-content`                     | deterministic | anchor               | yes             |
| `install-script.gyp-command-substitution` | deterministic | anchor               | yes             |
| `install-script.implicit-node-gyp`        | deterministic | anchor               | yes             |
| `install-script.lifecycle`                | deterministic | anchor               | yes             |
| `install-script.preinstall`               | deterministic | anchor               | yes             |
| `package-json.entrypoint-missing`         | deterministic | anchor               | no              |
| `package-json.parse-failed`               | deterministic | anchor               | no              |
| `propagation.package-mutation`            | deterministic | anchor               | yes             |
| `propagation.registry-publish`            | deterministic | anchor               | yes             |
| `release.source-drift`                    | deterministic | anchor               | no              |
| `stage.metadata-mismatch`                 | deterministic | anchor               | no              |
| `stage.tarball-digest-mismatch`           | deterministic | anchor               | no              |
| `tar.suspicious-entry`                    | deterministic | anchor               | yes             |
| `pypi.metadata-missing`                   | pypi          | anchor               | no              |
| `pypi.metadata-mismatch`                  | pypi          | anchor               | no              |
| `pypi.native-artifact`                    | pypi          | anchor               | no              |
| `pypi.pth-execution`                      | pypi          | anchor               | no              |
| `pypi.record-mismatch`                    | pypi          | anchor               | no              |
| `pypi.setup-install-command`              | pypi          | anchor               | no              |
| `pypi.startup-hook`                       | pypi          | anchor               | no              |
| `pypi.unusual-dependency`                 | pypi          | anchor               | no              |
| `pypi.wheel-record-missing`               | pypi          | anchor               | no              |
| `vscode.broad-activation`                 | vscode        | anchor               | no              |
| `vscode.extension-dependency`             | vscode        | anchor               | no              |
| `vscode.metadata-mismatch`                | vscode        | anchor               | no              |
| `vscode.startup-remote-command`           | vscode        | anchor               | no              |
| `vscode.startup-wasm-loader`              | vscode        | anchor               | no              |
| `vscode.undeclared-configuration-read`    | vscode        | anchor               | no              |

## Known coverage gaps

The corpus deliberately records some product gaps instead of hiding them:

- Dependency-artifact review covers newly introduced direct npm dependencies, but not their transitive closure or dependencies that only change version. Major bumps still raise the manifest-level deterministic finding without fetching the dependency artifact; within-major version bumps remain visible only in the manifest diff.
- A newly added `bin` command raises `diff.bin-added` (medium), but `main`/`module`/`types`/`exports` retargets are intentionally not flagged: they change on almost every build (`index.js` → `dist/index.js`) and would be noise. They remain visible as the `entrypointsChanged` diff flag. A retarget that points at a path the artifact does not contain is a different question and does fire (`package-json.entrypoint-missing`).
- Files a release stops shipping raise nothing on their own: file rules run over the staged artifact, so a dropped binary is visible only as a removed diff entry unless the manifest still declares it as an entrypoint. A `files` allowlist entry with no matching file is likewise not flagged — allowlist entries are globs whose absence can be legitimate (an optional platform build).
- The propagation family only models the install path. A payload that republishes or rewrites its neighbours when the package is later imported or run — rather than while it is being installed — raises nothing from `propagation.*`, because separating that from ordinary release and patch tooling by pattern alone produced false positives on exactly the tools maintainers depend on. The capability rules still see its process, network, and credential use.
- `propagation.package-mutation` reads a path literal, not a resolved path, so it cannot tell which part of the install root a write lands in: an install hook that writes only into a shared cache directory such as `node_modules/.cache` raises the same finding as one that rewrites a neighbouring package's manifest. The finding is a reviewer signal at `high`, never an automatic rejection, and the evidence line points at the path expression so the distinction is one click away.
- Maintainer/package transfer signals, new publisher signals, package reputation, and OpenSSF/package intelligence integrations are not implemented.
- Behavior-chain detection is regex-based and does not yet prove source-to-sink intent. The one modeled chain is a heuristic: credential access co-located with a network egress path in the same file escalates to high (the collect-and-exfiltrate shape), without proving the value actually flows from the read to the send.
- Anti-analysis and environment-detection patterns are not deeply modeled because Drydock intentionally avoids package execution.

## Adding fixtures

1. Add a new JSON file under `test/fixtures/security-corpus/cases/`.
2. Keep the fixture synthetic and minimal.
3. Add exact expected findings and risk.
4. If the scenario is important but not yet detected, add `coverageGaps` and assert the current diff-only behavior where possible.
5. Run `pnpm run test:node -- security-corpus.test.mjs` before opening the PR.

## Dependency-artifact corpus

Dependency-artifact review scans the bytes of a dependency a release newly introduces, so its fixtures
describe _two_ packages: the parent's manifests, and the artifact each declared dependency resolves to.
They live under `test/fixtures/security-corpus/cases-dependencies/` and are evaluated by
`test/security-corpus-dependencies.test.mjs`. See [`dependency-review.md`](./dependency-review.md) for
the rule family and its severity ladder.

Fields, in addition to the shared `id` / `title` / `category` / `intent`:

- `previousPackageJson` / `stagedPackageJson` — the parent's manifests; their diff drives selection.
- `stagedFiles` — optional parent-artifact records used when selection must prove a declared bundled dependency is actually embedded under `node_modules/`.
- `dependencyArtifacts` — a map of dependency name → `{ version, packageJson, files }`. This stands in
  for the registry and the sandbox, so the corpus exercises selection → assessment → findings with no
  network. Resolution itself is covered by `test/npm-dependency-artifacts.test.mjs` and
  `test/npm-semver.test.mjs`.
- `uninspectableReasons` — dependency name → `DependencyUninspectableReason` for dependencies with no
  entry in `dependencyArtifacts`.
- `expectedDependencies` — per-dependency evidence assertions (declaration kind, resolved version,
  coverage status, install observations, automatic-execution entrypoints).
- `expectedFindings` / `expectedRisk` — as in the npm corpus.
- `expectedRecommendation` — the maintainer-facing verdict label from
  `getReleaseRecommendation`. "Reaches critical" and "cannot be recommended for approval" are two
  different claims, and this pins the second one.

The corpus includes calibration cases that should stay that way:

- `added-dependency-benign-library` — a new dependency with a network capability and no install hook must
  not make a release risky just for being new.
- `added-dependency-native-build` — a package that runs `node-gyp` on install is medium, not blocking;
  otherwise every release adding a native dependency becomes unapprovable and the tier stops meaning
  anything.
- `added-dependency-prebuilt-downloader` — a package that downloads a platform binary during install
  _does_ block, at `high` rather than `critical`. It is the loudest deliberate call in the family and the
  one most likely to be argued with, so it is written down rather than left implicit.
- `added-dependency-integrity-mismatch` pins the fail-closed boundary: inert dependency contents still
  block when their recomputed digest disagrees with what the registry advertised.
- `added-dependency-truncated-install-dropper` pins the two-axis boundary: an unrelated coverage gap is
  reported without erasing critical install behavior already proven by retained bytes.
- `added-dependency-dynamic-skipped-content` and
  `added-dependency-computed-execfile-skipped-content` pin dynamic execution: computed module loads in
  inline lifecycle code and renamed child-process targets make every omitted dependency body a visible
  coverage gap. `added-dependency-aliased-require-skipped-content` also pins renamed ESM
  `createRequire` factories.
- `added-dependency-bundled` pins the opposite boundary: bytes with a loadable child package identity
  genuinely embedded in the reviewed parent artifact are assessed in place rather than replaced with a
  second registry snapshot. `added-dependency-bundled-install-downloader` proves the child's own lifecycle
  manifest is part of that assessment, while `added-dependency-bundled-placeholder` proves an arbitrary
  file under the declared `node_modules` path cannot impersonate that identity and suppress registry
  review. `added-dependency-bundled-mismatched-manifest` pins the adjacent boundary: once a declared
  child manifest exists, an invalid identity must fail in place rather than redirect review to different
  registry bytes. `added-dependency-bundled-ambiguous-install-dropper` proves archive ambiguity does not
  erase stronger behavior already visible in readable child files.

## PyPI corpus

The PyPI adapter (`server/lib/ecosystems/pypi/index.ts`) has its own golden corpus under
`test/fixtures/security-corpus/cases-pypi/`, evaluated by `test/security-corpus-pypi.test.mjs`. It is a
separate harness, not an extension of the npm one, because PyPI findings legitimately carry two rule
versions (see the invariant below).

### Rule families and versions

A PyPI review runs two rule families over the staged artifacts:

- `pypi.*` findings come from `pyPiReleaseFindings` and carry `PYPI_RULES_VERSION` (currently `0.4.0`).
- shared `file.*` / `code.*` / `diff.*` findings come from `deterministicFindings` and carry
  `DETERMINISTIC_RULES_VERSION` (currently `1.47.0`).

The harness asserts this per family: every `pypi.*` finding must equal `PYPI_RULES_VERSION` and every
other finding must equal `DETERMINISTIC_RULES_VERSION`. Bump the relevant constant **and** update the
fixtures in the same PR whenever a rule family's coverage changes (`PYPI_RULES_VERSION` in the adapter,
`DETERMINISTIC_RULES_VERSION` in `review.ts`). The PyPI adapter opts the shared `code.*` rules into
Python-aware matching in `1.6.0` (subprocess/os.system, urllib.request/requests/socket,
exec/`__import__`/base64-decode, os.environ/getpass/keyring) while npm keeps the JavaScript matcher;
the same Python matcher must be used when annotating modified-file findings so release-risk
classification stays consistent for extensionless Python files. `1.6.2` excludes documentation from
shared `code.*` capability findings, narrows JavaScript `fetch` matching to calls rather than class
method declarations, and limits documentation secret-content matches to high-confidence token formats.
`1.7.0` adds a constant-folding normalization pre-pass (`server/lib/review/rules/normalize.ts`) so the
JavaScript `code.*` rules also see runtime-assembled identifiers: string-concatenation chains
(`'chi' + 'ld_process'`), `[...].join('')` array assembly, and literal-keyed computed member access
(`globalThis['re' + 'quire']`) are folded back to their literal form before the regex set runs. A
tokenizer keeps folding out of comments, string bodies, template literals, and regex literals, and both
the raw and folded text are scanned so folding can only add detections, never drop one. `pypi.*` grew
`startup-hook`,
`record-mismatch`, and `unusual-dependency` in `0.2.0`, and
`setup-install-command` was upgraded to fire on the top-level sdist `setup.py` install-time code, not
just `cmdclass`. `1.8.0` adds `install-script.gyp-command-substitution`, a critical npm rule for root
`*.gyp` files whose GYP command expansion (`<!...`) invokes package-local JavaScript such as
`node index.js`; this covers the Miasma / Phantom Gyp install-time bypass while avoiding ordinary
native-addon probes like `node -p` include lookups. `1.11.0` extends the JavaScript
dynamic-evaluation family from `WebAssembly.compile` to the whole
`compile`/`compileStreaming`/`instantiate`/`instantiateStreaming` set, since
`instantiateStreaming(fetch(...))` is the loader idiom packed wasm payloads actually use;
`require.resolve` was evaluated for the same family and rejected — it resolves paths without
executing code and flagged the `legit-require-resolve` benign hard-negative. `1.12.0` replaces the
max-severity risk roll-up in `computeRisk` with weighted multi-signal scoring (issue #193): findings
still emit unchanged, but the `code.*` capability rules now roll up by co-occurrence — a lone
`code.process-execution` de-escalates to low (the `legit-build-childprocess` benign hard-negative),
while two or more distinct capabilities in one release escalate to high. Authoritative rules
(install hooks, secrets, native artifacts, files-list escapes, metadata/dependency rules) keep their
severity as a floor, so every golden case and PyPI case holds its expected risk. `1.13.0` adds
test-path classification with reachability weighting: a `code.*` capability hit in a test-suite file
(`test/`, `tests/`, `__tests__/`, `spec/`, `*.test.*`, `*.spec.*`) that no consumer entrypoint
(`main`/`module`/`browser`/`exports`/`bin`) and no lifecycle script target can statically reach
(the reachability walk seeds from both, so files transitively imported by an install hook count)
is demoted one severity step, marked `testScoped`, and excluded from the capability co-occurrence
escalation (the `test-suite-capabilities` golden case and `legit-test-suite-runner` benign
hard-negative — a test runner whose shipped tests exec, read env, and eval). Findings are
demoted, never dropped: obfuscated matches, lifecycle-reachable files (directly named or
transitively imported by an install hook), entrypoint-reachable files, and
same-file credential→network exfiltration chains all keep full severity. The release-delta annotator
also gained finding-set baselining: when a modified-file finding has no line-level evidence (no
recorded line or no usable text diff), it re-runs the deterministic rules over the baseline files and
classifies the finding as package context when the same rule already fired on the same file in the
baseline; without a baseline counterpart it still fails open to release delta. `1.14.0` closes the
Windows skew in `file.native-artifact`: detection previously relied on file extensions alone
(`.node`/`.dll`/`.so`/`.dylib`/`.exe`/`.wasm`), so a release's `.exe` was flagged while the same
release's extensionless Linux/macOS binaries (`bin/cli-linux-x64`) were invisible. The archive
parsers now magic-byte sniff every body — including content-skipped bodies, whose first 64
decompressed bytes are captured from the discard sink — and record
`native-elf`/`native-macho`/`native-pe`/`native-wasm` flags (`sniffNativeArtifact` in
`server/lib/tar-parser.js`; fat Mach-O is disambiguated from Java class files sharing `0xCAFEBABE`,
and MZ requires the NUL-padded DOS header so prose starting with "MZ" does not match). The rule
fires on extension or flag, and the binary-shaped findings (`file.native-artifact`,
`file.large-binary`, `diff.large-new-file`) now carry the file's sha256 in evidence so a reviewer
can verify the artifact against the registry out of band (the `prebuilt-platform-binaries` golden
case). `1.15.0` models the downloader shape from the AsyncAPI npm compromise without broadening
plain process-execution noise: literal `spawn`/`spawnSync` calls that launch `node -e` or
`node --eval` also emit `code.dynamic-evaluation`, while a code capability inside a recognized
javascript-obfuscator-style rotating string-table wrapper is marked `obfuscated`. The latter reuses
the existing risk rule that keeps a lone hidden process capability at high instead of applying the
benign build-helper de-escalation. The wrapper requires five independent structural signals
(hexadecimal lookup identifiers and function, `while (!![])`, lookup-fed `parseInt`, and bracketed
`push`/`shift`) to avoid treating ordinary minified names or queue rotation as malice. `1.16.0`
allowlists npm's own lifecycle variables (`npm_command`, `npm_execpath`, `npm_lifecycle_event`,
`npm_lifecycle_script`, `npm_node_execpath`, `npm_package_json`, `npm_package_name`,
`npm_package_version`) in the environment-access pre-strip that runs before JavaScript
`code.credential-access` matching: npm exports them onto every lifecycle-script process and they
describe only the npm invocation and the package's own manifest, so reading them was a pure false
positive (observed on dt-clean 1.2.1 and salita 2.0.0). `npm_config_*` is deliberately not
allowlisted because it can carry live registry auth (`npm_config__authToken`). The strip also now
preserves newlines when erasing a match, so a multiline access can no longer shift later findings'
line numbers. `1.17.0` fixes four false-positive classes observed on the benign
requests 2.34.1→2.34.2 public PyPI diff (47 deterministic findings, nearly all noise):
Python packaging metadata (`PKG-INFO`, `*.egg-info/PKG-INFO`, `*.dist-info/METADATA` —
`isPythonMetadataPath`) embeds the README long-description, so under the Python pattern set it is
excluded from `code.*` capability scanning and its secret scan drops to the documentation-strength
high-confidence set (requests' README examples were flagging `code.network-access` and a high
`code.credential-access` "collect-and-exfiltrate" three times over across sdist and wheel metadata);
`file.secret-content` now gets the same unreachable-test-file demotion as the `code.*` rules
(one severity step, `testScoped`, never dropped — requests ships six test-CA/server keys under
`tests/certs/`), but only for material unchanged from the baseline: a secret newly entering a test
tree is a fresh leak (or fresh payload staging) and keeps full severity. Python reachability starts
from every non-test module and follows static imports, so an imported test module also keeps full
severity; and
URL-with-embedded-credentials matches are excluded from `file.secret-content` when they are
doc-style placeholders, in two tiers: structural placeholder passwords (template syntax such as
`<password>`/`${VAR}`/`%VAR%`, `xxx`/`***` masks, canonical fakes like `changeme`) never flag
regardless of the username, while bare weak words (`pass`, `secret`, `token`, `admin`) only count
as placeholders when the username is itself a placeholder word — `user:pass@proxy` (requests'
CVE-2023-32681 changelog entry, the canonical benign hit) skips, but a `svc:secret@db` or
`root:admin@host` connection string is a real weak credential and still flags. Redaction keeps the
broad URL pattern; only the finding side (`FINDING_SECRET_PATTERNS`) narrows. On the PyPI side
(`0.4.0`), safely normalized explicit directory tar records (typeflag 5) are no longer surfaced as
`tar.suspicious-entry`: setuptools always emits them, so unlike `npm pack` output they carry no
provenance signal there (requests alone produced 16 release-delta info findings). Unsafe, absolute,
or Unicode-confusable directory records remain findings, and the remaining
non-regular/suspicious-entry reasons use PyPI wording instead of npm's.
`1.18.0` closes the plain-dependency-addition gap: a newly added runtime or required
peer dependency with an ordinary registry spec raises `dependency.added` (medium), while a peer
marked optional through `peerDependenciesMeta` does not because npm will not install it
automatically. Optionality changes are diffed even when the peer spec stays unchanged: optional to
required raises `dependency.added`, while a spec change that remains optional stays quiet. A
modified spec whose resolvable major version changed
(`4.3.0` → `5.0.0`, `^1` → `^2`) raises `dependency.major-bump` (low), both anchoring the risk roll-up
like the other metadata rules. Findings resolve one-per-key by precedence
(unusual-spec > optional-added > added > major-bump), so a dependency listed in both `dependencies`
and `peerDependencies` — the common pairing — cannot double-flag. The delta rules require a baseline
manifest, gated on baseline-manifest presence rather than its version string (so a prior release that
shipped a version-less manifest cannot switch the next release's checks off): a first-ever publish
diffs every dependency as added, so without a previous release the delta rules stay silent instead of
flooring every first release at medium, while `dependency.optional-added` and `dependency.unusual-spec`
still fire because they describe the staged manifest, not the delta (the
`dependency-first-publish-no-baseline` golden case), except that an unusual spec used only by an
optional peer stays quiet because npm does not install that peer automatically. A key relocated between installing sections
(`dependencies` ↔ `optionalDependencies`) with an unchanged spec is treated as already-shipped code
and raises nothing, but a peer requirement moved into `dependencies` genuinely starts shipping and is a
real addition. A key newly duplicated into another section is not treated as new when it was already
installed (for example, adding a peer declaration beside an unchanged runtime dependency); a peer
that admits a new major still raises `dependency.major-bump`. Because
an `optionalDependencies` entry overrides a same-named `dependencies` entry, adding such an override
compares its spec with the previously effective runtime spec and can raise `dependency.major-bump`.
Major-bump compares the intervals of majors each spec
admits, matching npm's install of the highest published version: widening `^1.0.0` to
`^1.0.0 || ^2.0.0`, to the hyphen range `1.0.0 - 2.0.0`, or to a bare `>=1.0.0` (which admits every
future major) fires, as does a bounded widening to `>=1.0.0 <3.0.0` even when its comparators are
reordered or the set contains redundant lower bounds; a downgrade such as
`^2.0.0` → `^1.0.0` fires because 1.x was never in the reviewed intervals. Disjoint unions retain
their holes, so changing `^1.0.0 || ^3.0.0` to `^2.0.0` also fires. A pure narrowing
(`>=1.0.0` → `^1.0.0`) stays inside the reviewed intervals and raises nothing, and
a no-op `|| ` suffix or an unparseable leading branch cannot suppress the comparison. Upper-only
comparator ranges such as `<=1.9.9` implicitly start at major 0 and participate in the same check.
`1.19.0` splits `code.remote-shell` out of `code.process-execution` and fixes two roll-up defects it
exposed. The capability rules matched the language-level call that _starts_ a subprocess
(`child_process`, `execSync`, `spawn(`) in the same set as the shell _command_ handed to it
(`curl`, `wget`, `nc`), so `execSync('curl … | bash')` scored as a single `code.process-execution` —
the weak-on-its-own capability — and de-escalated the whole release to `low`, which made the workflow
gate recommend approve. Neither network rule could see it either: both model in-language APIs, and a
shell-mediated download never touches one. Shell commands that reach the network
(`curl`/`wget`/`nc`/`netcat`/`/dev/tcp/`/`Invoke-WebRequest`/`DownloadString`) now raise
`code.remote-shell` at high, and the download-and-execute compositions — a fetch piped or
command-substituted into an interpreter (`curl … | bash`, `$(curl …)`, `<(wget …)`), `nc -e`,
`powershell -enc`, `iwr … | iex` — raise it at critical, since no benign release fetches and runs code
it did not ship. A bare shell tool additionally requires an executor in reach — a spawn API in the
same file, or a lifecycle hook pointing at it — because the patterns match a command _string_ and
comments are not stripped before matching, so the most common way an API client documents itself
(`// equivalent to: curl -X POST …`) would otherwise read as a high-severity capability
(`legit-curl-in-doc-comment` benign hard-negative). Download-and-execute is exempt from that
requirement: `curl … | bash` has no benign reading even as an instruction. The rule is excluded from the weak-lone de-escalation and counts as an egress sink for
the same-file credential→network chain, so a token read paired with `curl` is the collect-and-exfiltrate
shape it always was (`shell-download-execute-dropper` and `shell-credential-exfil` golden cases).
Inline interpreters with no network tool (`bash -c`, `sh -c`, `powershell`, `cmd /c`) deliberately stay
inside `code.process-execution`, where a lone capability still de-escalates — ordinary build tooling
runs make targets through a shell (`legit-shell-interpreter-build` benign hard-negative) — and that set
gained `sh`/`zsh`/`ksh`/`dash -c`, `pwsh`, and `cmd /c`, which were previously unmodeled. Because
command strings are language-agnostic, both the JavaScript and Python pattern sets share them, and
`PYTHON_EXECUTION_CAPABILITY_PATTERNS` picks them up so a `setup.py` that shells out to `curl` counts
as install-time execution. Separately, the co-occurrence branch of `computeRisk` returned a flat
`high`, which meant a second capability could _de_-escalate a critical one; co-occurrence is now a
floor combined with the highest capability severity, never a ceiling.
An empty spec is treated
like `*` rather than skipped, and `workspace:`/`catalog:`/`link:`/`portal:` protocols join
`git:`/`https:`/`file:`/`npm:` as unusual specs (they name no published package). Spec parsing lives in
`server/lib/review/dependency-specs.ts`, shared with the UI's dependency diff links: modified rows link
directly only when both specs are exact registry version keys. Ranges render no direct link because
their bounds need not have been published; added dependencies use the package-only route that resolves
a published pair from registry metadata.
`1.22.0` adds `stage.tarball-digest-mismatch` (critical, npm staged publishes): the sandbox now
digests each archive's raw wire bytes and the staged adapter compares that digest against the
`shasum` npm recorded for the stage. The rule exists because the file diff's strongest claim —
"the publisher removed this file" — reads identically whether the publisher removed it or the
download was truncated or substituted; the finding says the whole report describes a different
artifact than the one being released. It is not a package-content rule and has no corpus fixture:
the corpus engine runs over `FileRecord[]` and carries no stage metadata, so coverage lives in
`test/staged-artifact-integrity.test.mjs`, `test/npm-acquire.test.mjs`, `test/scan-pipeline.test.mjs`,
and the `tarball-digest-mismatch` e2e scenario. Verification fails to `unverified` (no finding)
whenever either digest is missing — a registry that reports no `shasum`, or an archive the sandbox
could not digest end to end — or a mismatch cannot be confirmed against a fresh stage record, so
absence of evidence never reads as tampering. When that fresh record is available, it becomes the
canonical metadata snapshot for the rest of the scan.

`1.20.0` adds `package-json.entrypoint-missing`: a release whose manifest declares a `main`,
`exports`, or `bin` path the artifact does not contain. The file diff can only say "this path is
not in the staged tarball", which reads as ordinary content churn until a reviewer notices the
manifest still claims to ship it — the `entrypoint-dropped-from-release` golden case, taken from a
real scan where a wasm binary and the `main` entrypoint left the tarball and no deterministic rule
fired. npm always packs `package.json` and README regardless of the `files` allowlist, so a pack
that ran without its build output produces exactly that shape. Severity is high when the previous
release shipped the path (a regression against a known-good predecessor) and medium when it was
never there (a manifest that has always over-claimed). Only the high variant is release-scoped: a
release that dropped a path its predecessor shipped is this release's defect, while a manifest that
has been stale for at least a release is package context and must not raise release risk on every
rescan.
Resolution follows each field's consumer semantics: npm `main` supports its CommonJS implicit
extensions (`.js`/`.json`/`.node`), directory indexes, and nested package manifests, while `exports`
and `bin` targets must exist exactly as declared. Extensionless single-segment `main` and `bin`
paths are still package-relative paths and are checked. Export arrays stop after the first valid
target, condition keys after `default` are unreachable, and subpath patterns (`./*`), folder
mappings (`"./compat/": "./compat/"`), protocol specifiers (`node:fs`, `https://…`), package imports
(`#dep`), invalid bare export targets, and `null` export blocks are skipped entirely — a target that
names a directory rather than a file still consumes its fallback-array slot. Each ecosystem opts
into a resolution mode explicitly and there is no default: the VS Code adapter selects its own
`.js`/`.mjs`/`.cjs` entrypoint resolution rather than inheriting npm's rules, and PyPI selects none,
so a Python sdist that bundles JS assets under a root `package.json` is never held to npm's
`require()` semantics. `module`, `types`, and npm's `browser` field are excluded, as are the
`types`/`typings` conditions inside `exports`: they are tooling fields resolved by a type checker,
whose targets are legitimately optional, unlike the paths a consumer's `require()` and npm's own bin
linking resolve. The `legit-entrypoint-resolution` benign hard-negative carries every shape that
resolves without matching literally (directory-index `main`, `./`-prefixed `bin`, export fallback
array) alongside every shape that cannot be reduced to a file. Four existing fixtures
(`npm-config-auth-token-read`, `npm-lifecycle-env-read`, `obfuscated-dynamic-fetch`,
`wasm-instantiate-loader`) declared `main: index.js` without shipping it — an artifact of minimal
synthetic fixtures rather than an intended signal — and now carry an unchanged `index.js` on both
sides so they model a package that could actually load.

`1.21.0` completes npm's CommonJS `main` resolution with Node's final package-root
`index.js`/`index.json`/`index.node` fallback. A release that removes its declared `main` but still
ships one of those root indexes remains loadable (with Node's invalid-main deprecation warning), so
`package-json.entrypoint-missing` no longer raises a high release finding for that shape. The
`legit-main-root-index-fallback` benign hard-negative locks down the regression. This release also
preserves the string-form `browser` field through staged npm metadata parsing and manifest merging,
so browser-only entrypoint changes reach package-json diffing and AI reviewer selection.

`1.23.0` adds the history-based release-process fingerprint rules `release.burst-anomaly` and
`release.source-drift` (see [`release-fingerprint.md`](./release-fingerprint.md)). They compare a scan
against the organization's D1 scan history rather than package bytes, so they have no corpus fixtures —
their matrix lives in `test/release-fingerprint.test.ts` and
`test/workers/release-fingerprint.test.ts`.

`1.24.0` removes `release.burst-anomaly`. Its trigger (≥ 5 distinct packages staged inside 30 minutes,
never seen before in 180 days) is indistinguishable from a monorepo release train, and because
`release.*` findings are release-scoped it turned that train's gate recommendation into `rejected`.
`release.source-drift` is unchanged. See [`release-fingerprint.md`](./release-fingerprint.md) for the
conditions any revived burst rule would have to meet.

`1.28.0` adds the atpm provenance rule family: `atpm.provenance-invalid`,
`atpm.provenance-subject-mismatch`, `atpm.provenance-publisher-mismatch`,
`atpm.provenance-missing`, and `atpm.trusted-publishing-lost`. The golden cases under
`test/fixtures/security-corpus/cases-atpm/` pin each rule's severity and risk, plus a matching verified
build that must stay quiet; the detection eval consumes the same cases through the production
`atpmRecordFindings` path.

`1.29.0` adds the `parser-differential` evidence kind to `tar.suspicious-entry` (high) and aligns the
tar reader with node-tar, the reader `npm install` extracts with. Each shape below let an archive show
review one set of files and hand npm another; the evidence names which one was found.

- **End-of-archive marker.** The marker is two consecutive all-zero blocks; the reader stopped at the
  first, so entries placed after a lone zero block were invisible while npm read past it and installed
  them. The reader now ends only on the second consecutive zero block.
- **Header checksums** are validated with node-tar's formula. node-tar skips a block whose checksum
  fails _without consuming its declared body_, then reads that body as further headers, so trusting
  one put the two readers on different block boundaries for the rest of the archive. Such a block is
  now skipped the same way and reported.
- **PAX `size`** (local and global) overrides the ustar header's size for node-tar, and now here, so
  an archive can no longer declare one body length to review and another to npm.
- **Extended-header handling** matches node-tar: `X` is read like `x`, `N` like `L`, `K` is metadata
  rather than an entry, a global header no longer clears a pending local one (only its `path` and
  `linkpath` are ignored), records are parsed line-by-line with a mis-declared length costing only
  that line, and a metadata entry over node-tar's 1 MiB limit is ignored rather than applied.
- **Typeflag `7`** (contiguous file) is read as the regular file node-tar extracts, and a `0`/NUL entry
  whose name ends in `/` as the directory node-tar coerces it to.
- **Paths**: `.` segments are collapsed rather than rejected; the ustar prefix is read only when the
  ustar magic is present, with node-tar's 130/155-byte split, and is not prepended to an extended-header
  path (node-tar replaces the prefixed path with that one, so prepending it reported a nested path for
  a file npm writes at the package root); and the `package/` root prefix is stripped only when it is
  the first component. A regular entry whose path is still not representable — traversal, drive letter,
  backslash separator, over-long — is now reported instead of silently dropped.

`1.30.0` closes the disagreements found by checking `1.29.0` against node-tar 7.5.15 (and the
adversarial re-check of that fix). Most still hid content the same way: a header one reader skips
without consuming its body and the other reads as an entry, so the declared body holds the entries
only npm installs.

- **Base-256 numeric fields.** node-tar decodes a numeric header field whose first byte has the high
  bit set as base-256, and a prefix other than `0x80`/`0xff` or a value outside the safe-integer range
  throws out of the header decode, so the block is skipped like a checksum failure. That covers mode,
  uid, gid, and mtime; devmaj and devmin under the ustar magic; and atime and ctime when byte 475 is
  NUL. A field is not decoded when a PAX record (local or global) overrides it — but only for the keys
  node-tar's `Pax` record carries (uid, gid, mtime, atime, ctime); a `mode=` or `devmaj=` record
  changes nothing. Such a header is now rejected the same way and reported.
- **PAX records without `=`.** node-tar keeps a bare `size` as an empty value, which reads as a
  zero-length body; the record was dropped here and the header's own size trusted, so the declared
  body could hold the entries npm went on to install. A bare `path` likewise makes node-tar reject
  every following header. Both now match.
- **String fields are cut the way node-tar cuts them**: `/\0.*/` without the `s` flag, so text after
  a newline that follows the NUL survives. Stopping at the first NUL saw an empty name where node-tar
  saw `\nx` (rejecting a header npm accepts) and an empty linkname where node-tar saw one (accepting a
  header npm rejects) — each a block-boundary split.
- **Numeric PAX `path`** rejects a header only for typeflag `0`/NUL, where node-tar's decode calls
  `.slice` on the Number; a metadata or non-regular header under a pending numeric path is read
  normally, so a later `x` record can replace the path and name the file npm installs. `path=0` is the
  falsy Number 0 to node-tar and rejects every header until a prefix turns it into a string. Only a
  PAX record's value is coerced: a GNU `L`/`N` long name of the same digits stays the string node-tar
  keeps, and a zero-length `L` never enters node-tar's meta state, so it changes nothing.
- **A leading UTF-8 BOM is kept**, as node-tar's `Buffer` decode keeps it and `TextDecoder` by
  default does not: a BOM-only name is a truthy path (accepted, body consumed), a BOM-only linkname
  on a regular file rejects the header, and a BOM in front of a PAX body makes node-tar drop the
  first record rather than apply it.
- **Null blocks.** node-tar's null block is zero everywhere outside the checksum field with a
  checksum that does not parse, not only an all-zero block; two blocks with spaces in that field end
  the archive for npm but were rejected here as bad headers, reporting the entries after them as
  files npm never writes.
- **Ustar prefix with byte 475 set** is prepended unconditionally by node-tar, so an empty prefix
  still yields `/` + name: an empty name is the truthy path `/` (accepted, body consumed) and
  `/package/x` sits one level down for npm's `strip: 1`, which is where it is reported now. An empty
  PAX `path=` under a prefix is likewise an entry node-tar reads and drops in unpack rather than a
  rejected header, so its body is consumed as npm does.

- **Root stripping follows the consumer, not the archive.** The caller names the strip depth its
  ecosystem's consumer extracts with, because the recorded path has to be the path that consumer
  installs. npm and atpm ask for `strip1` — node-tar's `strip: 1`, which drops the first path
  component whatever it is called — so a tarball rooted at `dist/` reports the files npm writes at
  the package root, two roots that collapse onto one installed path raise a `duplicate` finding
  instead of reading as two distinct files, and a first component of `..` or `C:` is consumed by the
  strip exactly as node-tar consumes it (node-tar applies `strip` before its own `..` and
  absolute-path checks, so `../x` is written and `package/../x` is refused). The strip is
  unconditional: an entry with no directory component leaves no path and npm installs no file for
  it, so it is disclosed as a `parser-differential` entry rather than recorded under its own name —
  recording it would let a top-level decoy collide with, and last-write-wins over, the stripped
  entry whose bytes npm installs at that path. PyPI asks for `keep`: an sdist's `<name>-<version>/`
  root is real to pip, and `preparePyPiArtifact` strips the common root afterwards while treating
  entries outside it as evidence.

Readers still genuinely disagree about a lone zero block (pip's CPython `tarfile` and GNU tar stop at
the first one; node-tar does not), so on the PyPI side these findings report a hand-crafted archive
whose entries pip may not extract rather than content hidden from review. Two divergences from npm
remain, both by design and neither of which lets an archive hide content: a backslash path is
reported as a finding rather than recorded as a file (it is a separator on Windows and an ordinary
character on POSIX, so no one path is right for both); and `.gitignore` is reported under its
archive name rather than the `.npmignore` pacote renames it to on extract, which is a fetcher
behavior rather than an archive one.

One parse still cannot name a consumer: a workflow-gate bundle's `.tgz`/`.tar.gz` is claimed by both
npm and PyPI on filename alone, so the ecosystem is decided from the parsed contents. That parse
strips a literal `package/` only — the one behavior that can answer for both, since it surfaces an
npm root manifest while leaving a PyPI sdist root intact. An npm tarball rooted at any other name
therefore carries no root manifest there and the gate rejects it as unrecognizable rather than
reviewing it one level too deep.

`1.31.0` adds the `propagation.*` family: `propagation.registry-publish` (critical) and
`propagation.package-mutation` (high), both standing dangers. They answer a question the other
families do not — can this release put itself into the _next_ artifact — and both gate on
`installReachablePaths` (`server/lib/review/rules/reachability.ts`), the subset of consumer-reachable
files an install actually executes: npm lifecycle-hook targets and their transitive requires, or an
sdist's top-level `setup.py` and its imports. Direct npm lifecycle command bodies are scanned too,
while comment-only command examples and import-only publishing-library references stay quiet. The
release-delta projection reuses the same propagation pattern sets so a first match on an unchanged
line cannot hide a newly added propagation action from release risk. Pinned by
`install-hook-registry-publish`, `install-hook-direct-registry-publish`,
`install-hook-node-modules-write`, the PyPI parity case `15-sdist-setup-twine-upload`, the frontier
case `npm-install-hook-worm-propagation`, and the two hard negatives that hold the gate honest.

`1.32.0` adds bounded dependency-artifact review for newly introduced npm dependencies. The
`dependency-artifact.*` family records install-time execution and capabilities, uninspectable coverage
gaps, and a critical `dependency-artifact.integrity-mismatch` when fetched bytes disagree with the
registry's advertised digest. Fixtures under `cases-dependencies/` pin the severity ladder, including
benign-library and native-build calibration cases and the integrity-mismatch fail-closed boundary.

`1.32.0` hardens dependency-artifact coverage: clipped dependency files fail visibly instead of being
assessed from a retained prefix, baseline acquisition gaps conservatively inspect staged install
dependencies, anonymous range/tag resolution bypasses stale metadata caches, the wall-clock budget
includes registry lookup, and dependencies already embedded through npm's bundled-dependency fields
stay within the parent artifact review. The bundled calibration fixture and focused invariant tests pin
those boundaries.

`1.33.0` closes two more dependency-artifact completeness gaps. Files retained hash-only after the
sandbox's full-text body budget now make the dependency visibly uninspectable, pinned by
`added-dependency-skipped-content`; an expired pass also aborts anonymous registry reads and prevents a
late metadata response from starting a tarball parse. The bounded npm range resolver now follows npm's
strict major-wildcard behavior and SemVer's ASCII prerelease ordering so the reviewed version matches
the version a consumer install selects.

`1.34.0` preserves the critical dependency integrity signal even when the same artifact is also
uninspectable, pinned by `added-dependency-truncated-integrity-mismatch`. It also treats a required peer
that npm 7+ already auto-installed as previously installed when the staged release duplicates or moves
it under `dependencies`, pinned by `required-peer-runtime-relocation` and the
`legit-required-peer-runtime-relocation` eval hard-negative. Optional peers remain excluded from that
calibration because consumers do not inherit them automatically.

`1.35.0` closes dependency-artifact completeness and attribution gaps. A missing or unreadable root
manifest and active non-regular, duplicate, or visually-confusable archive paths now fail visibly rather
than producing a clean inspected record, pinned by `added-dependency-invalid-artifacts`. Inline lifecycle
commands are scanned separately from the rest of `package.json`, so network-capable test tooling is no
longer presented as a proven install-time request; `added-dependency-non-install-network-script` pins the
unproven medium tier while the existing install-downloader fixtures keep proven paths blocking.

`1.36.0` closes dependency-selection and install-reachability gaps. Required peers moved to a different
runtime spec are reviewed as new bytes, while an optional peer becoming required at an already-installed
runtime spec stays a declaration-only change. Install hooks delegated through `npm run` now carry file and
inline capabilities into the install-reachable set, and npm comparator whitespace resolves through the
same bounded range parser. The required-peer transition, spec-change, and delegated-downloader fixtures
pin these boundaries.

`1.37.0` closes the remaining same-name dependency-review bypasses and integrity false positive. An
optional override or installing-section relocation suppresses review only when its effective spec is
unchanged; a newly required peer is likewise covered only by a same-spec runtime declaration. npm config
flags around `npm run` can no longer hide a delegated install downloader, and a multi-hash SRI verifies
when any advertised SHA-512 digest matches the reviewed bytes. The optional-override, different-spec peer,
and flagged delegated-downloader dependency fixtures pin the gate-facing semantics; the SRI list behavior
is pinned at the registry-resolution layer.

`1.38.0` closes a dependency-artifact completeness gap and aligns the gate and report with the precise
review result. A minified JavaScript file or source map whose text the parser deliberately omits now
fails visibly when an install hook can reach it, pinned by
`added-dependency-install-skipped-content`; unrelated omitted assets remain valid hard negatives. Once a
dependency has a terminal inspected or uninspectable record, that evidence replaces the older
declaration-only `dependency.added` / `dependency.optional-added` finding, so a dependency with no observed
install behavior can remain low risk. Finding projection and the report UI share one install-risk policy
mapping, keeping their severity and claims aligned.

`1.39.0` closes registry-resolution and dependency-evidence trust gaps. Published versions and ranges
with non-canonical or unsafe numeric identifiers are rejected instead of selecting bytes npm ignores;
a missing staged package name or version is treated as a baseline acquisition gap rather than a genuine
first release; and an unsupported or malformed `dist.integrity` cannot fall through to a matching legacy
SHA-1 shasum. A lifecycle path that reaches both a process launch and a bundled native artifact is now a
proven high-risk install path with native-specific finding and report copy, pinned by
`added-dependency-native-execution`.

`1.40.0` aligns dependency evidence with npm's install selection and closes two release-risk bypasses.
Range resolution skips a deprecated `latest` while a healthy satisfying version exists and its
synchronous parser now caps spec length, union branches, and comparator tokens. A declared bundle is
excluded only when the embedded direct child has a readable matching package identity, pinned by
`added-dependency-bundled-placeholder`. Dependency-artifact findings remain release-scoped when baseline
acquisition failed, so an honest `unknown` file diff cannot remove newly introduced dependency evidence
from `releaseRisk` or the workflow gate.

`1.41.0` closes two executable-content gaps in dependency review. Newly introduced direct dependencies
embedded through `bundleDependencies` / `bundledDependencies` are now assessed from the exact child
subtree consumers install, including the child's own lifecycle manifest, rather than being treated as
covered by root-manifest review. Install-reachable dynamic module loads also make omitted executable
`.map` / minified JavaScript text fail visibly instead of recording partial bytes as inspected. The
`added-dependency-bundled-install-downloader` fixture and focused skipped-text regressions pin both
boundaries.

`1.40.0` separates dependency coverage, install execution, and risk observations from gate policy.
Unproven static reach is now recorded as `unknown` instead of an install-risk verdict, aggregate review
coverage is partial whenever any selected dependency is uninspectable, and a computed install-time module
load treats every omitted body as a possible target regardless of extension. The
`added-dependency-dynamic-skipped-content` fixture pins the widened fail-visible boundary.

`1.41.0` closes three durable dependency-evidence trust gaps. Registry projection preserves the presence
of an oversized authoritative SRI so it cannot silently fall through to a matching legacy SHA-1; adapter
evidence is secret-redacted before finding projection or persistence; and suspicious archive entries
inside bundled child subtrees now make those dependencies visibly uninspectable. The existing
`added-dependency-integrity-mismatch` and bundled-dependency corpus cases continue to pin the rule family,
with focused registry, pipeline, and bundled-artifact regressions covering the new acquisition boundaries.

`1.42.0` closes install-reachability gaps in dependency evidence. Active explicit and implicit node-gyp
builds now seed root GYP files plus package paths named by their commands, so an omitted install-time
script makes the artifact visibly incomplete and a reachable capability keeps its observed certainty.
Dynamic `module.require()` and optional CommonJS calls receive the same omitted-body treatment as bare
`require()`, while a dormant GYP command with `gypfile: false` no longer invents automatic execution.
`added-dependency-node-gyp-skipped-content`, `added-dependency-module-require-skipped-content`, and
`added-dependency-dormant-gyp` pin the two fail-visible boundaries and the false-positive calibration.

`1.43.0` keeps dependency evidence bound to the bytes consumers install. A declared bundled child whose
manifest body was retained hash-only now fails visibly as embedded evidence instead of being replaced by
registry bytes, computed `module["require"]()` calls close the same omitted-body boundary as dot-member
loaders, and a lifecycle path that directly invokes or loads a bundled native artifact is high risk
without requiring an unrelated second process API call. npm wildcard ranges with prerelease suffixes no
longer select prerelease bytes npm excludes. `added-dependency-bundled-skipped-manifest`,
`added-dependency-module-require-skipped-content`, and `added-dependency-direct-native-execution` pin the
gate-facing changes; focused semver tests pin version-selection parity.

`1.44.0` closes two more install-reachability gaps for omitted dependency bodies. Statically named local
targets passed to child-process execution APIs or shell `source` commands now join the install graph, and
simple aliases of `require` or `createRequire(...)` fail visibly when an omitted body could be their
target. `added-dependency-execfile-skipped-content` and
`added-dependency-aliased-require-skipped-content` pin these completeness boundaries.

`1.45.0` keeps partial dependency evidence fail-closed without erasing stronger retained-byte signals.
Known install risk survives unrelated truncation, computed or aliased child-process and shell targets make
omitted bodies visible, and omitted-only record counts still project an aggregate coverage gap. Alias
propagation is bounded by a linear worklist, exact/range declarations cannot be reinterpreted through
registry-controlled tag keys, and malformed persisted rows reject the review as a unit.
`added-dependency-truncated-install-dropper` and
`added-dependency-computed-execfile-skipped-content` pin the gate-facing coverage changes.

`1.46.0` keeps dependency evidence attached to the code consumers actually receive across additional
manifest, lifecycle, and archive edges. Malformed or mismatched bundled child manifests now remain
embedded coverage gaps instead of redirecting review to registry bytes; computed loads inside inline
Node lifecycle commands and renamed CommonJS/ESM child-process bindings make omitted bodies visible; and
archive ambiguity no longer erases behavior proven by readable files. npm's `v1` and `v1.2` partial
forms also remain range declarations even when a registry advertises same-named tags.
`added-dependency-bundled-mismatched-manifest`, `added-dependency-dynamic-skipped-content`,
`added-dependency-computed-execfile-skipped-content`, and
`added-dependency-bundled-ambiguous-install-dropper` pin the gate-facing changes.

`1.47.0` aligns static install reachability with the loader and process forms the completeness detector
already recognizes. Optional, bracketed, template-literal, and import-attributes module loads now keep
their named omitted targets visible; renamed ESM `createRequire` factories remain conservative dynamic
loaders; and `fork()` targets plus relative scripts passed in a Node interpreter argv join the install
graph. Computed Node argv remains fail-closed.

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

## atpm corpus

The atpm provenance rules have a golden corpus under
`test/fixtures/security-corpus/cases-atpm/`, evaluated by
`test/security-corpus-atpm.test.mjs`. The fixtures are record projections rather than package files
because the signals compare verified provenance, downloaded archive digests, and the publisher's
trusted-publishing declaration. `test/helpers/atpm-security-corpus.mjs` feeds those projections through
the production `atpmRecordFindings` path and rolls their findings up with `computeRisk()`.

Required fields are `id`, `title`, `category`, `intent`, `expectedRisk`, and exact
`expectedFindings[{ ruleId, severity, file }]`. Optional inputs mirror the finding function:
`target`, `manifest`, `archiveSha1`, `archiveSha512`, `recordName`, `trustPublisher`, `baseline`, and
`baselineArchiveSha512`. Keep all identities, repositories, digests, and timestamps synthetic.

Run the atpm corpus alone with:

```sh
pnpm test -- test/security-corpus-atpm.test.mjs --project node
```
