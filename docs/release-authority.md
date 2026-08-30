# Release Authority

Release authority is the workflow-carried control-plane evidence for _what was
allowed to publish a release_, as opposed to what the release contains. Drydock
captures it at the GitHub Environment gate, compares it to the last release a
maintainer approved, and shows the delta as a first-class section of the review.
Unavailable evidence is always explicit; nothing is inferred from mutable GitHub
settings the capture does not record.

## The gap this fills

Four questions get conflated when people talk about supply-chain trust:

| Question                                                         | Answered by                                  | What it proves                                                         |
| ---------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| **Identity** — who published this?                               | Trusted Publishing / OIDC                    | This repository, this workflow, this environment, this run             |
| **Provenance** — where did these bytes come from?                | Build attestations, SLSA, sigstore           | The artifact was produced by a specific build                          |
| **Artifact integrity** — are these the bytes that were reviewed? | Digest continuity (`provenance.artifacts[]`) | The published file matches the reviewed file                           |
| **Maintainer intent** — is this the authority you agreed to?     | **Release authority**                        | The workflow's authority graph still matches the last approved release |

Trusted publishing authenticates a workflow identity; it does not establish that
the workflow's current authority graph matches what maintainers approved. An
attacker who lands a workflow change keeps a valid trusted-publishing identity
while silently widening what it can do: dropping the gating environment,
deleting attestation steps, adding a manual trigger, repointing a reusable
workflow at a branch they control. Provenance answers a different question and
stays part of the evidence packet.

