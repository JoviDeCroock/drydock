# Intent envelope

Every completed scan carries an **intent envelope**: a deterministic,
advisory classification of how strongly the reviewed artifact is bound to a
source repository and a release intent. It is groundwork for a future
"Release Contract" feature and **never changes risk levels or findings** — it
only describes what an origin claim could later be verified against.

Computed in `server/lib/scan-pipeline.ts` via the pure module
`server/lib/intent-envelope.ts`, persisted inside the scan's `summaryJson`
blob (`summary.intentEnvelope`, no dedicated column), returned on
`ScanResult`, exported in the `drydock.report.v2` report as the optional
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

| Tier       | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `attested` | The binding is machine-verified. Either the release was **pushed by the CI action** (a GitHub-signed OIDC token binds repository + run + `job_workflow_ref` + commit, and the reviewed bytes arrived under that token — signal `ci-oidc`), or it came through a **GitHub workflow gate** (the signed `deployment_protection_rule` webhook binds repository + run + environment, and the bytes were downloaded from that run — signal `workflow-gate`). |
| `declared` | Not attested, but the staged manifest (package.json / PyPI core metadata / VSIX manifest) declares a parseable repository URL (`repository` as string or `{url}`, `git+https://`, `github:owner/repo`, …). Claimed, not verified.                                                                                                                                                                                                                      |
| `absent`   | No repository binding at all — the artifact cannot be tied to reviewed source.                                                                                                                                                                                                                                                                                                                                                                         |

Repository URLs are normalized to `https://host/owner/repo` for GitHub and
Bitbucket. GitLab keeps nested group namespaces
(`https://gitlab.com/group/subgroup/project`), and unknown hosts keep their
sanitized full path. Garbage never partially parses — it reads as `absent`.

## Claim ceiling

The tier is a ceiling on the strength of origin claims a future Release
Contract could make about the scan:

- `attested` can later support **proven** claims ("this artifact was built
  from run N of owner/repo") because the binding is machine-verified — by the
  signed OIDC token the bytes were uploaded under, or by the signed webhook
  plus the artifact download from that exact run.

  The two attested sources are not equally specific. A pushed release names the
  workflow file and ref that produced it (`job_workflow_ref`) and the commit; a
  gated one names only the run. When both are present — a pushed release whose
  gate later bound to it — the OIDC signal leads and the gate is recorded as a
  secondary signal.

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
