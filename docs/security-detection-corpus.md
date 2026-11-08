# Security detection corpus

Small synthetic package scenarios with exact expected rule IDs, severities, and risk that pin every deterministic rule. **Authority:** enforced (deterministic findings are the authoritative review signal; AI review is advisory behind the `ai-review` killswitch and AI cannot downgrade deterministic findings). **Owner:** `server/lib/review/rules/index.ts`.

Rule-version history: [`detection-rule-history.md`](./detection-rule-history.md). Aggregate quality metrics: [`detection-eval.md`](./detection-eval.md).

## At a glance

| Corpus | Ecosystem | Engine path | Pinned by |
| --- | --- | --- | --- |
| `test/fixtures/security-corpus/cases/` | npm | `deterministicFindings` + `computeRisk` (`server/lib/review/index.ts`) | `test/security-corpus.test.mjs` |
| `test/fixtures/security-corpus/cases-pypi/` | PyPI | `server/lib/ecosystems/pypi/index.ts` (`pyPiReleaseFindings` + shared rules) | `test/security-corpus-pypi.test.mjs` (oracle for paths: `test/pypi.test.mjs`) |
| `test/fixtures/security-corpus/cases-atpm/` | atpm | `atpmRecordFindings` via `test/helpers/atpm-security-corpus.mjs` | `test/security-corpus-atpm.test.mjs` |
| `test/fixtures/security-corpus/cases-vscode/` | VS Code | `createVscodeExtensionReview` | `test/security-corpus-vscode.test.mjs` |
| `test/fixtures/security-corpus/cases-provenance/` | npm + PyPI | registry readers + lineage + `provenanceContinuityFindings` via `test/helpers/provenance-security-corpus.mjs` | `test/security-corpus-provenance.test.mjs` |
| `cases-frontier/`, `cases-benign/` | all | eval only, never golden | `test/eval/detection-eval.test.mjs` ([`detection-eval.md`](./detection-eval.md)) |
| npm/PyPI `parityGroup` pairs | npm + PyPI | both engines; sorted `ruleId:severity` multisets must match | `test/security-corpus-parity.test.mjs` (see `test/fixtures/security-corpus/README.md`) |
| registry ↔ fixtures ↔ inventory | all | `DETERMINISTIC_RULES`, `PYPI_RULE_IDS`, `VSCODE_RULE_IDS` | `test/detection-rule-coverage.test.mjs` |

## Safety policy

