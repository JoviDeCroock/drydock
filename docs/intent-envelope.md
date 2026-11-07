# Intent envelope

Every completed scan carries a deterministic classification of its artifact's source and release-intent binding. **Authority:** advisory. **Owner:** `server/lib/intent-envelope.ts`.

## At a glance

| Thing | Owner file | Who may call / trigger | Pinned by (test) |
| --- | --- | --- | --- |
| Repository extraction | `server/lib/scan/pipeline-phases.ts` | `analyzeRelease`, before raw manifests leave scope | `test/intent-envelope.test.mjs` |
| Tier computation | `server/lib/intent-envelope.ts` | `server/lib/scan/pipeline.ts` | `test/intent-envelope.test.mjs` |
| Persistence and export | `server/lib/scan/pipeline-phases.ts` | Completed scans | `test/workers/scan-intent-envelope.test.ts` |

## Contract

```ts
interface IntentEnvelope {
  tier: "attested" | "declared" | "absent";
  repository: string | null;
  signals: Array<{ kind: string; detail: string }>;
}
```

| Tier | Evidence | Claim ceiling for a future Release Contract |
| --- | --- | --- |
| `attested` | Signed `deployment_protection_rule` webhook binds repository + run + environment; reviewed bytes downloaded from that exact run | Proven: this artifact was built from that repository's run |
| `declared` | Parseable manifest repository claim: npm `package.json`, PyPI core metadata or VSIX manifest | Consistent: contents may match declared source; package-controlled binding is claimed, never verified |
| `absent` | No repository binding | Not verifiable: nothing to check origin against |

| Boundary / shape | Contract |
| --- | --- |
| Extraction | `extractDeclaredRepository` needs raw manifest/core-metadata bodies; runs inside `analyzeRelease`, where those bodies remain available |
| Pipeline input | `ArtifactFacts.declaredRepository` carries a bounded canonical URL, never raw package-controlled value |
| Accepted declarations | String, `{url}`, `git+https://`, `github:owner/repo` and other supported repository forms |
| GitHub / Bitbucket | Normalize to `https://host/owner/repo` |
| GitLab | Keep nested group namespace: `https://gitlab.com/group/subgroup/project` |
| Unknown host | Keep sanitized full path |
| Garbage | Never partially parses; reads as `absent` |
| Storage | `summary.intentEnvelope` in `summaryJson`; no dedicated column |
| API | Returned on `ScanResult` |
| Report | Optional `intentEnvelope` in `drydock.report.v2` |
| UI | Scan detail “Source binding” row |

## Invariants

1. Intent metadata never changes risk levels or findings (`server/lib/intent-envelope.ts`).
2. A staged npm publish cannot reach `attested`: `StagedPublishDetails` has identity, actor and shasum, but no provenance attestation (`server/lib/intent-envelope.ts`).
3. A future staged provenance signal can promote the binding without changing the tier model (`server/lib/intent-envelope.ts`).
4. Every reader re-validates persisted data through `normalizeIntentEnvelope`, like `normalizeScanRiskBreakdown` (`server/lib/intent-envelope.ts`).

## Failure modes

| Condition | Cause | What happens | Fix |
| --- | --- | --- | --- |
| Missing envelope | Scan predates envelope persistence | Normalizes to `null`; UI hides row; export carries `"intentEnvelope": null` | Preserve compatibility in readers |
| Malformed envelope | Invalid persisted data | Normalizes to `null`, never a partial claim | Validate through `normalizeIntentEnvelope` |

## Change checklist

| If you change | Also update | Run |
| --- | --- | --- |
| Extraction, tiers or normalization | Artifact-facts boundary, persistence, API, UI and report readers | `pnpm exec vitest run --project node test/intent-envelope.test.mjs` |
| Persistence/export | [Release receipts](./release-receipts.md) and report schema | `pnpm run verify:file docs/intent-envelope.md` |
