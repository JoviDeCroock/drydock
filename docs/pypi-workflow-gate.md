# PyPI workflow-gate mode

This document covers PyPI review through a **GitHub deployment-protection
workflow gate**. pypi.org has no registry-staged artifact today, so the workflow
gate is the only review-before-publish path for PyPI packages. When PEP 694
staged previews ship, the same gate can review the staged bytes instead; see
[PEP 694 staged releases](#pep-694-staged-releases-preview).

It only describes what is PyPI-specific. The webhook ingestion, gate
persistence, artifact download + SHA-256 recomputation, approve/reject callback,
2FA step-up, monorepo fan-out, notifications, and timeout handling are all
**shared with the npm gate** and documented in
[`workflow-gates.md`](./workflow-gates.md). Read that first for the end-to-end
gate lifecycle.

## The release candidate

There is **no Drydock manifest file** to write. The boundary is the workflow
run's uploaded artifacts: CI runs `python -m build`, records checksums for
publish-time verification, and uploads one or more `.whl` files plus the sdist.
Small releases can use one `pypi-release-candidate` GitHub Actions artifact;
large compiled releases use `pypi-release-candidate-*` shards with one bounded
wheel/sdist upload per shard. Drydock treats every `.whl` / `.tar.gz` / `.tgz`
in that family as the release set; identity (`package` / `version`) is read from
each wheel's `METADATA` and the sdist's `PKG-INFO` after the bytes are parsed in
the credentials-free sandbox.

Integrity rests on **GitHub artifact immutability**, exactly like the npm gate:

- Drydock downloads the artifact bytes in the control plane and recomputes each
  wheel/sdist's SHA-256. That digest is the reviewed artifact's digest, surfaced
  in the report **Provenance** section, in the scan-detail API, and in the
  `report.json` export under `provenance.artifacts[].sha256`.
- The publish job downloads the **same immutable artifact**, re-verifies the
  digests, and uploads with `pypa/gh-action-pypi-publish` — it never rebuilds.
  The bytes Drydock reviewed are the bytes that get published.

Drydock synthesizes an internal release manifest
(`drydock.release-artifacts.v1`, `ecosystem: "pypi"`) from each artifact's parsed
identity plus the recomputed digest. The manifest is what the report and UI
render uniformly across ecosystems; maintainers never author it.

## Byte continuity

A reviewed wheel/sdist must be the **exact file** uploaded to PyPI. Rebuilding
after the gate breaks the boundary: a fresh `python -m build` can differ
byte-for-byte (timestamps, build-tool versions, file ordering) from the artifact
Drydock reviewed, so its contents were never reviewed.

The byte-continuity chain has three independently checkable links, all keyed on
the same SHA-256:

1. **Build** records `dist/SHA256SUMS` — the digest of every artifact it
   produced and uploaded.
2. **Review** — Drydock recomputes the digest from the immutable bundle bytes
   and shows it in the report Provenance section and the `report.json` export.
3. **Publish** re-verifies the downloaded bytes against `dist/SHA256SUMS` and
   fails closed on any mismatch before calling PyPI.

Because GitHub artifact storage is immutable, links 1–3 all hash the same bytes,
so an auditor can confirm `build digest == Drydock provenance digest == publish
digest` without trusting any single step.

## Auto-detection (no declared ecosystem)

A PyPI sdist `.tar.gz`/`.tgz` is byte- and filename-indistinguishable from an npm
`.tgz`, so a release target left on **auto-detect** (no pinned ecosystem) cannot
decide the ecosystem from the path alone. The gate resolves it by **content**
after parsing the archive in the credentials-free sandbox:

- a PyPI sdist carries a `PKG-INFO` at the root of its single top-level directory
  → **pypi**;
- an npm tarball carries a root `package.json` → **npm**.

This lives in the shared router (`server/lib/workflow-gates/resolve.ts`), which
also routes `.vsix` files to the VS Code adapter by extension (they are not
byte-ambiguous with tarballs). A single auto-detect gate therefore reviews npm,
PyPI, VS Code, or a mixed monorepo that publishes several. Pinning
`ecosystem: "pypi"` on the release target is supported but optional.

**Ambiguity fails closed.** Package contents are untrusted, and an archive that
presents as more than one ecosystem is rejected
(`artifact_identity_inconsistent`) rather than silently routed to one. PyPI's
`PKG-INFO` match is scoped to the sdist root location so a file vendored deep
inside an npm tarball does not look like a sdist. A genuine collision is resolved
by pinning the release target's ecosystem, which bypasses content detection.

## Monorepo

`python -m build` across several projects → `dist/*` fans out into one review per
package: artifacts are grouped by their normalized (PEP 503) name and each group
is scanned against its own previously-published baseline. The held deployment
releases only once every package is individually approved; rejecting any one
package blocks the whole release.

Every artifact must expose a `Name`/`Version`, and all artifacts that share a
normalized name must agree on the version, so a metadata-less or version-skewed
file slipped into a package's set is rejected (`artifact_identity_missing` /
`artifact_identity_inconsistent`) rather than silently shipped. Distinct package
names are kept apart — that is the expected monorepo shape, not a conflict.

## Baseline (currently-published version)

