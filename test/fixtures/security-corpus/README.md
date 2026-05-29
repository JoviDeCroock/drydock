# Security detection corpus fixtures

This directory contains Drydock's synthetic golden corpus for deterministic staged-publish review.

- `cases/` holds npm fixtures evaluated by `test/security-corpus.test.mjs`.
- `cases-pypi/` holds PyPI release-artifact fixtures evaluated by `test/security-corpus-pypi.test.mjs`.
- Fixtures are intentionally small JSON documents, not tarballs and not real malware.
- `stagedFiles`/`previousFiles` (npm) and `artifacts`/`previousArtifacts` (PyPI) use the same `FileRecord` shape returned by the sandbox.
- `expectedFindings` names the exact deterministic rule IDs, severities, and files expected today.
- `expectedRisk` records the expected deterministic risk from those findings.
- Optional `expectedPackageJsonDiff` assertions cover diff surfaces that may not yet produce findings.
- `coverageGaps` records intentional blind spots so future rule work can promote them into findings.

PyPI `expectedFindings[].file` uses two namespacing schemes: `pypi.*` findings use the literal manifest artifact path joined to the in-archive file path (sdists root-stripped); shared `file.*`/`code.*`/`diff.*` findings use the diff namespace (`sdist/…` or `wheel/<sorted WHEEL tags>/…`, with `.dist-info` collapsed). See `docs/security-detection-corpus.md` for the full cheat-sheet.

Do not vendor live malicious packages, encrypted malware archives, real credentials, or raw customer package bytes here. Use synthetic `example.invalid` endpoints and obviously fake secrets only.
