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

## Browser-extension corpus

Browser-extension adapter cases live under `test/fixtures/security-corpus/cases-browser/` and run through `test/security-corpus-browser.test.mjs`. `browser.*` findings carry `BROWSER_RULES_VERSION` (currently `0.14.0`); shared `file.*`, `code.*`, `diff.*`, and `tar.*` findings keep `DETERMINISTIC_RULES_VERSION`.

The initial corpus pins a narrow benign WebExtension and a baseline-backed extension that adds `nativeMessaging`, all-sites host/content-script access, and a credential-looking file. The latter must retain the shared `diff.credential-file-added` result in addition to browser-specific findings. Version `0.2.0` adds a scheme-wide access case for `https://*/*` host/content-script matches and an `https:` script CSP source. Version `0.3.0` adds `browser-csp-default-source`, which pins `default-src` fallback and a bare remote host source. Version `0.4.0` expands privileged-permission coverage to sensitive clipboard, cookie, download, history, and tab APIs. Version `0.5.0` adds bookmarks, geolocation, identity, session, top-sites, navigation, and non-blocking web-request APIs. Version `0.6.0` covers high-impact browser-control, declarative-network, scripting, and response-filter APIs and recognizes Manifest V2 host patterns declared in `optional_permissions`. Version `0.7.0` adds privileged platform, enterprise-key, capture, filesystem, printing, process, system, and WebAuthn-proxy APIs; `browser-privileged-platform-extension` pins representative high-impact permissions and the adapter's table-driven unit test pins the expanded catalog. Version `0.8.0` recognizes the valid slash-only scheme-wide forms (`*://*/`, `https://*/`, and `http://*/`) and evaluates remote sources in `script-src-elem`, `worker-src`, and the `child-src` worker fallback; `browser-slash-only-access-executable-csp` pins the combined bypass regression. Version `0.9.0` recognizes wildcard-host match patterns even when their path is narrower than `/*`, while `browser-scheme-wide-access` and the narrow subdomain control pin the detection boundary. Version `0.10.0` adds the canonical all-file match pattern `file:///*`, pinned by `browser-file-scheme-access`. Version `0.11.0` recognizes wildcard extension/app IDs in `externally_connectable.ids` and adds accessibility-feature, reading-list, and speech-engine permissions to the privileged catalog; `browser-externally-connectable-ids` and `browser-privileged-platform-extension` pin the coverage. Version `0.12.0` treats CSP `'strict-dynamic'` trust delegation as an unsafe executable policy, pinned by `browser-csp-strict-dynamic`. Version `0.13.0` limits that trust-delegation finding to executable script directives; `browser-benign-worker-csp` pins `worker-src` as an ordinary URL source list. Version `0.14.0` limits `'unsafe-eval'` to the effective `script-src` or `default-src` policy; `browser-benign-non-script-unsafe-eval` pins the non-script hard negative. Shared rules version `1.55.0` additionally follows Manifest V3 generated background-page scripts, literal `runtime.getURL()` `importScripts()` arguments, literal DOM navigation (including `runtime.getURL()` values and `self`/`globalThis` window aliases), and packaged HTML navigation elements while keeping raw-text descendants and HTML trailing-solidus lookalikes test-scoped; the browser navigation and HTML namespace fixtures pin those boundaries. Fixtures use synthetic `manifest.json` and `FileRecord` evidence only; URLs and extension ids use `example.invalid`.

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
- dependency and entrypoint package-json diff changes; unusual non-registry dependency specs raise deterministic findings, a newly added runtime dependency raises `dependency.added` and a spec crossing a major version boundary raises `dependency.major-bump` (the release pulls third-party code the scan never inspects — the node-ipc/peacenotwar and event-stream/flatmap-stream vector), and a newly added `bin` command raises `diff.bin-added` because npm links it onto the consumer's install path;
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

- Dependency findings stop at the manifest: an added or major-bumped dependency raises a deterministic finding, but the dependency's own tarball is not fetched or diffed, so a payload hidden inside it is only caught if the reviewer follows the finding to that dependency's own release diff. Within-major version bumps and unanchored specs (dist-tags such as `latest`, `*`, bare `>` ranges) raise nothing because they cannot prove a reviewed-range escape without registry resolution.
- A newly added `bin` command raises `diff.bin-added` (medium), but `main`/`module`/`types`/`exports` retargets are intentionally not flagged: they change on almost every build (`index.js` → `dist/index.js`) and would be noise. They remain visible as the `entrypointsChanged` diff flag. A retarget that points at a path the artifact does not contain is a different question and does fire (`package-json.entrypoint-missing`).
- Files a release stops shipping raise nothing on their own: file rules run over the staged artifact, so a dropped binary is visible only as a removed diff entry unless the manifest still declares it as an entrypoint. A `files` allowlist entry with no matching file is likewise not flagged — allowlist entries are globs whose absence can be legitimate (an optional platform build).
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
  `DETERMINISTIC_RULES_VERSION` (currently `1.55.0`).

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