The baseline is the currently-published PyPI version, selected from the project's
public PyPI JSON metadata and downloaded from `files.pythonhosted.org`
(`acquireBaselinePyPi`, `pickPyPiBaselineRelease`). PyPI packages are public, so
no credential is attached for the baseline fetch. If no comparable published
release exists, the review runs without a baseline (full-tree review). Matching
platform baselines are downloaded and sandbox-parsed sequentially so a release
with dozens of wheels never inflates them concurrently.

A published release that exceeds the baseline download budget is a different
case from having no predecessor at all, and the review says so rather than
guessing. `BaselineInfo.comparisonSkipped` is set to `baseline-too-large`, every
finding is annotated `unknown` package context instead of a release delta, and
the report leads with "no baseline to compare" plus the version that was
skipped. Without that, an uncompared release would report its entire contents as
newly added — which for a compiled project means every `.pyd` raising a high
release-delta finding, and an advisory verdict of "block manual approval" that
no evidence supports. The gate's advisory recommendation becomes
`manual_review`: neither approval nor rejection is supported when nothing was
compared. The gate stays pending for a maintainer either way.

## Code sharing

PyPI review is deterministic-only and shares the package diff, risk model, and
redaction with every other adapter. The PyPI-specific pieces:

- `server/lib/ecosystems/pypi/` — `pypiAdapter`, the `PackageAdapter` the shared
  pipeline runs for a gated PyPI publish: artifact preparation
  (`preparePyPiArtifact`), baseline selection (`acquireBaselinePyPi`),
  deterministic PyPI findings (`pyPiReleaseFindings`), and `summarizeDetails`,
  which surfaces the reviewed digests as the report `provenance` block.
- `server/lib/ecosystems/pypi/workflow-gate.ts` — `pypiWorkflowGateAdapter`, the
  `WorkflowGateAdapter`: `classifyArtifact` (`.whl`/`.tar.gz`/`.tgz`),
  `detectArtifact` (root `PKG-INFO`), and `prepareReleaseCandidates` (group
  parsed artifacts by package identity → one candidate per package).

## Workflow shape

The publish job must verify the downloaded bytes before upload — this is what
makes "the reviewed bytes are the published bytes" checkable in CI rather than
assumed. The check runs in the repository's own job, so it holds only while the
workflow keeps it.

```yaml
jobs:
  build-release-artifacts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python -m build
      # Record the digest of every artifact Drydock will review. These are the
      # bytes the gate approves; the publish job re-verifies against them, and
      # they match the digests shown in the Drydock report Provenance section.
      - run: |
          shopt -s nullglob
          cd dist && sha256sum *.whl *.tar.gz *.tgz > SHA256SUMS
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate
          path: |
            dist/*.whl
            dist/*.tar.gz
            dist/*.tgz
            dist/SHA256SUMS
          if-no-files-found: error

  publish:
    needs: build-release-artifacts
    runs-on: ubuntu-latest
    environment: pypi # the gate: Drydock's deployment protection rule lives here
    permissions:
      id-token: write # OIDC for PyPI Trusted Publishing
      contents: read
    steps:
      # No checkout, no rebuild: GitHub artifact storage is immutable, so the
      # bytes the gate approved are the bytes we download and publish here.
      - uses: actions/download-artifact@v4
        with: { name: pypi-release-candidate, path: dist }
      # Fail closed if the downloaded bytes differ from what was built and
      # reviewed.
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      # SHA256SUMS is not a distribution; drop it so twine only uploads dists.
      - run: rm dist/SHA256SUMS
      - uses: pypa/gh-action-pypi-publish@release/v1
```

The `environment: pypi` line is the gate. Map the repository + environment on
`Organization settings → GitHub App` so the webhook can resolve a delivery to
your organization, then attach Drydock as a custom deployment protection rule on
that environment. The publish job stays blocked until a maintainer approves every
package's review in Drydock.

`Name`s are content-detected, so Drydock ignores `SHA256SUMS` in the bundle (it
is neither a wheel nor an sdist). PyPI strongly encourages configuring a GitHub
Environment for Trusted Publishers; the same environment carries the Drydock
gate.

### Large compiled releases

Projects that already build wheels in a platform matrix should upload each
matrix result as its own bounded shard. Pin the release target's ecosystem to
`pypi` and leave its optional artifact-name override blank: a pinned PyPI target
automatically selects the exact `pypi-release-candidate` name and every
`pypi-release-candidate-*` shard, while ignoring unrelated workflow artifacts.
Drydock processes one shard at a time but does not omit distributions from the
review or provenance.

Pinning is what unlocks the large-release budget. An auto-detect release target
has no name to narrow the run by, so it matches every non-expired artifact the
run uploaded and keeps the smaller single-upload budget (20 distributions,
50 MiB of artifact ZIPs) rather than downloading unrelated CI output. Shard
families are a PyPI-only behavior; the npm and VS Code gates still match their
conventional artifact name exactly.

Give each distribution exactly one shard. A matrix leg that runs a full
`python -m build` ships the sdist alongside its wheel, so the same
`*.tar.gz` lands in every shard: identical bytes are accepted once, but two
shards producing the same filename from a non-reproducible build fail the gate
with `artifact_identity_inconsistent` rather than binding two digests to one
manifest path. Build the sdist in its own job, as below.

