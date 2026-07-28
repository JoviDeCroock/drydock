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
- credential file-path reads (`.aws/credentials`, `.ssh/id_`, `.netrc`) in addition to broad environment reads and known token names, matching the Python rule coverage while excluding common non-secret JS runtime flags and npm's own lifecycle variables (`npm_command`, `npm_lifecycle_event`, `npm_package_name`, …) — but not `npm_config_*`, which can carry live registry auth such as `npm_config__authToken`;
- the collect-and-exfiltrate sink: a single file that reads credentials and has a network egress path escalates `code.credential-access` to high even on a modified (not newly added) module;
- implicit `node-gyp rebuild` from root `binding.gyp`, GYP command substitution that executes package JavaScript, and native artifact review — by extension and by magic-byte flags, so extensionless Linux/macOS platform binaries are held to the same bar as a Windows `.exe`;
- base64/dynamic evaluation plus network-capable code, including the `WebAssembly.instantiateStreaming(fetch(...))` loader idiom (the whole `compile`/`compileStreaming`/`instantiate`/`instantiateStreaming` family counts as dynamic evaluation) and literal `node -e`/`node --eval` child-process launches;
- javascript-obfuscator-style rotating string tables around code capabilities, recognized from the combined hexadecimal lookup, `while (!![])`, `parseInt`, and `push(shift())` wrapper shape rather than any one minifier-like token;
- secret-looking file addition;
- large opaque binary addition;
- files that appear in the tarball outside a declared `package.json.files` allowlist;
- malformed `package.json` parse failure;
- dependency and entrypoint package-json diff changes; unusual non-registry dependency specs raise deterministic findings, a newly added runtime dependency raises `dependency.added` and a spec crossing a major version boundary raises `dependency.major-bump` (the release pulls third-party code the scan never inspects — the node-ipc/peacenotwar and event-stream/flatmap-stream vector), and a newly added `bin` command raises `diff.bin-added` because npm links it onto the consumer's install path;

## Known coverage gaps

The corpus deliberately records some product gaps instead of hiding them:

- Dependency findings stop at the manifest: an added or major-bumped dependency raises a deterministic finding, but the dependency's own tarball is not fetched or diffed, so a payload hidden inside it is only caught if the reviewer follows the finding to that dependency's own release diff. Within-major version bumps and unanchored specs (dist-tags such as `latest`, `*`, bare `>` ranges) raise nothing because they cannot prove a reviewed-range escape without registry resolution.
- A newly added `bin` command raises `diff.bin-added` (medium), but `main`/`module`/`types`/`exports` retargets are intentionally not flagged: they change on almost every build (`index.js` → `dist/index.js`) and would be noise. They remain visible as the `entrypointsChanged` diff flag.
- Maintainer/package transfer signals, new publisher signals, package reputation, and OpenSSF/package intelligence integrations are not implemented.
- Behavior-chain detection is regex-based and does not yet prove source-to-sink intent. The one modeled chain is a heuristic: credential access co-located with a network egress path in the same file escalates to high (the collect-and-exfiltrate shape), without proving the value actually flows from the read to the send.
- Anti-analysis and environment-detection patterns are not deeply modeled because Drydock intentionally avoids package execution.

## Adding fixtures

1. Add a new JSON file under `test/fixtures/security-corpus/cases/`.
2. Keep the fixture synthetic and minimal.
3. Add exact expected findings and risk.
4. If the scenario is important but not yet detected, add `coverageGaps` and assert the current diff-only behavior where possible.
5. Run `pnpm run test:node -- security-corpus.test.mjs` before opening the PR.

## PyPI corpus

The PyPI adapter (`server/lib/ecosystems/pypi/index.ts`) has its own golden corpus under
`test/fixtures/security-corpus/cases-pypi/`, evaluated by `test/security-corpus-pypi.test.mjs`. It is a
separate harness, not an extension of the npm one, because PyPI findings legitimately carry two rule
versions (see the invariant below).

### Rule families and versions

A PyPI review runs two rule families over the staged artifacts:

- `pypi.*` findings come from `pyPiReleaseFindings` and carry `PYPI_RULES_VERSION` (currently `0.4.0`).
- shared `file.*` / `code.*` / `diff.*` findings come from `deterministicFindings` and carry
  `DETERMINISTIC_RULES_VERSION` (currently `1.18.0`).

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
escalation (the `test-suite-capabilities` golden case and `legit-test-suite-tape` benign
hard-negative — a tape-shaped test runner whose shipped tests exec, read env, and eval). Findings are
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
