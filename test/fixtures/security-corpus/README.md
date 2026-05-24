# Security detection corpus fixtures

This directory contains Drydock's synthetic golden corpus for deterministic npm staged-publish review.

- Fixtures are intentionally small JSON documents, not tarballs and not real malware.
- `stagedFiles` and `previousFiles` use the same `FileRecord` shape returned by the sandbox.
- `expectedFindings` names the exact deterministic rule IDs, severities, and files expected today.
- `expectedRisk` records the expected deterministic risk from those findings.
- Optional `expectedPackageJsonDiff` assertions cover diff surfaces that may not yet produce findings.
- `coverageGaps` records intentional blind spots so future rule work can promote them into findings.

Do not vendor live malicious packages, encrypted malware archives, real credentials, or raw customer package bytes here. Use synthetic `example.invalid` endpoints and obviously fake secrets only.