```yaml
jobs:
  build-wheel:
    strategy:
      matrix:
        include: # project-specific
          - { shard: linux-x64, os: ubuntu-latest }
          - { shard: macos-arm64, os: macos-14 }
          - { shard: windows-x64, os: windows-latest }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - run: ./ci/build-wheel "${{ matrix.shard }}" # writes one or more dist/*.whl
      - run: cd dist && sha256sum *.whl > "SHA256SUMS-${{ matrix.shard }}"
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate-${{ matrix.shard }}
          path: dist/
          if-no-files-found: error

  build-sdist:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python -m build --sdist
      - run: cd dist && sha256sum *.tar.gz > SHA256SUMS-sdist
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate-sdist
          path: dist/
          if-no-files-found: error

  publish:
    needs: [build-wheel, build-sdist]
    runs-on: ubuntu-latest
    environment: pypi
    permissions:
      id-token: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          pattern: pypi-release-candidate-*
          merge-multiple: true
          path: dist
      - run: |
          cd dist
          for sums in SHA256SUMS-*; do sha256sum --check --strict "$sums"; done
          rm SHA256SUMS-*
      - uses: pypa/gh-action-pypi-publish@release/v1
```

## PEP 694 staged releases (preview)

> **Preview, draft spec.** [PEP 694](https://peps.python.org/pep-0694/) (the
> Upload 2.0 API with staged previews) is a draft and is not live on pypi.org.
> The stage-reference schema, fetch code, and session client are versioned and
> tolerant so they can follow the PEP, but nothing here has run against a real
> index yet.

PEP 694 lets a client create a publishing session, upload files into it, and
publish them later in one step. With staged previews, the index serves the
session's files at an unguessable **stage URL** before anything is public.

**PEP 694 has no stage-only credential.** Whatever can create a session or
upload into one can also `POST links.publish`, or use the legacy upload API.
That decides where publish authority sits:

- **Mode B (Drydock-held staging)** keeps it inside the gate. Drydock creates
  the session and uploads the reviewed bytes itself with an org-stored,
  project-scoped token. The workflow holds **no PyPI credential** at all.
- **Mode A (two gates, no Drydock credential)** keeps it in the workflow, but
  only after a human approved the reviewed bytes. Gate 1 reviews the build
  artifact. Once a maintainer approves it, the workflow's stage job mints a
  trusted-publishing token, stages exactly those files, and registers the stage.
  Gate 2 checks that the stage holds the reviewed bytes, and a maintainer
  approves the publish. The stage job holds a publish-capable credential
  between the two gates. That is the same exposure as today's gated publish
  job. Gate 2 adds staged-bytes verification and a window for consumers to test
  the preview. It does not add a stronger credential boundary.

There is no endpoint that lists sessions. The workflow names the release
through the gate: it uploads a `pypi-stage.json` file in a
`pypi-release-candidate*` artifact, which the GitHub App already authenticates
to the repository and run. A release without `pypi-stage.json` is reviewed
exactly as before.

`pypi-stage.json` has one entry per project. A single-project file may put the
entry's keys at the top level:

```json
{
  "schema": "drydock.pypi-stage.v1",
  "stages": [{ "name": "demo-package", "version": "1.2.0", "session": "drydock" }]
}
```

```json
{
  "schema": "drydock.pypi-stage.v1",
  "stages": [
    {
      "name": "demo-package",
      "version": "1.2.0",
      "stage-url": "https://pypi.org/<stage path from links.stage>/"
    }
  ]
}
```

- `"session": "drydock"` (mode B) asks Drydock to create and hold the session.
  `index` is optional (`https://pypi.org` by default, or
  `https://test.pypi.org`).
- `stage-url` (mode A, gate 2) names a stage the workflow created after gate 1
  was approved.
- One file uses one mode. Mixing `stage-url` and `"session": "drydock"`
  entries is rejected, because the two answer different gates.
- `session-url` is refused in every form. A workflow-created session must
  never become the one Drydock holds and publishes.

Unknown keys are ignored. An unknown `schema` fails closed: a workflow that
tried to bind a stage never falls back to an unbound review. Every
artifact distribution must belong to a registered project, and two artifact
files with the same basename (`a/x.whl`, `b/x.whl`) are rejected, because files
bind by basename.

Failures reject the held deployment with a `stage_*` reason that names the file
and digest prefixes, for example `stage_identity_mismatch:
demo_package-1.2.0-py3-none-any.whl sha256 differs: reviewed release
1a2b3c4d5e6f…, stage 9f8e7d6c5b4a…`. Codes: `stage_reference_invalid` (bad,
mixed, or non-allowlisted reference, or a mode B project without a stored
token), `stage_unavailable` (unreachable, refused redirect, oversized or
malformed page, over the byte budget), `stage_identity_mismatch`,
`stage_review_unlinked` (mode A: no approved gate-1 review to verify against),
and `stage_session_mismatch` (mode B).

### Mode B: Drydock creates, stages, and holds the session (opt-in per project)