`1.29.0` lets ecosystem adapters seed consumer entrypoints that live outside
`package.json` semantics. Browser-extension background and content scripts now
participate in shared reachability, so a manifest-loaded script under a path
such as `tests/` cannot receive the test-only capability demotion.

`1.30.0` requires a stable adapter-selected history name before the
history-based `release.source-drift` rule can compare releases. Browser archives
with only a localized or reused display name opt out, preventing unrelated
extensions from being joined into one release-process fingerprint. The Worker
regression matrix in `test/workers/release-fingerprint.test.ts` pins the opt-out.

`1.31.0` expands browser-extension consumer reachability beyond background and
content scripts. Scripts loaded by manifest-declared popups, options pages,
developer-tools pages, sidebars, side panels, and URL overrides now keep full
capability severity even when their packaged path looks test-scoped.

`1.32.0` closes browser-manifest reachability aliases: Chrome-style
root-relative content scripts, Manifest V2 `user_scripts.api_script`, and HTML
script sources containing character references now resolve to their packaged
files before shared `code.*` capability severity is computed. The
`browser-entrypoint-path-aliases` golden case pins all three paths.

`1.33.0` makes browser extension-page reachability parsing quote-aware, so a
greater-than character inside an earlier quoted HTML attribute cannot hide a
later script source and incorrectly apply test-only capability demotion. The
`browser-entrypoint-path-aliases` golden case pins the HTML tokenizer edge, and
the detection eval now consumes the complete browser-extension golden corpus.

`1.34.0` resolves extension-page script URLs against the first HTML `base`
element in effect at the script tag when it remains inside the archive. A packaged script loaded through a
base-relative alias now stays consumer-reachable instead of receiving the
test-only capability demotion; `browser-entrypoint-path-aliases` pins the path.

`1.35.0` follows classic-worker `importScripts()` dependencies and packaged
iframe pages discovered from browser extension pages. The
`browser-entrypoint-path-aliases` golden case pins both reachability edges.

`1.36.0` normalizes root-relative browser background service-worker, script,
and page paths, and follows root-relative ESM imports only for ecosystems that
opt into browser-style URL resolution. The
`browser-root-relative-background-module` golden case pins both edges without
changing npm's filesystem-absolute import semantics.

`1.37.0` strips URL query and fragment components from browser module
specifiers before resolving them to packaged files. The
`browser-root-relative-background-module` golden case pins the qualified import
while npm retains filesystem-style specifier resolution.

`1.38.0` decodes percent-encoded browser resource URL paths before archive
lookup and follows no-substitution template literals in classic-worker
`importScripts()` calls. The `browser-entrypoint-path-aliases` golden case pins
both edges so packaged test-path payloads retain full capability severity.

`1.39.0` normalizes root-relative manifest extension-page paths and follows
literal script paths passed to `tabs.executeScript()`,
`scripting.executeScript()`, and `scripting.registerContentScripts()`. The
`browser-entrypoint-path-aliases` golden case pins the manifest and programmatic
edges so packaged test-path payloads retain full capability severity.

`1.40.0` normalizes manifest-relative `./` resource paths and follows packaged
scripts referenced by static `Worker` or `SharedWorker` constructors, iframe
`srcdoc` documents, Firefox `contentScripts.register()`, user-script
registration or execution methods, and `scripting.updateContentScripts()`. The
`browser-entrypoint-path-aliases` golden case pins the added edges so executable
test-path payloads retain full capability severity.

`1.41.0` recognizes static bracket-notation WebExtension API members and
`new URL(..., import.meta.url)` Worker paths, while classic-worker
`importScripts()` extraction now uses JavaScript tokens so strings, comments,
regular expressions, and unrelated object methods cannot create false
reachability edges. The `browser-entrypoint-path-aliases` golden case pins both
the executable aliases and the inert control.

`1.42.0` preserves percent-encoded URL delimiters when resolving scripts from
browser extension pages and resolves plain `Worker` or `SharedWorker` string
URLs against the owning document base while keeping `import.meta.url` workers
module-relative. The `browser-entrypoint-path-aliases` golden case pins both
paths so executed test-tree payloads retain full capability severity.

`1.43.0` resolves literal WebExtension injection and registration files from
the extension archive root instead of the calling module's directory and
follows packaged HTML documents loaded through `<object data>`. The
`browser-entrypoint-path-aliases` golden case pins both executable paths so
test-tree payloads retain full capability severity.

