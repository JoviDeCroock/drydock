---
name: add-detection-rule
description: Add or change a deterministic detection rule in Drydock. Use when adding a new rule ID, changing a rule's severity or coverage, wiring a rule into the deterministic findings pipeline, authoring the required security-corpus fixture, or confirming eval coverage before a detection PR.
---

# Add A Deterministic Detection Rule

Deterministic findings are the authoritative review signal; the AI reviewer is advisory and cannot downgrade them. Every rule change ships with a corpus fixture that pins exact rule IDs, severities, and risk.

## Checklist

1. **Register the rule ID.** Add a key to `DETERMINISTIC_RULE_IDS` in `server/lib/review/rules/rule-ids.ts`. IDs are dot-namespaced by family: `install-script.*`, `code.*`, `file.*`, `diff.*`, `dependency.*`, `package-json.*`, `stage.*`, `tar.*`, `release.*`.
2. **Implement the rule in its family module** under `server/lib/review/rules/` (`metadata.ts`, `scripts.ts`, `binaries.ts`, `deps.ts`, `entrypoints.ts`; regex sets live in `patterns.ts`). Emit findings with `tag(ruleKey, { severity, file, evidence, reason, line? })` from `server/lib/review/rules/helpers.ts` — `tag` attaches the rule ID; never hand-write `ruleId`. `Finding.severity` is `"info" | "low" | "medium" | "high" | "critical"` (`server/lib/review/index.ts`).
3. **Wire it into the composer** in `server/lib/review/rules/index.ts`: rules over the staged artifact go through `deterministicFindings` (which calls the family entry functions), rules over the manifest diff go through `packageJsonDiffFindings`. Both stamp `ruleVersion` via `stampVersion`, so family modules never set it.
4. **Bump `DETERMINISTIC_RULES_VERSION`** in `server/lib/review/rules/index.ts` whenever rule semantics, severities, or coverage change. PyPI-only `pypi.*` rules instead bump `PYPI_RULES_VERSION` in `server/lib/ecosystems/pypi/types.ts`.
5. **Pick severity with the risk roll-up in mind.** `computeRisk` in `server/lib/review/index.ts` is weighted multi-signal, not max-severity:
   - `code.*` capability rules (`CODE_CAPABILITY_RULE_IDS`) score by co-occurrence: a lone `code.process-execution` de-escalates to low; two or more distinct capabilities floor at high.
   - Every other rule is an anchor: its severity maps straight to risk (`severityToRisk`) and sets a floor.
   - `obfuscated` and `testScoped` finding flags change scoring — read the comments on `computeRisk` before assuming.
   - If the rule is evidence of active compromise (not a package capability), add it to `STANDING_DANGER_RULE_IDS` in `server/lib/review/risk.ts` so release memory can never discount it as previously-approved context.
6. **Add the corpus fixture** at `test/fixtures/security-corpus/cases/<id>.json`. Required fields: `id`, `title`, `category`, `intent`, `stagedFiles` (sandbox-shaped `FileRecord[]`), `expectedRisk` (from `computeRisk()`), and `expectedFindings` as exact `{ ruleId, severity, file }` tuples. Optional: `previousFiles`, `previousPackageJson`/`stagedPackageJson`, `expectedPackageJsonDiff`, `coverageGaps`. Safety policy (see `docs/security-detection-corpus.md`): synthetic `FileRecord` JSON only, `example.invalid` URLs, obviously fake secrets, never runnable malware. PyPI fixtures live in `cases-pypi/` with their own manifest/artifacts schema and two file-namespacing schemes — read the PyPI corpus section of that doc before authoring one.
   - Verify: `pnpm run test:node -- security-corpus.test.mjs` (PyPI: `security-corpus-pypi.test.mjs`).
7. **Check eval coverage.** The eval harness (`test/eval/detection-eval.test.mjs`, see `docs/detection-eval.md`) reuses the golden cases and adds `test/fixtures/security-corpus/cases-frontier/` (truth-labeled hard cases, reported) and `cases-benign/` (hard-negatives, gated: benign FP rate < 10% at risk >= medium). If the rule could fire on legitimate packages, add a benign hard-negative that proves it stays quiet.
   - Verify: `pnpm run eval` — gates are malicious recall >= 90%, every `expectMinRisk: critical` case caught, zero FPs on benign regression controls, benign hard-negative FP rate < 10%.
8. **Update docs.** `docs/security-detection-corpus.md` gets a taxonomy entry and a `DETERMINISTIC_RULES_VERSION` changelog note explaining what the version adds and which fixtures pin it; touch `docs/detection-eval.md` only if metrics or gates change.
9. **Full gate before commit:** `pnpm run verify`.

## Worked Example: `diff.bin-added`

A release that adds a `bin` entry puts a new command on the consumer's install path (npm symlinks it into `node_modules/.bin`) even when no script or code pattern fires.

- ID: `diffBinAdded: "diff.bin-added"` in `server/lib/review/rules/rule-ids.ts`.
- Implementation: `entrypointDiffFindings` in `server/lib/review/rules/entrypoints.ts` walks `packageJsonDiff.bin`, and for each `status === "added"` entry emits `tag("diffBinAdded", { severity: "medium", file: "package.json", line: firstJsonPropertyLine(...), evidence, reason })`. Plain `main`/`exports` retargets are deliberately not flagged — they change on almost every build and would be noise.
- Wiring: `entrypointDiffFindings` is composed into `packageJsonDiffFindings` in `server/lib/review/rules/index.ts` (it is a manifest-diff rule, so it does not run in `deterministicFindings`).
- Risk: no `code.*` capability, so the medium severity anchors the roll-up — the fixture's `expectedRisk` is `medium`.
- Fixture: `test/fixtures/security-corpus/cases/bin-added.json` — previous manifest without `bin`, staged manifest with `"bin": { "tool": "cli.js" }`, an inert `cli.js`, `expectedFindings: [{ "ruleId": "diff.bin-added", "severity": "medium", "file": "package.json" }]`, plus `expectedPackageJsonDiff.bin` asserting the diff entry itself.
- Docs: the taxonomy bullet and the coverage-gap note about unflagged entrypoint retargets in `docs/security-detection-corpus.md`.