Registry-side workflow-hash pinning was proposed and rejected as the wrong layer
([warehouse#19702](https://github.com/pypi/warehouse/issues/19702),
[community#191125](https://github.com/orgs/community/discussions/191125)):
hashes are not in OIDC claims, reusable workflows complicate the model, and
exact hashes are brittle. Drydock is already in the release path with repository
context and a blocking gate, so it can run the comparison without asking any
registry or OIDC provider to change.

## Policy: review on authority change

Not permanent hash pinning — a pinned hash makes every edit release-blocking,
which trains maintainers to disable the check. The comparison asks "is this
still the authority you agreed to?" and stays quiet when the answer is yes.

Two distinctions carry the signal quality:

- **Authority vs cosmetic.** Each workflow carries a `rawDigest` over its bytes
  and an `authorityDigest` over its complete parsed semantics. Comments,
  key reordering, and display-only labels move only the raw digest and report
  `cosmetic`. Unknown parsed fields are included in the authority digest by
  default, so a new GitHub execution control is fail-closed — an unclassified
  semantic change is still a medium-significance, approval-requiring delta. A
  narrower `executionDigest` attributes condition/dependency/env-mapping/
  command/ordering/control changes without persisting their values.
- **Changed vs standing.** A reference that has _always_ been mutable
  (`actions/checkout@v4`) is a standing property of the release path, reported
  under `standing`. A reference that _became_ mutable is a high-significance
  change. Reporting standing weaknesses as changes would make every release
  look like an incident; reporting them nowhere would hide something real.

Incomplete coverage also produces a medium-significance change on every
affected release — unreadable source can hide a different authority each run,
so an opted-in organization must never accept it as `unchanged`. A regression
from a complete baseline, a complete capture against an incomplete baseline,
and an undecodable newest approved snapshot (`baseline_unreadable`, high) are
each labeled distinctly rather than treated as "no history".

## What is captured

`server/lib/release-authority/` holds the pure half; nothing in it touches the
network or database:

- `yaml.ts` — a bounded, non-executing reader for the GitHub Actions YAML
  subset: no anchors, aliases, merge keys, tags, or custom types, hard
  size/line/depth/node limits. Deliberately stricter than GitHub's parser, so
  it reports incomplete coverage rather than silently comparing a truncated
  workflow.
- `snapshot.ts` — projects fetched definitions, run context, and reviewed
  artifact digests into the canonical `drydock.release-authority.v1` snapshot.
- `delta.ts` — compares a snapshot against an approved baseline.
- `normalize.ts` / `normalize-delta.ts` — tolerant persisted-blob readers.
- `capture.ts` — orchestration: fetch, project, compare, persist.

`server/lib/github-app/workflow-source.ts` fetches the graph: the entry
workflow at the run's own commit plus every reusable workflow GitHub reports the
run referenced, each at its GitHub-resolved sha. A moving branch/tag ref is left
unresolved rather than letting today's tip rewrite historical evidence.

The snapshot records the run context; every workflow in the graph with raw,
authority, and execution digests; triggers with normalized filters; workflow-
and job-level permissions (an entry job inheriting GitHub's mutable repository
default is recorded as unresolved coverage — the run payload does not preserve
the effective default, so identical files must not hide a settings change);
GitHub Environment names per job; every `uses:` reference with its ref, pin
state, `secrets: inherit`, and a digest of its `with:`/`secrets:`
configuration; detected publish steps and release safeguards (shell commands
are stored as a safe category plus digest, never raw text that could hold a
credential); artifact upload/download paths; the reviewed artifacts' digests;
and coverage.

`$/` self-repository action references resolve at the running commit, so
Drydock digests the repository and action Git-tree identities plus the bounded
closure of nested `$/` composite actions. Workspace-relative `./` step actions
resolve from `github.workspace`, which an earlier step may have populated from
elsewhere, so they stay mutable with unresolved source rather than being
falsely attested.

### Coverage is best effort, and says so

A gate review must never fail because a definition is unreadable; the
unresolved entry makes the graph explicitly incomplete, and a partial snapshot
is never presented as "no authority change". If capture fails entirely, no
record is written and the review shows **not assessed** — deliberately distinct
from **unchanged**. Per-category list caps and the final 256 KiB persisted-size
budget follow the same rule: entries are omitted only alongside a
`limit_reached` coverage record. Tolerant readers preserve valid evidence from
a partially malformed persisted snapshot, but any undecodable entry forces
coverage to incomplete.

## What counts as a change

Detected deterministically:

- **High** — permission widened; permissions block removed with no
  workflow-level block left to inherit; environment changed/removed; publish
  step added; safeguard removed; an action that stopped being pinned; a call
  that started inheriting secrets; a dangerous trigger added
  (`workflow_dispatch`, `pull_request_target`, `workflow_run`, `issue_comment`,
  `repository_dispatch`, `schedule`); a trigger that lost every filter; a
  release arriving on an entry workflow path with no approved history while
  other paths have some.
- **Medium** — ordinary trigger added; trigger filter changed; permission
  added; workflow added/removed; action added; action ref changed; publish step
  removed; artifact path or artifact-set shape changed; incomplete/regressed
  coverage; a workflow whose authority digest moved without any category
  explaining it (the deliberate safety net).
- **Low** — permission narrowed/removed; permissions block added; trigger
  removed; safeguard added; action became pinned; cosmetic edit.

Artifact _digests_ are never diffed — they change every release by
construction. Only the shape of the artifact set is compared; the digests are
bound to the approval instead.

## The approval record

Approving a gate writes `approved_at`, `approved_by_user_id`, and an
`artifact_binding_digest` over the sorted reviewed-artifact digests, binding the
accepted authority to one specific release rather than a re-runnable run id. If
any reviewed artifact lacks a digest the binding is absent, not partial.

Only an **approved** snapshot becomes baseline-eligible — a rejected or
undecided authority change must not launder itself into the thing later
releases are measured against. Approval times advance strictly monotonically
per release target; that order is the revision fence for overlapping reviews.

The baseline boundary is `(organization, release target, entry workflow path)`
— i.e. same repository/environment/release path. A target with no approved
history anywhere reports `no_baseline` (neutral). A target with approved
history on _another_ path reports a high-significance `release_path_changed`
naming the previously approved paths: a second publish workflow leaves the
package diff clean while changing who may publish. When the run reported no
entry path at all, only the incomplete-coverage change is raised — no prior
path is invented.

## Policy: holding a release

`organizations.require_authority_change_approval` is **off by default**; the
delta is recorded and shown either way. When enabled, approval requires an
assessed authority record (`authority_assessment_required` on total capture
failure — never fail open) and, for a `changed` delta,
`acknowledgeAuthorityChange: true`.

Every approval carries the `authorityAcknowledgementToken` from the gate
lookup, bound to a digest of the exact delta displayed. The route recomputes
the delta against the currently approved baseline before accepting; a missing,
stale, or baseline-outdated token answers `409`
(`authority_baseline_changed` / `authority_change_acknowledgement_required`)
and leaves the gate untouched, so a durable approval can never bind a delta
that was not displayed. Rejection is never gated on any of this — blocking a
release stays one click.

Enforcement is deterministic and belongs to the GitHub Environment gate. The AI
reviewer may describe a delta but never decides whether publication is
authorized, and the delta never modifies risk levels or deterministic findings.

## Surfaces

- **Scan detail** — a "Release authority" section above the diff (also on
  failed workflow-gate reviews that remain approvable).
- **Gate decision dialog** — summary plus the acknowledgement checkbox when the
  authority changed.
- **`GET /api/v1/github-app/workflow-gates/by-scan/:scanId`** —
  `releaseAuthority` and `organizationRequiresAuthorityApproval`.
- **`drydock.report.v2`** — a `releaseAuthority` block with the full snapshot,
  delta, binding digest, and approval time; null means _not assessed_. The
  export has one serialization shared by the authenticated download, the public
  report body, and the attestation subject digest, and that surface carries no
  org/user identifiers (see [`security-model.md`](./security-model.md)):
  repository identities are aliased, actor logins and the approver id export as
  null, and the baseline keeps only `{ present: true }`. See
  [`public-reports.md`](./public-reports.md).
- **Settings → Release security** — the owner-only policy toggle.
- **Events** — `github_workflow_gate.authority_captured`, and a verified
  `authorityChangeAcknowledged` on the gate decision event (true only for an
  approval carrying the token for the exact changed delta).

## Incident replay

`test/release-authority-incident-replay.test.ts` replays the pattern the
`bittensor-wallet` 4.0.2 incident made public: a release that keeps building
and publishing normally while its workflow loses safeguards and gains
authority. The workflows are a **reconstruction of the pattern** written for
the test, not copies of the real repository's files. Detection is not
prevention: the blocking path is exercised separately against the real decision
route in `test/workers/release-authority-gate.test.ts`. Describe the proposal
discussions as independent problem corroboration, not GitHub/PyPI endorsement.

## Non-goals

- Asking registries to store permanent workflow hashes.
- Treating every byte-level YAML change as security-sensitive.
- Claiming to statically reproduce arbitrary repository code execution or
  mutable GitHub settings absent from the captured evidence.
- Letting a model decide whether publication is authorized.
- Claiming provenance is ineffective — it answers a different question.