**Opting in.** An owner or admin (the role that manages integrations) adds a
token under Settings → Integrations → PyPI project tokens
(`/dashboard/settings?tab=integrations#pypi-project-tokens`), or with
`POST /api/v1/pypi-project-tokens` (`{ project, index, repositoryId, token }`).
Each token is bound to **one repository**, chosen from the repositories the
organization maps to a PyPI (or auto-detect) release target; only that
repository's gates can stage with it, and a gate of any other repository is
rejected (`stage_reference_invalid`) before any request to the index. The
binding is fixed: to move a token to another repository, remove it and add it
again. The token must be a PyPI API token scoped to that **single project**.
Drydock reads the
token's caveats offline and refuses account-wide tokens, tokens for other or
several projects, and tokens whose scope it cannot confirm. Rotate with
`PUT /api/v1/pypi-project-tokens/:id`. `POST …/:id/validate` re-checks it
offline: PEP 694 has no credential probe, so nothing is sent to PyPI. Remove it
with `DELETE …/:id`. Every route needs a session and is scoped to the active
organization. The token is write-only: responses carry the project, index,
repository, last four characters, and a fingerprint. Adding, rotating, checking, and
removing a token are audit events (`pypi_token.*`). The workflow then adds a
`"session": "drydock"` entry for the project.

**Staging.** The artifact's wheels and sdists are the release candidate,
reviewed as for any PyPI gate. Staging runs while the gate's review is being
prepared, before the review result exists, so the held session (and its
installable stage preview) contains bytes still under review; nothing publishes
until a human approves. One delivery of a gate stages at a time: a staging
lease on the gate (30 minutes, taken over once it lapses) makes a concurrent
delivery wait and retry instead of deleting the first one's uploads. Drydock:

1. looks up the organization's token for the project on the entry's index. If
   there is none, or it is bound to another repository, the deployment is
   rejected (`stage_reference_invalid`) before any request to the index;
2. `POST`s `{meta, name, version}` to the index's Upload 2.0 root
   (`https://upload.pypi.org/2.0/` for pypi.org, `https://test.pypi.org/2.0/`
   for TestPyPI). On `409` (a session for that release already exists, for
   example from an earlier attempt), it adopts the session the `Location`
   header names, after checking it against the same policy. The session must
   be `open`; otherwise the gate stays pending and staging is retried. If an
   older gate of the same repository still tracks the same index session, that
   row becomes `superseded`, so the older gate can neither publish nor cancel
   it. A session another gate is publishing or canceling, or one a gate of
   another repository still tracks (left from before a token was re-added for
   another repository), blocks staging, which is retried;
3. stores the session and stage links sealed (AES-GCM) with the reviewed
   filenames and digests, in state `staging`;
4. removes any file an adopted session already holds, because Drydock cannot
   tell from the session which bytes those are;
5. reads the workflow run's artifacts a second time, one file at a time, and
   for each reviewed file requires the sha256 to equal the reviewed digest. It
   then opens an `http-post-bytes` upload declaring that size and sha256, posts
   the bytes to the index's `file_url`, and completes the upload, polling while
   the index processes it;
6. re-reads the session (open, exactly the reviewed files, all `completed`,
   any echoed name and version agree) and the session's stage page, and
   requires the staged digests to equal the reviewed ones;
7. moves the row to `held` and records `pypi_session.held`. The report's
   `provenance.stage` is `{ protocol: "pep694", index, artifactBound: true,
managed: true }`.

A failed upload is deleted from the session (`DELETE file-upload-session`).
The row becomes `upload_failed` with a detail that says whether the deletion
worked, and the session stays open but can never be published from that
state. Transient faults (unreachable index, `5xx`, an upload the index reports
as `error`, a held staging lease) leave the gate pending with a `retrying: …`
reason and go back to the queue, which retries the delivery with backoff (up
to three attempts); the retry adopts the same session and restages it. Once the
queue's attempts run out, a maintainer can retry the gate
(`POST /api/v1/github-app/workflow-gates/:gateId/retry`), which is allowed for
a pending gate with a failure reason and no scans or decisions. A gate whose
staging still has not reached a review 24 hours later, with no staging
activity since, is cleaned up by the cron (see Cron upkeep). Faults that show
the index misbehaving (a refused link, a redirect, a malformed answer, a stage
that does not serve the uploaded digests, an artifact whose bytes changed
between the review read and the staging read) reject the deployment.

**Human decisions.** Drydock never publishes on its own, and cancels on its
own only in the fail-closed cleanup of staging that never reached a review.

