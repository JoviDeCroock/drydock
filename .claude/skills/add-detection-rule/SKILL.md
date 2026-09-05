---
name: add-detection-rule
description: Add or change a Drydock deterministic finding with rule identity, risk semantics, corpus fixtures, versioning, and detection eval coverage.
---

# Change deterministic detection

Ship the rule with evidence for both its intended signal and plausible benign triggers. Deterministic findings remain authoritative; AI cannot downgrade them. Read `docs/security-detection-corpus.md` for the relevant ecosystem's fixture schema and `docs/detection-eval.md` when choosing eval cases.

## Implementation contracts

- Register rule identity and risk role in `DETERMINISTIC_RULES` in `server/lib/review/rules/rule-ids.ts`. Follow the existing family names. Use `tag(ruleKey, finding)` from `server/lib/review/rules/helpers.ts` rather than assigning `ruleId` by hand.
- Implement in the owning family under `server/lib/review/rules/`, or the ecosystem's rule implementation. In the shared composer, artifact rules enter `deterministicFindings`; manifest-diff rules enter `packageJsonDiffFindings`. The composer stamps `ruleVersion`.
- Bump `DETERMINISTIC_RULES_VERSION` in `server/lib/review/rules/index.ts` when shared semantics, severity, or coverage changes. PyPI-only changes bump `PYPI_RULES_VERSION` in `server/lib/ecosystems/pypi/types.ts`.
- Read `computeRisk` through `server/lib/review/index.ts` before selecting severity and manifest risk role. Capability co-occurrence and anchor floors differ; `obfuscated` and `testScoped` affect scoring. Use `standingDanger: true` for active-compromise evidence that release memory must never discount as previously approved context.

Apply shared semantic changes to every affected adapter and caller. Preserve the distinction between an artifact-only signal and a change relative to a baseline; a useful reference is `diff.bin-added` in `server/lib/review/rules/entrypoints.ts` and `test/fixtures/security-corpus/cases/bin-added.json`.

## Required evidence

Add or update corpus cases with exact rule ID, severity, file, and expected risk. Pin the baseline and manifest diff when the rule depends on them. Use inert synthetic `FileRecord` JSON, `example.invalid` URLs, and obviously fake secrets. Never execute fixture package contents. PyPI uses `cases-pypi/` with a different manifest/artifacts schema; use its section in the corpus docs.

Add a benign hard-negative when legitimate packages could trigger the rule. The eval harness reuses golden cases plus frontier and benign cases; inspect the existing gates instead of weakening them to accommodate a new finding.

Run the affected corpus suite (`pnpm run test:node -- security-corpus.test.mjs`, or `security-corpus-pypi.test.mjs` for PyPI), focused rule tests, and `pnpm run eval`. Use the full verify gate before finishing a branch.

Update the rule inventory, taxonomy, and version changelog in `docs/security-detection-corpus.md`; `test/detection-rule-coverage.test.mjs` checks registry/fixture/inventory coverage. Update eval docs only when eval behavior changes.
