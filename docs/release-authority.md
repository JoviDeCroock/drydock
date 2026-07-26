# Release Authority

Release authority is _what was allowed to publish a release_, as opposed to what
the release contains. Drydock captures it at the GitHub Environment gate,
compares it to the last release a maintainer approved, and shows the delta as a
first-class section of the review.

## The gap this fills

Four different questions get conflated when people talk about supply-chain
trust. Keeping them apart is the whole point of this feature:

| Question                                                         | Answered by                                  | What it proves                                                                                                                     |
| ---------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Identity** — who published this?                               | Trusted Publishing / OIDC                    | This repository, this workflow, this environment, this run                                                                         |
| **Provenance** — where did these bytes come from?                | Build attestations, SLSA, sigstore           | The artifact was produced by a specific build                                                                                      |
| **Artifact integrity** — are these the bytes that were reviewed? | Digest continuity (`provenance.artifacts[]`) | The published file matches the reviewed file                                                                                       |
| **Maintainer intent** — is this the authority you agreed to?     | **Release authority**                        | The workflow's triggers, permissions, environment, publish path, and reusable-workflow graph still match the last approved release |

Trusted publishing authenticates a workflow identity and run context. It does
not establish that the workflow's current authority graph matches what
maintainers previously intended to approve. An attacker who lands a workflow
change keeps a perfectly valid trusted-publishing identity while silently
widening what that identity can do: dropping the environment that holds the
gate, deleting attestation steps, adding a manual trigger, repointing a
reusable workflow at a branch they control.

Provenance is not ineffective here — it answers a different question, and it
stays part of the evidence packet. It simply cannot tell you that the build it
attests to was authorized by the same graph as last time.

### Why this lives in Drydock and not in the registry

