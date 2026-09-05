---
name: shared-primitives
description: Choose ownership and contracts when adding or consolidating reusable helpers in Drydock, especially across trust boundaries or UI pages.
---

# Shared primitives

Search for the behavior before adding a helper: names drift, so also search relevant operations such as `crypto.subtle.digest`, path-segment checks, escape sets, or bounded `Promise.all` loops. Inspect the matching primitive rather than loading the whole platform directory.

## Ownership

| Behavior | Home |
| --- | --- |
| Domain-free guards, path checks, concurrency, crypto, escaping, retry | `server/lib/platform/` |
| Ecosystem resolution, validation, fetching, findings | `server/lib/ecosystems/<id>/` |
| Ecosystem-specific gate behavior | An optional `WorkflowGateAdapter` hook, implemented in that ecosystem |
| Deterministic rules | `server/lib/review/rules/` |
| Shared page behavior | `src/features/` |
| UI primitives and typography | `src/components/` |
| Scan persistence | The matching responsibility module behind `server/db/scans.ts` |

Existing primitives include `guards.ts`, `path-safety.ts`, `concurrency.ts`, `crypto-utils.ts`, and `html-escape.ts` under the platform directory. A second implementation is a prompt to compare contracts. Reuse or extend the shared implementation when semantics agree; do not merge superficially similar behavior with different trust or domain contracts. If the shared implementation is wrong, fix affected callers together.

Name a helper for the context required to use it safely: `escapeHtmlText`, `escapeHtmlAttribute`, and `escapeXml` distinguish output contexts; `auditSeverityTone` distinguishes the audit vocabulary from finding severity. Avoid names that hide encoding, credential, or trust assumptions.

`server/lib/tar-parser.js` deliberately keeps an import-free `sha256Hex` because the parser is inlined into the sandbox Worker. Preserve that constraint; document comparable exceptions at the copy.

## Evidence for consolidation

Check the complete caller set and search again for leftover implementations. Preserve caller semantics, including error handling and result order. Add direct contract tests where shared correctness matters: traversal/encoding cases for path and escape helpers, or invalid concurrency, out-of-order completion, and in-flight failure behavior for fan-out. Choose cases from the contract and the changed behavior, not a universal checklist of arbitrary inputs.

A consolidation is complete when all equivalent callers use the intended implementation and its relevant contracts are covered. Use [split-large-module](../split-large-module/SKILL.md) only if the task also needs a structural split.
