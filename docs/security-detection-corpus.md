# Security detection corpus

Drydock's deterministic findings are the authoritative review signal while AI review is disabled. The detection corpus exists to make those findings measurable: every rule change should be checked against small, reviewable package scenarios with explicit expected rule IDs, severities, and risk.

This is a **safe synthetic corpus**, not a malware zoo. It captures techniques observed in npm supply-chain research without vendoring live malicious packages, encrypted malware archives, real credentials, or customer artifacts.

## Research basis

The fixture taxonomy is based on the current Drydock rule surface plus public npm malware research:

- [OpenSSF malicious-packages](https://github.com/ossf/malicious-packages) publishes OSV-format reports and explicitly scopes in typosquatting, account takeover, malicious prebuilt binaries, dependency confusion, and manifest confusion. It also warns that telemetry, obfuscation, and protestware need context before they are treated as malicious.
- [OpenSSF Package Analysis](https://github.com/ossf/package-analysis) tracks package behavior by asking what files packages access, what addresses they connect to, and what commands they run. Its public case studies are useful for behavior taxonomy, but Drydock should not execute packages.
- [Datadog's malicious-software-packages-dataset](https://github.com/DataDog/malicious-software-packages-dataset/) is human-triaged and useful for taxonomy validation, but its samples are actively malicious and distributed as encrypted `infected` archives. Do not copy those samples into this repository.
- Recent npm detection benchmark research reports a curated dataset of 6,420 malicious and 7,288 benign npm packages, with 11 behavior categories and 8 evasion categories. The most common behaviors were command execution, data collection, and data exfiltration; install scripts were used by about 72% of malicious packages in that study, and preinstall hooks were the dominant install-time entry point.
- The same benchmark highlights the central detection trade-off: benign and malicious packages often call the same APIs. A single `process.env` or `https` use is capability evidence, while chains such as collect → serialize → exfiltrate are stronger intent evidence.

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

## Initial taxonomy

The first corpus slice covers:

- benign version bump control;
- preinstall credential/environment collection with command and network capability;
- implicit `node-gyp rebuild` from root `binding.gyp` plus native artifact review;
- base64/dynamic evaluation, obfuscator-style large JavaScript payloads, and network-capable code;
- secret-looking file addition;
- large opaque binary addition;
- files that appear in the tarball outside a declared `package.json.files` allowlist;
- unexpected large root-level JavaScript payloads;
- aggregate package size anomalies compared with the previous release;
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
