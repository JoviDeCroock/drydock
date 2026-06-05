# Security detection corpus fixtures

This directory contains Drydock's synthetic golden corpus for deterministic staged-publish review.

- `cases/` holds npm fixtures evaluated by `test/security-corpus.test.mjs`.
- `cases-pypi/` holds PyPI release-artifact fixtures evaluated by `test/security-corpus-pypi.test.mjs`.
- `cases-frontier/` (truth-labeled hard misses) and `cases-benign/` (hard-negatives the rules may flag) are eval-only; the golden tests never read them. See `docs/detection-eval.md`.
- Fixtures are intentionally small JSON documents, not tarballs and not real malware.
- `stagedFiles`/`previousFiles` (npm) and `artifacts`/`previousArtifacts` (PyPI) use the same `FileRecord` shape returned by the sandbox.
- `expectedFindings` names the exact deterministic rule IDs, severities, and files expected today.
- `expectedRisk` records the expected risk from the weighted `computeRisk()` roll-up (structural findings floor the risk; `code.*` capabilities escalate by co-occurrence). See "Risk roll-up" in `docs/security-detection-corpus.md`.
- Optional `expectedPackageJsonDiff` assertions cover diff surfaces that may not yet produce findings.
- `coverageGaps` records intentional blind spots so future rule work can promote them into findings.

PyPI `expectedFindings[].file` uses two namespacing schemes: `pypi.*` findings use the literal manifest artifact path joined to the in-archive file path (sdists root-stripped); shared `file.*`/`code.*`/`diff.*` findings use the diff namespace (`sdist/…` or `wheel/<sorted WHEEL tags>/…`, with `.dist-info` collapsed). See `docs/security-detection-corpus.md` for the full cheat-sheet.

## Cross-corpus parity

`test/security-corpus-parity.test.mjs` pairs conceptually-equivalent npm and PyPI
fixtures so that an edit to a shared rule (`file.*`/`code.*`/`diff.*`) can't be
applied to one corpus and silently forgotten in the other.

- Pair fixtures by adding the same `"parityGroup"` slug to exactly one fixture in
  `cases/` and one in `cases-pypi/`. Each group must have exactly one npm member
  and one pypi member; an unpaired or triple-membered group fails the test.
- The test runs the real detection engines on both members and asserts the sorted
  multiset of `${ruleId}:${severity}` is identical across the pair. The diff-namespace
  `file` differs by ecosystem, so it is intentionally excluded from the comparison.
- When one ecosystem legitimately emits an extra rule the other can't (e.g. npm's
  `install-script.preinstall` lifecycle hook has no PyPI equivalent), list those rule
  IDs in that fixture's `"parityIgnoreRuleIds"` array so they're dropped before the
  multiset comparison. Keep this list as small as possible — it documents an allowed
  divergence, not a way to mute genuine drift.

Current groups: `benign-version-bump` (clean bump raises nothing on both),
`credential-file-added` (a `.env`/`.npmrc` appears between versions), and
`code-sink-exfil` (process + network + credential sinks chained in module code).

Do not vendor live malicious packages, encrypted malware archives, real credentials, or raw customer package bytes here. Use synthetic `example.invalid` endpoints and obviously fake secrets only.