1. Fixtures are synthetic `FileRecord` JSON, never raw tarballs.
2. URLs use `example.invalid`.
3. Secrets are obviously fake and only appear when testing redaction/secret rules.
4. No runnable malware, live C2 endpoints, exploit payloads, encrypted samples (for example Datadog's `infected` archives), or proprietary package bytes.
5. Each fixture is minimal enough that a reviewer sees why every expected finding exists.
6. Drydock never executes packages; anti-analysis and environment-detection behavior is therefore not modeled.

## Contract

### npm fixture (`cases/*.json`)

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Stable fixture identifier. |
| `title` | yes | Human-readable scenario. |
| `category` | yes | Taxonomy bucket (eval uses it as `threatClass`). |
| `intent` | yes | Behavior the fixture protects. |
| `stagedFiles` | yes | Sandbox-shaped `FileRecord[]` for the staged package. |
| `expectedRisk` | yes | Deterministic risk from `computeRisk()`. |
| `expectedFindings` | yes | Exact `{ ruleId, severity, file }` entries. |
| `previousFiles` | no | Previous-version `FileRecord[]`; defaults to empty. |
| `previousPackageJson` / `stagedPackageJson` | no | Manifest summaries for package-json diff and manifest review. |
| `expectedPackageJsonDiff` | no | Assertions for diff-only signals. |
| `expectedReleaseRisk` / `expectedReleaseFindings` | no | Exact release-attribution assertions after diff annotation; artifact risk/findings stay asserted separately. |
| `coverageGaps` | no | Signals present but not yet promoted to findings (documented, not asserted). |
| `parityGroup` / `parityIgnoreRuleIds` | no | Cross-corpus parity pairing. |

### PyPI fixture (`cases-pypi/*.json`)

| Field | Required | Meaning |
| --- | --- | --- |
| `id`, `title`, `category`, `intent` | yes | Metadata. |
| `manifest` | yes | Parsed by `parsePyPiReleaseManifest`: schema `drydock.release-artifacts.v1`, ecosystem `pypi`, `package`, `version`, `artifacts[{path, sha256 (64 hex), url?}]`. |
| `artifacts` | yes | `[{path, files: FileRecord[]}]`; paths must exactly match the manifest's or `assertManifestArtifactSet` throws. |
| `expectedRisk`, `expectedFindings` | yes | As npm. |
| `previousArtifacts` | no | Previous `[{path, files}]`; enables `diff.*` findings. |
| `artifacts[].suspiciousEntries` | no | Archive-reader disclosures `{kind, path, detail, archive?}` become `tar.suspicious-entry` at `<artifact path>/<entry path>`. |
| `coverageGaps` | no | Documented blind spots (not asserted). |

`FileRecord = {path, size, sha256, flags[], textSample?}`. A wheel fixture includes `*.dist-info/WHEEL` with a `Tag:` header so the diff namespace is deterministic. Binary artifacts use `flags: ["binary"]` and omit `textSample`.

### PyPI `expectedFindings[].file` namespacing

The most error-prone part of PyPI fixtures; one file can fire under both schemes, so list both tuples.

| Scheme | Applies to | Path formula | Examples |
| --- | --- | --- | --- |
| A | `pypi.*` | `namespacedPath(artifactPath, rawFilePath)`: literal manifest artifact path + `/` + in-archive path; sdists root-stripped first; `.dist-info` not normalized | `dist/demo_package-1.2.0-py3-none-any.whl/inject.pth`; `dist/demo_package-1.2.0.tar.gz/setup.py`; `dist/demo_package-1.2.0-py3-none-any.whl/demo_package-1.2.0.dist-info/METADATA` |
| B | shared `file.*`/`code.*`/`diff.*` | `artifactDiffNamespace(artifact)` + `/` + `normalizePyPiDiffFilePath(rootStrippedPath)`; namespace `sdist` or `wheel/<WHEEL Tag headers sorted, joined with +>` (fallback: the `.whl` filename's last three tags); `<name>.dist-info/` → `.dist-info/` | `wheel/py3-none-any/demo_package/collect.py`; `sdist/setup.py`; `wheel/py3-none-any/.dist-info/METADATA` |

Example: an sdist `setup.py` with top-level `os.system`/`urllib.request` yields `pypi.setup-install-command` at `dist/…tar.gz/setup.py` (A) and `code.process-execution`/`code.network-access` at `sdist/setup.py` (B).

### atpm fixture (`cases-atpm/*.json`)

Record projections, not package files: the signals compare verified provenance, downloaded archive digests, and the publisher's trusted-publishing declaration.

- Required: `id`, `title`, `category`, `intent`, `expectedRisk`, exact `expectedFindings[{ ruleId, severity, file }]`.
- Optional (mirrors the finding function): `target`, `manifest`, `archiveSha1`, `archiveSha512`, `recordName`, `trustPublisher`, `baseline`, `baselineArchiveSha512`.
- All identities, repositories, digests, and timestamps are synthetic. A matching verified build is the benign control.

### Registry provenance corpus

`cases-provenance/` holds registry-record projections rather than package files; rule behavior and trust boundaries: [`provenance-continuity.md`](./provenance-continuity.md).

| Field / path | Contract |
| --- | --- |
| Required metadata | `id`, `title`, `category`, `intent`, `ecosystem` (`npm` or `pypi`), `expectedRisk`, exact `expectedFindings`. |
| `registryProvenance` | `{ packageName, history?, baseline, candidate }`. |
| `history` | Earlier published releases of any channel; lineage selects the compared baseline and prior releases. A medium drop needs two attested releases before the baseline. |
| `publishedAt` | Optional ISO timestamp on any side pins publication order. |
| npm side | `{ version, packumentProvenance?, statements? \| attestations? }`; `packumentProvenance` is `dist.attestations.provenance`, omitted means unknown; decoded in-toto `statements` are wrapped in DSSE envelopes; raw `attestations` supplies malformed documents. |
| PyPI side | `{ version, files: [{ filename, status, body }] }`; one integrity-API response per selected file. |
| Production path | `test/helpers/provenance-security-corpus.mjs` calls `npmRegistryProvenance`, `classifyPyPiProvenanceResponse` + `combinePyPiFileProvenance`, `npmProvenanceLineage` / `pypiProvenanceLineage`, then `provenanceContinuityFindings`. |
| Eval routing | Any fixture with `registryProvenance`, including `legit-provenance-*` hard negatives in `cases-benign/`, uses that same helper (`test/eval/harness.mjs`). |
| Synthetic identities | Keep repositories and ids synthetic. |

### Rule versions

| Findings | Stamped with | File |
| --- | --- | --- |
| shared `file.*`/`code.*`/`diff.*`/… (`deterministicFindings`) | `DETERMINISTIC_RULES_VERSION` | `server/lib/review/rules/index.ts` |
| `pypi.*` (`pyPiReleaseFindings`) | `PYPI_RULES_VERSION` | `server/lib/ecosystems/pypi/types.ts` |
| `vscode.*` | `VSCODE_RULES_VERSION` | `server/lib/ecosystems/vscode/types.ts` |

The PyPI harness asserts per family: every `pypi.*` finding equals `PYPI_RULES_VERSION`, every other finding equals `DETERMINISTIC_RULES_VERSION`.

## Rule inventory

The complete deterministic ruleset across all ecosystems. Scoring roles are declared per rule in `DETERMINISTIC_RULES` (`server/lib/review/rules/rule-ids.ts`):

- `anchor`: severity maps straight to risk and sets a floor.
- `capability`: scores by co-occurrence.
- `weak-lone-capability`: de-escalates to low when it fires alone.
- Standing danger: evidence of active compromise, so release memory never discounts it as previously-approved context.
- `pypi.*` and `vscode.*` rules live in their ecosystem registries (`PYPI_RULE_IDS`, `VSCODE_RULE_IDS`) and always anchor.

`test/detection-rule-coverage.test.mjs` checks this table against the registries: IDs must match exactly, every rule needs a corpus fixture asserting it (or an exception in that test naming the unit-test layer), and fixtures may only assert registered IDs.

Current exceptions: `stage.metadata-mismatch`, `stage.tarball-digest-mismatch` (`test/staged-artifact-integrity.test.mjs`), `release.source-drift` (`test/release-fingerprint.test.ts`), `vscode.metadata-mismatch`, `vscode.extension-dependency` (`test/vscode.test.mjs`).

| Rule | Registry | Scored as | Standing danger |
| --- | --- | --- | --- |
| `atpm.provenance-invalid` | deterministic | anchor | no |
| `atpm.provenance-missing` | deterministic | anchor | no |
| `atpm.provenance-publisher-mismatch` | deterministic | anchor | no |
| `atpm.provenance-subject-mismatch` | deterministic | anchor | no |
| `atpm.trusted-publishing-lost` | deterministic | anchor | no |
| `code.credential-access` | deterministic | capability | no |
| `code.dynamic-evaluation` | deterministic | capability | no |
| `code.key-material-exfiltration` | deterministic | anchor | yes |
| `code.network-access` | deterministic | capability | no |
| `code.process-execution` | deterministic | weak-lone-capability | no |
| `code.remote-shell` | deterministic | capability | yes |
| `dependency.added` | deterministic | anchor | no |
| `dependency.major-bump` | deterministic | anchor | no |
| `dependency.optional-added` | deterministic | anchor | no |
| `dependency.unusual-spec` | deterministic | anchor | no |
| `diff.bin-added` | deterministic | anchor | no |
| `diff.credential-file-added` | deterministic | anchor | no |
| `diff.large-new-file` | deterministic | anchor | no |
| `file.control-bytes` | deterministic | anchor | no |
| `file.large-binary` | deterministic | anchor | no |
| `file.native-artifact` | deterministic | anchor | no |
| `file.outside-files-list` | deterministic | anchor | no |
| `file.python-source-encoding` | deterministic | anchor | no |
| `file.unsampled-entrypoint` | deterministic | anchor | no |
| `file.prompt-injection` | deterministic | anchor | no |
| `file.review-manipulation` | deterministic | anchor | yes |
| `file.secret-content` | deterministic | anchor | yes |
| `install-script.gyp-command-substitution` | deterministic | anchor | yes |
| `install-script.implicit-node-gyp` | deterministic | anchor | yes |
| `install-script.lifecycle` | deterministic | anchor | yes |
| `install-script.preinstall` | deterministic | anchor | yes |
| `package-json.entrypoint-missing` | deterministic | anchor | no |
| `package-json.parse-failed` | deterministic | anchor | no |
| `propagation.package-mutation` | deterministic | anchor | yes |
| `propagation.registry-publish` | deterministic | anchor | yes |
| `release.provenance-dropped` | deterministic | anchor | no |
| `release.provenance-publisher-changed` | deterministic | anchor | no |
| `release.source-drift` | deterministic | anchor | no |
| `stage.metadata-mismatch` | deterministic | anchor | no |
| `stage.tarball-digest-mismatch` | deterministic | anchor | no |
| `tar.suspicious-entry` | deterministic | anchor | yes |
| `pypi.metadata-missing` | pypi | anchor | no |
| `pypi.metadata-mismatch` | pypi | anchor | no |
| `pypi.native-artifact` | pypi | anchor | no |
| `pypi.pth-execution` | pypi | anchor | no |
| `pypi.record-mismatch` | pypi | anchor | no |
| `pypi.setup-install-command` | pypi | anchor | no |
| `pypi.startup-hook` | pypi | anchor | no |
| `pypi.unusual-dependency` | pypi | anchor | no |
| `pypi.wheel-record-missing` | pypi | anchor | no |
| `vscode.broad-activation` | vscode | anchor | no |
| `vscode.extension-dependency` | vscode | anchor | no |
| `vscode.metadata-mismatch` | vscode | anchor | no |
| `vscode.startup-remote-command` | vscode | anchor | no |
| `vscode.startup-wasm-loader` | vscode | anchor | no |
| `vscode.undeclared-configuration-read` | vscode | anchor | no |

## Rule behavior

What each family fires on and leaves quiet, with the pinning fixture: [`detection-rule-behavior.md`](./detection-rule-behavior.md).

## Invariants

1. Folding and normalization only add detections: raw and folded text are both scanned (`server/lib/review/rules/normalize.ts`).
2. Test-path demotion lowers one step and marks `testScoped`, never drops; demoted hits are excluded from capability co-occurrence. Obfuscated matches, lifecycle- or entrypoint-reachable files, and same-file credential→network chains keep full severity.
3. `file.secret-content` test demotion applies only to material unchanged from the baseline; a secret newly entering a test tree keeps full severity. Python reachability seeds from every non-test module.
4. Prompt-injection tiers demote longstanding matches in unreachable test files one step, judged by whether the matched attempt changed, not whether any line in the file changed.
5. Risk roll-up (`computeRisk`): anchors are a floor; co-occurrence is a floor combined with the highest capability severity, never a ceiling; `code.remote-shell` is excluded from weak-lone de-escalation.
6. A modified-file finding without line evidence is re-checked against the baseline; it is package context only when the same rule fired on the same file there, otherwise it fails open to release delta.
7. The PyPI adapter's Python matcher is also used when annotating modified-file findings, so release-risk classification stays consistent for extensionless Python files.
8. `npm_config_*` is never treated as plain configuration because it can carry live registry auth (`npm_config__authToken`).
9. The env pre-strip preserves newlines, so erasing a match never shifts later findings' line numbers.
10. Prompt rules emit at most one finding per tier per line; a high-tier match subsumes generic injection on the same line, but a distinct generic attempt elsewhere keeps its own row so release attribution sees new evidence.
11. Prompt scanning uses 64 KiB windows with 4 KiB overlap (`PROMPT_INJECTION_SCAN_WINDOW_CHARS`, `PROMPT_INJECTION_SCAN_OVERLAP_CHARS` in `server/lib/review/rules/prompt-injection.ts`); peak memory stays independent of the 25 MiB per-file inspection limit.
12. `propagation.package-mutation` only adds findings; it never proves a destination stays inside the package, because every review round found another write or link channel around such a proof. Its position analysis caps assembled text at 4 KB and runs under a work budget linear in token count; an error drops only its own evidence.
13. Root stripping follows the consumer: npm and atpm use `strip1` (node-tar `strip: 1`, applied before node-tar's `..`/absolute checks); PyPI uses `keep` and `preparePyPiArtifact` strips the common root, treating entries outside it as evidence. An entry with no directory component is disclosed as `parser-differential`, never recorded under its own name.
14. Two npm divergences are by design and hide nothing: a backslash path is a finding, not a file; `.gitignore` is reported under its archive name, not pacote's `.npmignore` rename.
15. A workflow-gate `.tgz`/`.tar.gz` is claimed by npm and PyPI on filename alone, so that parse strips only a literal `package/`; an npm tarball rooted elsewhere has no root manifest and is rejected as unrecognizable.
16. On PyPI, a lone zero block is a real reader disagreement (pip/GNU tar stop; node-tar continues), so parser-differential findings there mean pip may not extract the entries, not that content is hidden.
17. Renamed-chunk pairing (`server/lib/review/renamed-files.ts`): an added JS/TS file pairs one-to-one with a removed file in the same directory at shingle similarity ≥ `MIN_SIMILARITY` (0.8), names ignored, under a capped work budget; a pair is judged as that predecessor modified, and anything past the cap stays added.
18. Entrypoint resolution has no default mode; a Python sdist bundling a root `package.json` is never held to npm `require()` semantics.
19. Only the high `package-json.entrypoint-missing` variant is release-scoped; a manifest stale for at least a release is package context.
20. Rule changes never rewrite persisted reports; fresh analysis uses the new version.
21. A rule-family coverage change bumps its version constant and updates fixtures in the same PR.
22. Install-hook release attribution (`test/lifecycle-release-attribution.test.ts`): hook identity is recovered from rule evidence, so `install` and `postinstall` stay independent under one rule ID; the final duplicate JSON key controls the effective command; unreadable, malformed, structurally invalid, or redacted comparisons stay conservative; persisted annotations and explicitly skipped comparisons keep precedence.
23. Dangerous descendants of modified install code stay release-scoped after meaningful code-token changes (comments and spacing excluded, significant line breaks kept): prior graph membership cannot prove a dormant function ran. Literal execution roots and lexer-filtered import edges avoid crediting output arguments or comment/string examples as prior execution; imports that need runtime values are outside static coverage. No package code is executed.
24. The retention-tier notice escalates only for a changed file whose content the rules could have read; hash-only native binaries and source maps are not inspection gaps unless they are what runs (an entrypoint or a loaded file). Reachability and file names grade findings, never whether bytes are scanned: unloaded minified bundles and data formats are scanned one and two steps lower.
25. Dependency diff links (`server/lib/review/dependency-specs.ts`, shared with the UI): modified rows link directly only when both specs are exact registry version keys; ranges render no direct link; added dependencies use the package-only route that resolves a published pair from registry metadata.

### Tar reader parity with node-tar

`tar.suspicious-entry` `parser-differential` exists because each shape below once let an archive show review one file set and hand npm another. The reader (`server/lib/tar-parser.js`) matches node-tar on:

| Area | node-tar behavior Drydock matches |
| --- | --- |
| End of archive | Two consecutive null blocks; a null block is zero everywhere outside the checksum field with an unparsable checksum. |
| Bad headers | A failed checksum, or a base-256 numeric field (high bit set) with a prefix other than `0x80`/`0xff` or outside the safe-integer range, skips the block without consuming its declared body, and is reported. Covers mode, uid, gid, mtime; devmaj/devmin under ustar magic; atime/ctime when byte 475 is NUL; not fields a PAX record (uid, gid, mtime, atime, ctime only) overrides. |
| PAX | `size` (local and global) overrides the ustar size; bare `size` is an empty value (zero-length body); bare `path` rejects every following header; numeric `path` rejects only typeflag `0`/NUL headers; `path=0` rejects until a prefix stringifies it; records parsed line by line (a mis-declared length costs one line); metadata over 1 MiB ignored; a BOM before a PAX body drops the first record. |
| Extended headers | `X` = `x`, `N` = `L`, `K` is metadata; a global header does not clear a pending local one (only its `path`/`linkpath` are ignored); a zero-length `L` changes nothing; GNU `L`/`N` digits stay strings. |
| Strings | Cut with `/\0.*/` (no `s` flag); a leading UTF-8 BOM is kept. |
| Types | Typeflag `7` is a regular file; a `0`/NUL entry ending in `/` is a directory. |
| Paths | `.` segments collapsed; ustar prefix read only with ustar magic (130/155 split; a magic-less non-empty prefix, which CPython joins, is disclosed), not prepended to an extended-header path, and prepended unconditionally when byte 475 is set (empty name → `/`); unrepresentable regular-entry paths (traversal, drive letter, backslash, over-long) reported instead of dropped. |

## Known coverage gaps

| Gap | Consequence |
| --- | --- |
| Dependency tarballs are not fetched or diffed | A payload inside an added/bumped dependency is caught only if the reviewer follows the finding. |
| Dropped files raise nothing alone | A removed binary is a removed diff entry unless still declared as an entrypoint; unmatched `files` entries are not flagged (optional platform builds). |
| Propagation models only the install path | Republishing at import or run time raises no `propagation.*`; capability rules still see process, network, credential use. |
| Install-root positions are relative only | Absolute paths, `~`, `process.env.INIT_CWD`, `os.homedir()`, `require.resolve`, `module.paths`, unmodeled path functions, and hook-run shell files (`sh link.sh`) are not placed; they still fire when the source names `node_modules`. Read-outside-write-inside hooks also fire; a write into `node_modules/.cache` reads the same as rewriting a neighbour. The finding is a reviewer signal at high, never an automatic rejection. |
| Behavior chains are regex co-occurrence | Credential + egress in one file escalates without proving flow; only key material is traced. |
| Key-material trace is lexical and bounded | Ignores shadowing, callbacks, `push`/`join` accumulation, `Object.assign`, image-beacon `src`, `exec` of a variable command, other files; minifier renames break helper resolution; encrypt-then-also-exfiltrate is missed; budget exhaustion → no finding; gives up on JSX and TS generic arrows. |
| JS credential access reads names, not values | `process.env.CONFIG` holding a secret, `const { env } = process`, and `.npmrc` reads raise nothing; `process.env[key]` loops (`EnvironmentPlugin`) and `spawn(…, { env: { ...process.env } })` are known false positives. |
| Decode gate is per file | A decode in one module executed from another is missed. |
| Prompt detection is phrase-based | Paraphrased, encoded, non-English, or > 4 KiB-split phrases fall to the advisory AI reviewer. |
| Registry intelligence beyond provenance | Registry provenance continuity is covered for published npm/PyPI pairs; maintainer/account-transfer intelligence, publisher reputation, OpenSSF/package-intel and typosquat/confusion name distance are not implemented. |
| PyPI startup-hook reach | A `.pth` adding a package-internal dir makes a nested `sitecustomize.py` importable (the `.pth` still flags, medium without an import line); a `.data/scripts/` file named like a stdlib module shadows it for that script. |
| PyPI install schemes | Only posix_prefix, venv, posix_user, macOS framework user, nt, nt venv, nt_user, Debian `dist-packages`; custom `--prefix`/`--root` layouts are not resolved. |
| PyPI RECORD hashes | Only undeclared files are detected; `sha256=<base64url>` vs hex conversion deferred; truncated RECORD samples skipped. |
| PyPI build backends | `[build-system] backend-path` / PEP 517 in-tree backends not flagged (FP risk with maturin/Cython). |
| PyPI not analyzed | `Requires-Dist` diffing, `entry_points`/`console_scripts`, wheel `*.data/scripts/`, `.pyc`-only distributions. |
| PyPI native code | `.so`/`.pyd` stays high and is a known FP source (NumPy etc.). |

PyPI startup-hook fixtures fire only for files on the import path:

- Top-level wheel files and `.data/{purelib,platlib}/`.
- `.data/data/` site dirs: `lib|lib64/pythonX.Y|pypyX.Y/site-packages`, Debian `dist-packages`, Windows `Lib/site-packages`, nt_user `PythonXY/site-packages`, the Windows prefix root.
- `.data/data/` stdlib dirs: `lib/pythonX.Y`, `lib-dynload`, `Lib`, `DLLs`.
- `pypi.pth-execution` fires only in site dirs; `pypi.startup-hook` matches `sitecustomize`/`usercustomize` in any importable form (package `__init__`, `.pyw`, sourceless `.pyc`, native extension) plus a `pythonXY.zip`; `.pth` import lines split on every `str.splitlines()` boundary.
- Package-internal files and other `.data/` schemes (`scripts`, `headers`, `data/share`) stay quiet (`test/pypi.test.mjs` tables every modeled layout).

## Change checklist

1. Add a JSON file under the matching `cases*/` directory; keep it synthetic and minimal.
2. Assert exact findings and risk; for an important undetected scenario add `coverageGaps` and assert current diff-only behavior.
3. Intentional rule-output change: update fixture expectations in the same PR and say why.
4. New rule: add it to its registry, a fixture asserting it (or a `CORPUS_COVERAGE_EXCEPTIONS` entry), and a row in the Rule inventory above.
5. Bump the family version constant and add a row to [`detection-rule-history.md`](./detection-rule-history.md); move any still-binding constraint into the invariants above.
6. Adapter-level scan tests include at least one baseline-backed fixture asserting a `diff.*` rule ID.
7. Run the affected suite, then `pnpm run eval`:

```sh
pnpm run test:node -- security-corpus.test.mjs
pnpm run test:node -- security-corpus-pypi.test.mjs
pnpm run test:node -- security-corpus.test.mjs pypi.test.mjs   # regression net after a rules bump
pnpm test -- test/security-corpus-atpm.test.mjs --project node
pnpm test -- test/security-corpus-provenance.test.mjs --project node
pnpm run verify                                                # full pre-commit parity
```

## Why

- [OpenSSF malicious-packages](https://github.com/ossf/malicious-packages): typosquatting, account takeover, prebuilt binaries, dependency/manifest confusion; telemetry, obfuscation and protestware need context.
- [OpenSSF Package Analysis](https://github.com/ossf/package-analysis): files accessed, addresses contacted, commands run.
- [Datadog's dataset](https://github.com/DataDog/malicious-software-packages-dataset/): taxonomy validation only.
- [Aikido's AsyncAPI report](https://www.aikido.dev/blog/asyncapi-npm-packages-backdoored-via-github-actions): rotating string-table `node -e` wrapper, kept as `asyncapi-rotating-string-table-dropper` without endpoint or payload.
- npm benchmark research (6,420 malicious / 7,288 benign; 11 behavior and 8 evasion categories; top behaviors command execution, data collection, exfiltration; ~72% of malicious packages used install scripts, preinstall dominant) shows benign and malicious code call the same APIs, so capability reads are evidence and collect → serialize → exfiltrate chains are intent.
- Key-material detection is a taint pass rather than file co-occurrence because wallet SDKs hold key material and an RPC client in every release.
- Propagation gates on install-time reachability because publishing and rewriting `node_modules` are ordinary for release CLIs and patch tools.