`1.44.0` preserves the embedding document base when resolving scripts inside
iframe `srcdoc` HTML and recognizes statically qualified WebExtension injection
and Worker APIs through `globalThis`, `self`, or `window`. The
`browser-entrypoint-path-aliases` golden case pins these executable paths so
test-tree payloads retain full capability severity.

`1.45.0` follows packaged HTML and scripts loaded through
`chrome.offscreen.createDocument()`, falls back to an extension page's document
URL when its first `base` URL is invalid, and keeps tag-shaped content inside
`style`, `textarea`, and `title` inert. The `browser-entrypoint-path-aliases`
golden case pins the new executable edges and raw-text hard negatives.

`1.46.0` follows packaged extension pages selected through static action popup,
side-panel, and developer-tools panel APIs, Worker URLs created through a
literal `chrome.runtime.getURL()` or `browser.runtime.getURL()` call, and HTML
documents loaded through `<frame src>` or a refresh `meta` element. The
`browser-entrypoint-path-aliases` golden case pins each executable edge and
keeps lookalike API objects and non-refresh metadata inert.

`1.47.0` treats manifest-declared `sandbox.pages` and packaged extension pages
opened through a literal `tabs.create({ url })` call as consumer-reachable. The
`browser-entrypoint-path-aliases` golden case pins both execution paths so
capabilities hidden under test-shaped directories retain their full severity.

`1.48.0` keeps browser document bases attached to the scripts loaded by those
documents, follows nested WebExtension API calls, packaged pages opened through
`windows.create()`, and HTML loaded through `<embed src>`, and restricts static
option extraction to the API's actual argument and direct object depth. The
`browser-entrypoint-path-aliases` golden case pins the executable paths and the
nested callback-metadata hard negative.

`1.49.0` treats Manifest V2 and V3 `web_accessible_resources` declarations as
consumer entrypoints, including matched wildcard resources and scripts loaded
by exposed HTML. It also follows tags after an abrupt `<!-->` close, requires
exact archive paths for browser URLs instead of applying Node extension or
index fallback, and resolves plain Worker strings only against their owning
document. The `browser-reachability-boundaries` golden case pins the new
positive edges and the extension-fallback and module-relative Worker hard
negatives.

`1.50.0` follows packaged pages selected by `tabs.update()`, recognizes literal
`runtime.getURL()` wrappers in WebExtension resource properties, and checks
direct relative tab navigation and Manifest V2 injection paths against both the
extension root and the owning extension document when one exists. It also gives
Manifest V2 `background.scripts` the extension-root generated-page base used by
plain Worker URLs without applying that document behavior to Manifest V3
service workers. The `browser-generated-background-reachability` golden case
pins the positive edges and dynamic-wrapper hard negative.

`1.51.0` keeps inert template and scripted `noscript` descendants from changing
extension-page reachability, while following inline SVG scripts linked through
`href` or legacy `xlink:href`. The `browser-html-namespace-reachability` golden
case pins the inert base hard negative and both executable SVG edges.

`1.52.0` keeps tag-shaped text inside ordinary HTML attributes inert, follows
packaged HTML selected by extension-page links and browser-supported decimal or
unlabelled meta refresh values, and recognizes the legacy `extension.getURL()`
alias when resolving packaged resources. The
`browser-navigation-alias-reachability` golden case pins all four boundaries so
consumer-executable test-tree payloads retain full capability severity.

`1.53.0` preserves the generated extension-page base for Manifest V3 Firefox
`background.scripts`, recognizes literal `runtime.getURL()` arguments passed to
`importScripts()`, follows literal `location` and `window.open()` navigation, and
follows packaged pages selected by `<area href>`, `<form action>`, or submit-control
`formaction`. The `browser-navigation-runtime-reachability` golden case also pins
the dynamic URL, download link, module-relative background script, and Manifest V3
service-worker hard negatives.

`1.54.0` follows literal `runtime.getURL()` values passed to DOM navigation APIs
and recognizes `self` and `globalThis` as window aliases when an extension-page
document base is present. The `browser-navigation-runtime-reachability` golden
case pins those positive edges while keeping the same expression in a Manifest V3
service worker test-scoped.

`1.55.0` keeps tag-shaped content inside `iframe`, `noembed`, `noframes`, and
`xmp` raw-text elements from creating browser consumer edges and ignores the
trailing solidus on non-void HTML start tags while preserving SVG self-closing
behavior. The `browser-html-namespace-reachability` golden case pins both
precision boundaries.

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
- Browser-extension corpus only: `pnpm run test:node -- security-corpus-browser.test.mjs`
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
