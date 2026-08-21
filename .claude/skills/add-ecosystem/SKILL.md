---
name: add-ecosystem
description: Add a package ecosystem to Drydock or extend an existing one's release paths. Use when creating a new directory under server/lib/ecosystems/, registering a staged/gate/publicDiff capability, implementing a WorkflowGateAdapter or PublicDiffAdapter, or deciding where ecosystem tests and docs belong.
---

# Add A Package Ecosystem

An ecosystem is one directory plus one registry entry. Adding one must never mean branching on the ecosystem name in a route or orchestrator — if shared code needs per-ecosystem behavior, it becomes an optional method on the adapter contract.

## Checklist

1. **Declare the ID and label** in `ECOSYSTEM_LABELS` in `server/lib/ecosystems/labels.ts`. This module is dependency-free so the browser bundle can import it; `EcosystemId` is derived from its keys and matches persisted `ecosystem` columns.
2. **Create the directory** `server/lib/ecosystems/<id>/`. All ecosystem-specific resolution, fetching, validation, and findings code lives here.
3. **Pick the release paths** the ecosystem supports — each is an optional, independent capability on `EcosystemModule` (`server/lib/ecosystems/types.ts`):
   - `staged` — the registry can hold a private release candidate (npm `stage publish`). Implemented as a `PackageAdapter` (`server/lib/ecosystems/package-adapter.ts`); npm is the only staged ecosystem today.
   - `gate` — a GitHub Actions publish job is held by an Environment deployment-protection rule while Drydock reviews the built artifacts.
   - `publicDiff` — two published versions diff anonymously on `/diff`, credential-free, nothing persisted to D1.
4. **Register it** in `ECOSYSTEM_MODULES` in `server/lib/ecosystems/index.ts`. Presence or absence of a field is the capability declaration — `supportedStagedEcosystems()`, `supportedWorkflowGateEcosystems()`, and `supportedPublicDiffEcosystems()` all derive from it, and `getWorkflowGateAdapter`/`getPublicDiffAdapter`/`getStagedAdapter` resolve adapters from it. Nothing else should enumerate ecosystems.
5. **Gate path (if supported):** implement `WorkflowGateAdapter` (`server/lib/workflow-gates/types.ts`) in `server/lib/ecosystems/<id>/workflow-gate.ts` — `ecosystem`, `artifactName`, `packageAdapter`, `classifyArtifact` (keep/drop bundle entries by path), `detectArtifact` (content-based claim for ambiguous archives; npm claims a root `package.json`, PyPI a root `PKG-INFO`), and `prepareReleaseCandidates` (group parsed artifacts by package identity, throwing `WorkflowArtifactError` from `server/lib/github-app/artifacts.ts` on inconsistency so the gate fails closed). `server/lib/workflow-gates/` stays ecosystem-agnostic plumbing: when one ecosystem needs extra behavior there, add an optional method to `WorkflowGateAdapter` — `narrowParsedArtifact?` (PyPI wheel dedup) and `shardedArtifactNames?` are the precedents — never an `ecosystem === "x"` branch.
6. **Public-diff path (if supported):** implement `PublicDiffAdapter` (`server/lib/public-diff/types.ts`) — name/version validation and normalization, cache identity (`rulesVersionSegment`, `payloadVersion`, `cacheTag`, and `cacheTtlSeconds` when release identity is mutable), `listVersions`, and `acquire` returning `PublicDiffAcquiredSources` (both sides' `FileRecord[]` + manifest summary, a `buildFindings` callback for the deterministic rules to run, and optional `notices`/`provenance`/`displayName`). The orchestrator in `server/lib/public-diff/index.ts` owns diffing, redaction, risk, and caching; the adapter only fetches bytes and picks rules. Adapters must stay credential-free and persist nothing.
7. **Keep artifact parsing in the sandbox.** Package bytes are hostile: archives are parsed by the shared credentials-free sandbox (`server/lib/sandbox.ts`), and adapters receive parsed `FileRecord[]`, never raw bytes plus a token. Manifests normalize into the shared `PackageJsonSummary` carrier rather than widening it.
8. **Tests, at the narrowest layer that covers the trust boundary:**
   - Adapter logic → a logic suite like `test/atpm.test.ts`; route/persistence behavior → `test/workers/` (e.g. `test/workers/public-diff-routes.test.ts`).
   - Adapter-level scan tests need at least one baseline-backed fixture asserting a `diff.*` rule ID (see `docs/security-detection-corpus.md`), so the adapter can't silently drop the package diff.
   - Registry behavior, staged discovery, workflow gates, and browser-visible flows → fake-registry e2e: a scenario directory under `test/e2e-fixtures/scenarios/<name>/` (`scenario.json` with `stageId`/`packageName`/`expected`, plus `previous/` and `staged/` package trees) driven by `test/e2e/local-registry.spec.ts`. A publicDiff-only ecosystem with no registry surface tests at the logic/workers layers instead.
9. **Docs:** update `docs/architecture.md`; `docs/workflow-gates.md` if gated; add an ecosystem doc when resolution is non-obvious (pattern: `docs/atpm-public-diff.md`) and list it in `docs/README.md`; extend the ecosystems bullet in `AGENTS.md` if the layout description changes.
10. **Verify:** `pnpm run verify` (plus `pnpm run test:e2e` when e2e scenarios changed).

## Worked Example: atpm (publicDiff-only)

atpm releases live in the publisher's own AT Protocol repository — no registry staging, no gate — so it registers exactly one capability.

- Registry entry: `atpm: { id: "atpm", label: ECOSYSTEM_LABELS.atpm, publicDiff: atpmPublicDiff }` in `server/lib/ecosystems/index.ts`; label added in `server/lib/ecosystems/labels.ts`.
- Directory: `server/lib/ecosystems/atpm/` — `identity.ts` (handle → DID → PDS resolution, host policy, name validation), `record.ts` (the `dev.atpm.alpha.package` lexicon record, version listing, blob/digest checks), `findings.ts` (record-vs-tarball integrity findings), `public-diff.ts` (the `PublicDiffAdapter`).
- Adapter details worth copying: `registryUrl` is the protocol identifier `at://` because there is no single host; `provenance` entries show the reader each resolution authority (DNS TXT, DID directory, PDS) as text, never links; `cacheTtlSeconds` bounds caching because handle→DID resolution is mutable; a version's tarball is an ordinary npm tarball, so `buildFindings` reuses `buildNpmFindings` from `server/lib/ecosystems/npm/findings.ts` and adds only atpm-specific checks.
- Tests: `test/atpm.test.ts` (identity, record parsing, digest and URL boundaries) plus the shared public-diff route coverage in `test/workers/`. No e2e-fixture scenario — there is no fake-registry surface for a publicDiff-only ecosystem.
- Docs: `docs/atpm-public-diff.md`, listed in `docs/README.md`; the `lib/public-diff/` and `lib/ecosystems/` bullets in `AGENTS.md` mention it.
