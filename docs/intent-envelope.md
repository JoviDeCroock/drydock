# Intent envelope

Every completed scan carries an **intent envelope**: a deterministic,
advisory classification of how strongly the reviewed artifact is bound to a
source repository and a release intent. It is groundwork for a future
"Release Contract" feature and **never changes risk levels or findings** — it
only describes what an origin claim could later be verified against.

Computed in `server/lib/scan/pipeline.ts` via the pure module
`server/lib/intent-envelope.ts`. The declared repository it reads is not
extracted there: `extractDeclaredRepository` needs the raw staged manifest text
and, on PyPI, the core-metadata body, and both die at the `analyzeRelease`
boundary — so the extraction runs inside that boundary and arrives as
`ArtifactFacts.declaredRepository` as a bounded canonical URL, never as the raw
package-controlled value. The envelope is persisted inside the scan's `summaryJson`
blob (`summary.intentEnvelope`, no dedicated column), returned on
`ScanResult`, exported in the `drydock.report.v3` report as the optional
`intentEnvelope` field, and rendered as the "Source binding" row on the scan
detail page.

## Shape

```ts
interface IntentEnvelope {
  tier: "attested" | "declared" | "absent";
  repository: string | null; // normalized https://github.com/owner/repo (or gitlab/…)
  signals: Array<{ kind: string; detail: string }>; // human-readable evidence
}
```

## Tiers

| Tier       | Meaning                                                                                                                                                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attested` | The scan came through a GitHub workflow gate: the signed `deployment_protection_rule` webhook binds repository + workflow run + environment, and the reviewed artifact bytes were downloaded from that run.                       |
| `declared` | Not attested, but the staged manifest (package.json / PyPI core metadata / VSIX manifest) declares a parseable repository URL (`repository` as string or `{url}`, `git+https://`, `github:owner/repo`, …). Claimed, not verified. |
| `absent`   | No repository binding at all — the artifact cannot be tied to reviewed source.                                                                                                                                                    |

Repository URLs are normalized to `https://host/owner/repo` for GitHub and
Bitbucket. GitLab keeps nested group namespaces
(`https://gitlab.com/group/subgroup/project`), and unknown hosts keep their
sanitized full path. Garbage never partially parses — it reads as `absent`.

## Claim ceiling

The tier is a ceiling on the strength of origin claims a future Release
Contract could make about the scan:

- `attested` can later support **proven** claims ("this artifact was built
  from run N of owner/repo") because the binding is machine-verified by the
  signed webhook plus the artifact download from that exact run.
- `declared` caps at **consistent** claims ("the artifact's contents are
  consistent with what the declared repository publishes") — the manifest is
  package-controlled, so the binding itself is unverifiable evidence.
- `absent` caps at **not verifiable**: with no binding there is nothing to
  check a claim against.

## v1 constraints

- A staged npm publish cannot reach `attested`: the staged registry metadata
  Drydock receives (`StagedPublishDetails`) exposes package identity, actor,
  and shasum but no provenance attestation. If npm later surfaces provenance
  for staged versions, that signal can promote staged scans without changing
  the tier model.
- Scans persisted before the feature have no envelope. Every reader
  re-validates through `normalizeIntentEnvelope` (same pattern as
  `normalizeScanRiskBreakdown`): missing or malformed data reads as
  `null` — the UI hides the row and the report export carries
  `"intentEnvelope": null`.