- _Approve._ When an approval looks like the one that completes the gate
  (every package approved), Drydock first re-reads each session and its stage
  page without changing anything. If a session is not `held`, is no longer open
  and bound, or a staged digest differs from the reviewed one, the session
  becomes `stale` and the approval is refused (HTTP 409,
  `held_release_not_publishable`). The maintainer can still reject. Otherwise
  the approval is recorded and the gate leaves `pending` in one
  compare-and-set. Only then does Drydock publish, project by project:
  immediately before each project's own claim it re-verifies that project's
  session and stage once more, so time spent publishing an earlier project
  cannot hide a change to a later one. A concurrent rejection, an automatic
  block, or a second approval can no longer land while a publish is in flight.
  The publish is recorded as `pypi_session.published`, attributed to the
  approving maintainer.
  - `201` means published. Any other `2xx` (including `200`) is treated as
    accepted but still processing and is polled for a few seconds; only `201`
    or a session that reads `published` counts as live. A publish still
    processing when the request ends is accepted: the approval is delivered and
    the cron keeps polling.
  - A definite failure _within the decision request_ turns the approval into a
    fail-closed rejection, normally before anything reaches GitHub (see the
    redelivery residual risk below for the exception). The gate shows
    `rejected`, the session settles as `error` or `stale`, and the route
    answers 409 `held_release_not_publishable`. Definite failures are: `409`,
    any other `4xx`, a refused URL or redirect, a processing publish that ends
    in `error` while the request is still polling, a session still `open` after
    a failed publish request, and, at the per-project re-check, a changed stage
    or a session or stage page that cannot be read. In a multi-project gate,
    one project may publish before another fails. The review then shows the
    gate as rejected and partially published, and the audit log has both
    events. The maintainer's own package decision stays "publish", so the
    scan's decision badge can still read approved while the gate is rejected.
  - A transport failure or `5xx` after the publish request is an unknown
    outcome. The session stays `publishing` and is polled, never handed back as
    `held`, because PyPI may already have accepted it. A session still reading
    `open` then was not accepted and becomes `error`. After an accepted
    publish, `open` may be a lagging read, so it counts as a refusal only 30
    minutes after the claim.
  - Drydock records when GitHub acknowledges a gate's decision
    (`decision_delivered_at`). The gate job delivers an approval only while
    every held session is `published` or `publishing`; `externally_published`
    does not count, because those bytes were not re-checked after the
    approval.
  - An approval GitHub has not acknowledged 30 minutes after the decision is
    settled by the cron. If every session is `published`, the cron delivers
    the approval, for up to six hours after the decision. If one is still
    `publishing`, it waits. Otherwise it records a fail-closed rejection
    (`decidedBy: automatic`, `reason: held_release_not_published`) and
    delivers that. The cron never publishes or cancels a session. Each session
    is claimed for publishing only while the gate is still `approved`, so a
    slow decision request stops at the next project once the cron has settled
    the gate.
  - An approval recorded as acknowledged by GitHub is never turned into a
    rejection. A publish that fails after that leaves the gate `approved`; the
    session's state in the review shows that nothing was published, Drydock
    records `github_workflow_gate.held_release_publish_failed`, and the
    organization's notification recipients get an email. The protected job
    holds no PyPI credential, so no unreviewed bytes go out.
- _Reject._ After the rejection is recorded, Drydock sends
  `DELETE links.session` for each `held`, `stale`, `staging`, or
  `upload_failed` session. A failed cancel stays `canceling` and the cron
  retries it. A session the index no longer knows counts as canceled. A
  fail-closed rejection after a failed publish cancels nothing, and neither
  does an automatic block.

The decision dialog shows each session's state beside the approve and reject
controls. It says "approving publishes it" only on a pending single-package
gate; a multi-package gate publishes once every package is approved, and a
closed gate publishes nothing.

**Cron upkeep.** Every 15 minutes, in bounded batches, Drydock re-reads each
held session at most every 10 minutes. It extends a session (`links.extend`,
7 days) when less than 48 hours remain, at most once every 6 hours. It stops
extending 30 days after staging, when GitHub drops the held deployment, and
once the gate closes without a maintainer's rejection (for example, an
automatic block), leaving that session alone to expire. A session published,
canceled, or errored outside Drydock settles as `externally_published`,
`externally_canceled`, or `stale`. A session the index no longer knows becomes
`expired`. The cron also polls `publishing`, retries `canceling`, and settles
unacknowledged approvals as described above. `staging` and `upload_failed`
sessions are not extended. The cron never publishes.

The cron cancels without a maintainer's rejection in one case, a fail-closed
cleanup rather than a release decision: a pending gate with no scan, no
review started, and no live staging lease, whose sessions are `staging`,
`upload_failed`, or `held` and whose gate and sessions have not changed for 24
hours. Nothing was reviewed or approved for such a gate. The cron rejects it
(`decidedBy: automatic`, `reason: staging_abandoned`), delivers the rejection,
and cancels its sessions so unreviewed bytes do not stay on the index. A
reviewed gate waiting on a human is never selected.

**Removing a token.** Deleting a project token moves that token's `held`,
`stale`, `staging`, `upload_failed`, and `canceling` sessions to
`token_removed`, which is terminal and shown in the review. Drydock can no
longer publish or cancel them, so they stay on the index until they expire,
and a later rejection does not try to cancel them. A `publishing` session keeps
its state, because the publish request already went out and may have
succeeded; its detail says the outcome can no longer be checked, and it is no
longer polled. Re-adding a token does not revive these sessions. A re-run
review restages only `staging`, `upload_failed`, `held`, or `stale` rows; a
session that is publishing, published, or canceled is never reset, and the
reason names its state.

```
create/adopt ──► staging ──(uploads verified on the stage)──► held
                   └──(upload or verify failed; file deleted)──► upload_failed
                                   (a retried review restages it)

held ──(approval recorded; per-project re-verify; claim)──► publishing ──► published
 │  │                 │ changed           │ 409/4xx, index error,
 │  │                 └──► stale          │ or still open ──► error
 │  │                                     └─ transport/5xx: unknown, polled
 │  └──(reject; also from stale, staging, upload_failed)──► canceling ──► canceled
 ├──(cron observes)──► expired | externally_published | externally_canceled | stale
 ├──(a later gate adopts the same index session)──► superseded
 └──(token deleted; also from stale, staging, upload_failed, canceling)──► token_removed

gate approved, GitHub has not acknowledged it 30 min after the decision:
  every session published     ──(cron)──► approval delivered
  any session publishing      ──(cron)──► wait
  otherwise                   ──(cron)──► gate rejected (fail-closed) and delivered;
                                          sessions left as they are
gate approved and acknowledged by GitHub: never changed by the cron
gate pending, never reviewed, staging idle 24 h ──(cron)──► gate rejected (fail-closed),
                                                            delivered, sessions canceled
```

