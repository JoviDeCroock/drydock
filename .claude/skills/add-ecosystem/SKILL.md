---
name: add-ecosystem
description: Add or extend a Drydock ecosystem capability through its staged, workflow-gate, or public-diff adapter and verify the affected release paths.
---

# Add an ecosystem capability

An ecosystem owns resolution, fetching, validation, and findings under `server/lib/ecosystems/<id>/`. Declare its ID/label in the dependency-free `server/lib/ecosystems/labels.ts`; register only supported capabilities in `ECOSYSTEM_MODULES` in `server/lib/ecosystems/index.ts`. The registry drives capability discovery; do not add another ecosystem list to routes or orchestrators.

Read the contract for the capability being changed and a nearby implementation:

| Capability | Contract | Responsibility |
| --- | --- | --- |
| `staged` | `server/lib/ecosystems/package-adapter.ts` | Review registry-held private release candidates |
| `gate` | `server/lib/workflow-gates/types.ts` | Review built artifacts while a GitHub Environment holds the publish job |
| `publicDiff` | `server/lib/public-diff/types.ts` | Compare published releases anonymously without credentials or D1 persistence |

## Boundaries that shape the adapter

Archive parsing stays in the credentials-free sandbox (`server/lib/sandbox.ts`). Adapters consume parsed `FileRecord[]`; never pair raw package bytes with registry credentials or execute package content. Normalize manifests into `PackageJsonSummary`.

For gates, put `workflow-gate.ts` in the ecosystem directory. Preserve artifact classification, content-based detection, package-identity grouping, and fail-closed handling of inconsistent artifacts through `WorkflowArtifactError` from `server/lib/github-app/artifacts.ts`. If shared plumbing needs custom behavior, extend `WorkflowGateAdapter` with an optional hook and check existing adapters; `narrowParsedArtifact?` and `shardedArtifactNames?` are precedents.

For public diff, the adapter validates/normalizes identity, lists versions, acquires both sides, and selects findings. Shared orchestration owns diffing, redaction, risk, and caching. Bind cache identity to rule/payload versions and bound cache lifetime when release identity or resolution is mutable. Read `docs/atpm-public-diff.md` for the publisher-controlled resolution/egress case; do not copy its protocol choices into unrelated ecosystems.

## Evidence and docs

Use `docs/release-safety.md` for the affected boundaries: adapter logic tests, Worker tests for HTTP/D1 contracts, and fake-registry scenarios for registry or gated scan workflows. Adapter scan coverage needs a baseline-backed case asserting a `diff.*` rule ID so the integration cannot silently discard diff findings. A public-diff-only adapter without a fake-registry surface uses logic and Worker tests.

Update `docs/architecture.md`, `docs/workflow-gates.md` when gated, and any ecosystem-specific behavior/setup docs. Link a new doc from `docs/README.md`; update `docs/repository-map.md` if ownership changes. Verify the supported capabilities and the absence of unsupported ones, then run the checks required for the changed release paths.
