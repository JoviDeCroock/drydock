---
name: add-detection-rule
description: Add or change a Drydock deterministic rule, including its ID, severity, pipeline wiring, security-corpus fixture, and eval coverage.
---

# Add A Deterministic Detection Rule

Deterministic findings are the authoritative review signal; the AI reviewer is advisory and cannot downgrade them. Every rule change ships with a corpus fixture that pins exact rule IDs, severities, and risk.

## Checklist

1. **Register the rule in the manifest.** Add an entry to `DETERMINISTIC_RULES` in `server/lib/review/rules/rule-ids.ts`: `{ id, risk, standingDanger? }` (see `DeterministicRuleSpec`). IDs are dot-namespaced by family: `install-script.*`, `code.*`, `file.*`, `diff.*`, `dependency.*`, `package-json.*`, `stage.*`, `tar.*`, `release.*`. `test/detection-rule-coverage.test.mjs` machine-checks that every registered rule has a corpus fixture (or an explicit exception there) and a docs rule-inventory row, so steps 6 and 8 fail loudly if skipped.
2. **Implement the rule in its family module** under `server/lib/review/rules/` (`metadata.ts`, `scripts.ts`, `binaries.ts`, `deps.ts`, `entrypoints.ts`; regex sets live in `patterns.ts`). Emit findings with `tag(ruleKey, { severity, file, evidence, reason, line? })` from `server/lib/review/rules/helpers.ts` — `tag` attaches the rule ID; never hand-write `ruleId`. `Finding.severity` is `"info" | "low" | "medium" | "high" | "critical"` (`server/lib/review/index.ts`).
3. **Wire it into the composer** in `server/lib/review/rules/index.ts`: rules over the staged artifact go through `deterministicFindings` (which calls the family entry functions), rules over the manifest diff go through `packageJsonDiffFindings`. Both stamp `ruleVersion` via `stampVersion`, so family modules never set it.
4. **Bump `DETERMINISTIC_RULES_VERSION`** in `server/lib/review/rules/index.ts` whenever rule semantics, severities, or coverage change. PyPI-only `pypi.*` rules instead bump `PYPI_RULES_VERSION` in `server/lib/ecosystems/pypi/types.ts`.
5. **Pick severity and the manifest `risk` role with the roll-up in mind.** `computeRisk` in `server/lib/review/index.ts` is weighted multi-signal, not max-severity, and derives its rule sets from the manifest:
   - `risk: "capability"` (the `code.*` signals) scores by co-occurrence: a lone `"weak-lone-capability"` de-escalates to low; two or more distinct capabilities floor at high.
   - `risk: "anchor"` maps severity straight to risk (`severityToRisk`) and sets a floor.
   - `obfuscated` and `testScoped` finding flags change scoring — read the comments on `computeRisk` before assuming.
   - If the rule is evidence of active compromise (not a package capability), set `standingDanger: true` on its manifest entry so release memory can never discount it as previously-approved context.
6. **Add the corpus fixture** at `test/fixtures/security-corpus/cases/<id>.json`. Required fields: `id`, `title`, `category`, `intent`, `stagedFiles` (sandbox-shaped `FileRecord[]`), `expectedRisk` (from `computeRisk()`), and `expectedFindings` as exact `{ ruleId, severity, file }` tuples. Optional: `previousFiles`, `previousPackageJson`/`stagedPackageJson`, `expectedPackageJsonDiff`, `coverageGaps`. Safety policy (see `docs/security-detection-corpus.md`): synthetic `FileRecord` JSON only, `example.invalid` URLs, obviously fake secrets, never runnable malware. PyPI fixtures live in `cases-pypi/` with their own manifest/artifacts schema and two file-namespacing schemes — read the PyPI corpus section of that doc before authoring one.
   - Verify: `pnpm run test:node -- security-corpus.test.mjs` (PyPI: `security-corpus-pypi.test.mjs`).
7. **Check eval coverage.** The eval harness (`test/eval/detection-eval.test.mjs`, see `docs/detection-eval.md`) reuses the golden cases and adds `test/fixtures/security-corpus/cases-frontier/` (truth-labeled hard cases, reported) and `cases-benign/` (hard-negatives, gated: benign FP rate < 10% at risk >= medium). If the rule could fire on legitimate packages, add a benign hard-negative that proves it stays quiet.
   - Verify: `pnpm run eval` — gates are malicious recall >= 90%, every `expectMinRisk: critical` case caught, zero FPs on benign regression controls, benign hard-negative FP rate < 10%.
8. **Update docs.** `docs/security-detection-corpus.md` gets a rule-inventory table row (machine-checked), a taxonomy entry, and a `DETERMINISTIC_RULES_VERSION` changelog note explaining what the version adds and which fixtures pin it; touch `docs/detection-eval.md` only if metrics or gates change.
9. **Full gate before commit:** `pnpm run verify`.

## Worked Example: `diff.bin-added`

A release that adds a `bin` entry puts a new command on the consumer's install path (npm symlinks it into `node_modules/.bin`) even when no script or code pattern fires.

- Manifest entry: `diffBinAdded: { id: "diff.bin-added", risk: "anchor" }` in `server/lib/review/rules/rule-ids.ts`.
- Implementation: `entrypointDiffFindings` in `server/lib/review/rules/entrypoints.ts` walks `packageJsonDiff.bin`, and for each `status === "added"` entry emits `tag("diffBinAdded", { severity: "medium", file: "package.json", line: firstJsonPropertyLine(...), evidence, reason })`. Plain `main`/`exports` retargets are deliberately not flagged — they change on almost every build and would be noise.
- Wiring: `entrypointDiffFindings` is composed into `packageJsonDiffFindings` in `server/lib/review/rules/index.ts` (it is a manifest-diff rule, so it does not run in `deterministicFindings`).
- Risk: no `code.*` capability, so the medium severity anchors the roll-up — the fixture's `expectedRisk` is `medium`.
- Fixture: `test/fixtures/security-corpus/cases/bin-added.json` — previous manifest without `bin`, staged manifest with `"bin": { "tool": "cli.js" }`, an inert `cli.js`, `expectedFindings: [{ "ruleId": "diff.bin-added", "severity": "medium", "file": "package.json" }]`, plus `expectedPackageJsonDiff.bin` asserting the diff entry itself.
- Docs: the taxonomy bullet and the coverage-gap note about unflagged entrypoint retargets in `docs/security-detection-corpus.md`.