Every terminal transition and `upload_failed` is an audit event
(`pypi_session.*`).

**Token egress.** Only `PyPiSessionGateway` attaches the token, and it runs in
the parent Worker. The token never enters the review sandbox. It is attached
only to:

- `POST` on the index's Upload 2.0 root itself (session creation);
- requests strictly under an allowlisted Upload 2.0 root (origin and path
  prefix) and on the origin of the session Drydock created: the session
  (`GET`, `DELETE`), `links.publish`, `links.extend`, `links.upload`, each
  file's `file-upload-session` and `complete` links, and the `http-post-bytes`
  `file_url`.

Every link comes from the index's own answers and passes the policy before
use. A `file_url` on another host, another allowed root's origin, or outside
the root (for example the legacy upload API) is refused before the bytes or
the token go out. Encoded path separators are refused. Token-bearing requests
never follow redirects: a `3xx` is an error, so a `Location` header cannot
carry the token elsewhere. JSON responses are capped at 1 MiB, every request
has a timeout, and byte uploads have their own longer one.

**Byte budget.** Each upload body is one reviewed distribution (at most
25 MiB, the artifact entry cap), held in memory one at a time. The whole
release spends the same 768 MiB budget as the sharded artifact path, across
both the second artifact read and the uploads.

**Workflow sketch (mode B).** The build job uploads the gate artifact with no
PyPI credential and no PyPI step. The protected job publishes nothing: when a
maintainer approves, Drydock has already published the session. Use it for
post-publish steps. There is no cancel job: Drydock cancels the session when a
maintainer rejects the gate.

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    permissions: { contents: read } # no id-token: this job cannot publish
    steps:
      - uses: actions/checkout@v4
      - run: python -m build
      - run: |
          cat > dist/pypi-stage.json <<'EOF'
          {"schema": "drydock.pypi-stage.v1",
           "name": "demo-package", "version": "1.2.0", "session": "drydock"}
          EOF
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate
          path: |
            dist/*.whl
            dist/*.tar.gz
            dist/pypi-stage.json
          retention-days: 1

  release:
    needs: build
    runs-on: ubuntu-latest
    environment: pypi # Drydock's deployment protection rule; approval publishes
    permissions: { contents: read }
    steps:
      - run: python ci/wait_for_release.py demo-package 1.2.0
```

Do not configure a trusted publisher or store a PyPI token in the repository
for a mode B project. Any workflow credential that can upload can also publish
and bypass the gate.

**Residual risk (mode B).**

- A stored project token can upload and publish **any** release of that
  project, not just reviewed ones. If Drydock were compromised, an attacker
  could use every stored token. That is why mode B is opt-in per project, the
  token must be project-scoped, and an organization can remove it at any time.
- A token is bound to the repository an admin chose when adding it. Drydock
  cannot confirm that this repository is the PyPI project's source: an admin
  who picks the wrong repository lets that repository's gates stage the
  project. The approval is still human and the bytes are still the reviewed
  ones.
- Two organizations can each store a token for the same PyPI project. PEP 694
  allows one session per release, so both adopt the same index session: one
  organization's staging replaces the other's uploads, and one organization's
  rejection cancels the session for the other. An approval still publishes
  only bytes that organization reviewed, because the per-project re-check
  runs first. Drydock scopes session rows per organization and cannot see the
  other organization's.
- PEP 694's publish request names the session, not file digests. Drydock
  re-checks the stage immediately before each project's publish, but a file
  replaced in the session between that read and the publish (by someone else
  holding an upload credential for the project) would still be published. The
  window is one round trip. Only the index can close it, by pinning digests at
  publish.
- Sealed session links and tokens use per-purpose HKDF keys with AES-GCM but no
  associated data, the same pattern as the Slack secrets. A database writer
  could swap two sealed values of the same purpose between rows; it could not
  read or forge them.
- A webhook or queue redelivery that lands after a session is claimed for
  publishing, but before PyPI answers, can deliver the approval to GitHub. A
  definite failure then leaves the gate `approved` with an `error` session.
  The protected job holds no credential, so the only effect is a misleading
  deployment status.
- A `publishing` session whose token was removed can no longer be polled. If
  its approving request also died before delivery, the gate stays `approved`
  and undelivered until GitHub's own decision window rejects the deployment.
- If recording GitHub's acknowledgement fails after a successful delivery, the
  cron may later turn that approval into a rejection GitHub will refuse, and
  Drydock's record then disagrees with GitHub's.
- After a failed publish request, a session read as `open` is treated as not
  accepted and the gate is rejected. If the index accepted the request but
  reports status lazily, it may still publish a release Drydock recorded as
  refused.

### Mode A: two gates, no Drydock credential

Drydock holds no PyPI credential. The workflow's trusted publisher creates and
publishes the session, and two Drydock gates sit in front of it. Each gate needs
its own human approval:

1. **Gate 1 (`pypi-stage` environment)** is the ordinary PyPI gate. The build
   job uploads `pypi-release-candidate` (the distributions and `SHA256SUMS`),
   and Drydock reviews those bytes. A maintainer approves. Only then does
   GitHub run the stage job and let it mint an OIDC trusted-publishing token.
2. **The stage job** downloads the artifact, re-checks `SHA256SUMS`, creates
   the PEP 694 session, uploads exactly those files, and reads `links.stage`.
   The installable preview exists from this point. The job then uploads a
   second artifact, `pypi-release-candidate-stage`, holding only
   `pypi-stage.json` with the `stage-url`.
3. **Gate 2 (`pypi-publish` environment)** links to gate 1 (see below), reads
   the stage, and requires the staged files to be exactly the files gate 1
   reviewed. It does not review again. The gate-2 package scan copies gate 1's
   report and adds a verification record. The decision dialog shows "Staged
   bytes verified identical to reviewed release", the preview's index, and a
   link to the approved review, beside the approve and reject controls. Any
   mismatch rejects the deployment automatically. Otherwise a maintainer
   approves the publish, typically after consumers have tested the preview.
4. **The publish job** re-checks the session against `SHA256SUMS` and sends
   `POST links.publish`.

**How gate 2 links to gate 1.** The link comes only from GitHub-signed webhook
fields already stored on both gates, never from anything the workflow uploads:

- the same organization (through the GitHub App installation), the same
  repository id, and the same workflow run id;
- a different gate, in a different environment. A re-run of gate 2's own
  environment is not its own approval;
- gate 1 is `approved`, and its package scan for this project and version is
  complete and approved (`decision = publish`);
- the gate-1 scan is a plain artifact review. It is not itself a stage
  verification or a mode B held session.

The reviewed digests come from that scan's Provenance (the sha256 of every
reviewed wheel and sdist). If gate 1 ran in more than one attempt of the run,
only a review whose files the stage holds exactly is accepted, and an
approval is void once a later attempt of gate 1 was rejected. With no link,
gate 2 rejects with `stage_review_unlinked`.

Gate 2 checks the stage when its job runs, and the dialog shows that time
beside the verified line, with a note that the session can change until it is
published. Drydock does not re-read the stage when the maintainer approves:
the stage URL is a capability Drydock never stores, so re-checking would mean
minting an installation token and downloading the run's artifacts and every
staged file again inside the decision request, and the workflow can still
change the session after that check. The publish job's `SHA256SUMS` re-check,
right before `POST links.publish`, is the check closest to the publish.

**What gate 2 checks**, per registered project:

1. reads the stage's simple-index project page (`<stage-url>/<normalized-name>/`),
   asking for PEP 691 JSON and accepting PEP 503 HTML;
2. selects every file for the registered version. Files for other versions are
   ignored, because a session publishes exactly one name and version, and so
   are unparseable filenames that do not name this project and version (an
   index may overlay older releases with legacy filenames). A file that names
   another project, an unparseable file that starts with this project and
   version, or a file with no sha256 or URL fails the check;
3. checks declared sizes (PEP 700 `size`, when the page lists it) against the
   25 MiB per-file cap and the release-wide 768 MiB budget before downloading
   anything;
4. requires the staged filenames and declared sha256 to equal the gate-1
   reviewed set: nothing extra, nothing missing, no duplicate basenames;
5. downloads each staged file within the remaining budget and a total body
   deadline, and requires its sha256 to equal the declared digest. The index's
   declared digest is only its claim; the download shows what a consumer gets.
   Staged bytes are hashed, never parsed or executed;
6. if gate 2's bundle also carries the build artifact's wheels and sdists (the
   default `pypi-release-candidate*` prefix picks it up), requires them to
   equal the reviewed set too.

A re-delivered gate-2 job is idempotent. Once the package scan is attached it
neither reads the stage again nor adds a scan.

**Egress.** The stage host comes from a workflow-controlled file, so every
request, including each redirect hop, must be https on an allowlisted origin:
index pages on `https://pypi.org` or `https://test.pypi.org`, and staged files
on that index's own origins (`pypi.org` + `files.pythonhosted.org`, or
`test.pypi.org` + `test-files.pythonhosted.org`). Stage URLs with credentials,
ports, query strings, or fragments are refused. Pages are capped at 8 MiB and
staged files at 25 MiB each, within the release budget above, and every
request and body read has a timeout. The allowlist is code, not configuration;
a self-hosted index cannot be used yet.

**Trusted publishing for both environments.** The stage job and the publish
job each need a PyPI token. PyPI's GitHub trusted publisher pins one workflow
file and, optionally, one environment. Configure **two trusted publishers** on
the project, one per environment: same owner, repository, and workflow file,
with environment `pypi-stage` on one and `pypi-publish` on the other. Each
token can then be minted only by a job that reached its environment, which
normally means passing its Drydock gate. GitHub lets repository
administrators bypass deployment protection rules unless "Allow
administrators to bypass configured protection rules" is unchecked on each
environment (it is on by default), and an admin can remove the rule; see
[Workflow Gate](workflow-gates.md). Uncheck it on both environments. Do not
leave the environment field empty to cover both jobs. An empty field lets any
job in that workflow mint a token, including the ungated build job that runs
the build backend and its third-party dependencies (the ChainDrop pattern).
Attach Drydock's deployment protection rule to both environments, and map
both environments to the repository on `Organization settings → GitHub App`.

```yaml
jobs:
  build-release-artifacts:
    runs-on: ubuntu-latest
    permissions:
      contents: read # no id-token: this job runs third-party build code
    steps:
      - uses: actions/checkout@v4
      - run: python -m build
      - run: cd dist && sha256sum *.whl *.tar.gz > SHA256SUMS
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate
          path: |
            dist/*.whl
            dist/*.tar.gz
            dist/SHA256SUMS
          if-no-files-found: error

  stage:
    needs: build-release-artifacts
    runs-on: ubuntu-latest
    environment: pypi-stage # gate 1: Drydock reviews the build artifact
    permissions:
      id-token: write # trusted publisher pinned to pypi-stage
      contents: read
    steps:
      # This job holds a publish-capable credential: no third-party actions,
      # no checkout of release code, nothing but the reviewed files.
      - uses: actions/download-artifact@v4
        with: { name: pypi-release-candidate, path: dist }
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      # Your PEP 694 client. It mints a PyPI token from the OIDC token,
      # POSTs the session for name + version, uploads every file listed in
      # SHA256SUMS (nothing else), and writes pypi-stage.json with
      # "stage-url" set to the session's links.stage. It never prints the
      # stage URL or the token.
      - run: python .github/pep694.py stage --sums dist/SHA256SUMS --out stage/pypi-stage.json
      - uses: actions/upload-artifact@v4
        with:
          name: pypi-release-candidate-stage
          path: stage/pypi-stage.json
          retention-days: 1

  publish:
    needs: stage
    runs-on: ubuntu-latest
    environment: pypi-publish # gate 2: Drydock verifies the staged bytes
    permissions:
      id-token: write # trusted publisher pinned to pypi-publish
      contents: read
    steps:
      - uses: actions/download-artifact@v4
        with: { name: pypi-release-candidate, path: dist }
      - run: cd dist && sha256sum --check --strict SHA256SUMS
      # Mints a token, re-opens the session (a create for the same name +
      # version answers 409 with the session's Location), requires its files
      # to equal SHA256SUMS exactly, then POSTs links.publish.
      - run: python .github/pep694.py publish --sums dist/SHA256SUMS
```

The `.github/pep694.py` client is yours: PEP 694 is a draft, and Drydock does
not ship an uploader for the workflow. The requests it makes are the ones
`PyPiSessionGateway` makes in mode B. A rejection at either gate keeps the
later jobs from running. After a gate-2 rejection, cancel the session (or let
it expire) so the preview stops being served.

**Residual risk (mode A).**

- Between gate 1 and gate 2 the stage job holds a token that can publish the
  session, or any other release of the project, without gate 2. It runs only
  after a human approved the reviewed bytes, and it should run nothing but
  first-party actions and your client. This is the same exposure as the
  non-staged gated publish job. Gate 2 adds verification and a testing window,
  not a stronger credential boundary. Use mode B where the gate must hold
  publish authority.
- The session stays editable by anyone with upload rights to the project
  until it is published, including the stage job's token while it is valid.
  Gate 2 proves what the stage held when it checked. The publish job's
  `SHA256SUMS` check narrows the window to the seconds before it publishes.
- Artifacts of a public repository's workflow runs can be downloaded by any
  signed-in GitHub user, so `pypi-stage.json` exposes the preview to them until
  the session is published or canceled. The preview holds only bytes a human
  already approved. Keep `retention-days` short and cancel rejected sessions.
- A run where gate 1 is re-run in its own environment after a stage exists is
  rejected rather than guessed at: start a new run.

### Capability secrets (both modes)

A stage URL, every file URL its page lists, and a session URL each grant
access to unpublished bytes or to the session. Drydock reads them in the
parent Worker (they never enter the sandbox), seals session and stage links
in D1 (mode B), and never writes them to logs, errors, scan artifacts, public
reports, or the UI. Errors name projects, files, and digest prefixes. A mode B
report records only the index origin, `artifactBound`, and `managed`. A mode A
gate-2 scan records the index origin, the reviewed gate and scan ids, and each
staged file's name and sha256 (`stageVerification`). Mode A never stores the
stage URL; gate 2 holds it in memory for the one check.

**Residual risk: Workers traces.** Production has Workers traces enabled with
`head_sampling_rate: 1` and `persist: true` (`wrangler.jsonc`). Automatic fetch
spans record full request URLs, so the stage page and staged-file fetches, and
mode B's session, upload, and `file_url` requests, persist those capability URLs
in Cloudflare's trace storage. The PyPI token itself travels in a header, not
the URL, and is not in the span. This is the same exposure as public-report
share tokens under 100% trace sampling, and it is left to that tracing
decision rather than changed here.

## Acceptance mapping (issue #308)

- _A GitHub Actions PyPI publish job waits on Drydock through a GitHub
  Environment gate_ — `environment: pypi` + the shared deployment-protection
  webhook path.
- _Drydock reviews every candidate wheel/sdist and records their SHA-256
  digests_ — the bundle bytes are recomputed (`processReleaseBundleForGate`) and
  bound into the synthesized `drydock.release-artifacts.v1` manifest.
- _Scan detail and report export expose the reviewed artifact digests_ —
  `pypiAdapter.summarizeDetails` emits a `provenance` block carried into
  `summary.stagedPublish` (scan detail) and `report.json`
  (`provenance.artifacts[]`).
- _The documented publish job verifies and uploads the reviewed bytes after gate
  approval_ — the `sha256sum --check --strict` step above.
- _Fail-closed on digest mismatch_ — gate ingestion rejects unsafe/inconsistent
  artifacts before any scan runs; the publish job's checksum step blocks upload
  on any byte drift.