A concrete proposal to pin GitHub workflow content hashes in PyPI's Trusted
Publisher configuration ([warehouse#19702](https://github.com/pypi/warehouse/issues/19702),
[community#191125](https://github.com/orgs/community/discussions/191125)) surfaced the
gap, and PyPI maintainer feedback also showed why registry-side hash pinning is
the wrong layer: hashes are not available in OIDC claims, reusable workflows
complicate the model, exact hashes are brittle, and registry-side fetching
introduces quota and release-path failure modes.

Drydock is already in the release path with repository context and a blocking
gate, so it can run the comparison without asking any registry or OIDC provider
to change anything.

## Policy: review on authority change

The policy is **review on authority change**, not permanent workflow-hash
pinning. A pinned hash makes every edit a release-blocking event, which trains
maintainers to disable the check. Comparing against the last approved baseline
asks the question that actually matters — "is this still the authority you
agreed to?" — and stays quiet when the answer is yes.

Two distinctions carry most of the signal quality.

**Authority vs cosmetic.** Every workflow definition carries two digests: a
`rawDigest` over its bytes, which moves on any edit at all, and an
`authorityDigest` over its projected authority, which does not move for
comments, key reordering, or formatting. A release where raw digests moved but
authority digests did not reports `cosmetic` and never raises a high-signal
warning.

**Changed vs standing.** A reference that has _always_ been mutable
(`actions/checkout@v4`) is a standing property of this release path, not a
delta. A reference that _became_ mutable is a delta. The first is reported under
`standing`; the second is a high-significance change. Reporting standing
weaknesses as changes would make every release look like an incident; reporting
them nowhere would hide something real.

The same distinction governs coverage: a reusable workflow that was already
unreadable at the approved baseline is a standing limitation, while coverage
that _regressed_ against a complete baseline is a change.

## What is captured

`server/lib/release-authority/` holds the pure half; nothing in it touches the
network or the database.

- `yaml.ts` — a bounded, non-executing reader for the GitHub Actions YAML
  subset. Workflow definitions are repository content and are treated as
  hostile evidence: read and projected, never evaluated. It has no anchors,
  aliases, merge keys, tags, or custom types, and refuses anything past its
  size/line/depth/node limits. It is deliberately stricter than GitHub's parser,
  so it reports `complete: false` rather than silently dropping a job it could
  not read.
- `snapshot.ts` — projects fetched definitions, run context, and reviewed
  artifact digests into the canonical `drydock.release-authority.v1` snapshot.
- `delta.ts` — compares a snapshot against an approved baseline.
- `normalize.ts` / `normalize-delta.ts` — tolerant readers for the persisted
  blobs, following the `normalizeReleaseConsistency` pattern.
- `capture.ts` — the orchestration: fetch, project, compare, persist.

A snapshot records:

- the run: repository, environment, run id and attempt, entry workflow path,
  head commit, ref, event, actor and triggering actor;
- every workflow definition in the graph — the entry workflow plus every
  reusable workflow GitHub reports the run referenced, each with the sha GitHub
  already resolved it to, and both digests;
- triggers with their normalized branch/tag/path/type filters;
- workflow- and job-level permissions, including the `read-all` / `write-all`
  shorthands and the empty-block case;
- GitHub Environment names per job;
- every `uses:` reference with its ref, whether it is pinned to a 40-hex commit,
  and whether the call inherits secrets;
- detected publish steps (known publishing actions and publish commands);
- detected release safeguards (attestation, signing, provenance — including
  `with: attestations`/`provenance` inputs);
- artifact producer/consumer paths (`upload-artifact` / `download-artifact`);
- the reviewed artifacts with the digests the control plane recomputed;
- coverage: whether anything could not be read, and why.

### Coverage is best effort, and says so

A gate review must never fail because a reusable workflow lives in a repository
the installation cannot read. Anything unreadable is recorded as an unresolved
coverage entry, and the review states that the authority graph is incomplete.
An unreadable definition is exactly where a change would hide, so a partial
snapshot is never presented as "no authority change".

If the capture fails entirely, no record is written at all and the review shows
**not assessed** — which is deliberately a different thing from **unchanged**.

## What counts as a change

Detected deterministically, ordered here by significance:

**High** — permission widened; permissions block removed (the job falls back to
the repository default, which is usually broader than any explicit block);
environment changed or removed; publish step added; release safeguard removed;
an action reference that stopped being pinned; a reusable call that started
inheriting secrets; a dangerous trigger added (`workflow_dispatch`,
`pull_request_target`, `workflow_run`, `issue_comment`, `repository_dispatch`,
`schedule`); a trigger that lost every filter; the entry workflow path changed.

**Medium** — an ordinary trigger added; a trigger filter changed; a permission
added inside an existing block; a workflow added to or removed from the graph; an
action added; an action reference changed; a publish step removed; an artifact
path changed; the artifact set's shape changed; coverage regressed; a workflow
whose authority digest moved without any category above explaining it (a
deliberate safety net — a silent gap here is the exact failure this feature
exists to prevent).

**Low** — permission narrowed or removed; permissions block added; trigger
removed; safeguard added; an action reference that became pinned; a cosmetic
workflow edit.

### Artifact continuity

Artifact _digests_ are not diffed against the baseline: they change on every
release by construction, so diffing them would flag every release. What is
compared is the _shape_ of the artifact set — how many artifacts of each kind
the release produces. The digests are instead bound to the approval, below.

## The approval record

Approving a gate writes a durable record: `approved_at`, `approved_by_user_id`,
and an `artifact_binding_digest` — a digest over the sorted digests of the
reviewed artifacts. That binds the accepted authority to one specific release
rather than to a run id that could be re-run with different content. If any
reviewed artifact lacks a digest the binding is absent rather than partial, and
the review says so.

Only an **approved** snapshot becomes eligible as the next release's baseline. A
release that was reviewed but never decided, or one that was rejected, must not
become the thing later releases are measured against — otherwise a rejected
authority change would launder itself into the baseline.

The baseline boundary is `(organization, release target, entry workflow path)`.
A release target is already `(installation, repository, environment)`, so this is
exactly the "same repository / environment / release path" comparison: two
different release workflows publishing from one environment keep separate
baselines instead of flapping against each other.

The first gate on a boundary, and every scan predating this feature, reports
`no_baseline` — a neutral state, not a warning.

## Policy: holding a release

`organizations.require_authority_change_approval` is **off by default**. The
delta is recorded and shown on every gated review either way; the policy only
decides whether it blocks.

When it is on and the delta status is `changed`, approving requires
`acknowledgeAuthorityChange: true` in the decision request; without it the route
answers `409` with code `authority_change_acknowledgement_required` and the gate
is left completely untouched. The check runs before the per-package decision is
recorded, so a refused approval leaves no partial state.

Rejection is never gated on the acknowledgement. Blocking a release stays one
click — a maintainer who is unsure should not have to tick a box to say no.

Enforcement is deterministic and belongs to the GitHub Environment gate. The AI
reviewer may describe a delta but can never decide whether publication is
authorized, and the delta never modifies risk levels or deterministic findings.

## Surfaces

- **Scan detail** — a "Release authority" section above the diff, showing the
  status, each change with its significance and before/after, standing notes,
  the artifact binding, and the authority graph.
- **Gate decision dialog** — when the authority changed, a summary and the
  acknowledgement checkbox.
- **`GET /api/v1/github-app/workflow-gates/by-scan/:scanId`** — `releaseAuthority`
  and `organizationRequiresAuthorityApproval`.
- **`drydock.report.v1`** — a `releaseAuthority` block carrying the full
  snapshot, the delta, the binding digest, and the approval context. Null for
  staged-publish scans and for gates with no record; null means _not assessed_.
- **Settings → Release security** — the owner-only policy toggle.
- **Events** — `github_workflow_gate.authority_captured`, and
  `authorityChangeAcknowledged` on the gate decision event.

## Incident replay

`test/release-authority-incident-replay.test.ts` replays the compromised-publish
pattern the `bittensor-wallet` 4.0.2 incident made public: a release that keeps
building and publishing normally while the workflow behind it loses its
safeguards and gains authority.

Read the provenance note in that file before citing it. The two workflows are a
**reconstruction of the pattern**, written for the test — they are not copies of
the real repository's files, and no claim is made that they match them line for
line.

Detection is also not prevention. The claim "this would have been blocked"
requires the blocking path to run end to end, which is exercised separately
against the real decision route in
`test/workers/release-authority-gate.test.ts` ("holds approval on a changed
authority until it is acknowledged"). Do not describe the replay as prevention
on its own, and describe the underlying proposal discussions as independent
problem corroboration — not as GitHub or PyPI endorsement.

## Non-goals

- Asking PyPI, npm, or crates.io to store permanent workflow hashes.
- Treating every byte-level YAML change as security-sensitive.
- Letting a model decide whether publication is authorized.
- Claiming provenance is ineffective. It answers a different question and
  remains part of the evidence packet.

## Tests

- `test/release-authority-yaml.test.ts` — the bounded parser, including its
  limits and the completeness contract.
- `test/release-authority-delta.test.ts` — every change class, cosmetic-only
  edits, reusable workflows, mutable refs, artifact continuity, and coverage.
- `test/release-authority-source.test.ts` — graph ingestion, path safety, and
  that the installation token never leaves `api.github.com`.
- `test/release-authority-normalize.test.ts` — persisted-blob readers.
- `test/release-authority-incident-replay.test.ts` — the incident-shaped replay.
- `test/workers/release-authority-gate.test.ts` — capture, baseline eligibility,
  the blocking policy, and the report/API surfaces.
