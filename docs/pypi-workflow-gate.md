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
- **Mode A (credential-free review)** does not. The workflow creates the
  session with its own credential. That credential can publish without
  Drydock, so the gate only reviews the stage. A compromised dependency in the
  ungated staging job (the ChainDrop pattern) can publish directly. Mode A is a
  review aid until PyPI offers stage-only trusted publishing; it is not
  enforcement.

There is no endpoint that lists sessions. The workflow names the release
through the gate: it uploads a `pypi-stage.json` file in the
`pypi-release-candidate*` artifact, which the GitHub App already authenticates
to the repository and run. A release without `pypi-stage.json` is reviewed
exactly as before.

`pypi-stage.json` has one entry per project. A single-project file may put the
entry's keys at the top level:

```json
{
  "schema": "drydock.pypi-stage.v1",
  "stages": [
    { "name": "demo-package", "version": "1.2.0", "session": "drydock" },
    {
      "name": "other-package",
      "version": "3.0.0",
      "stage-url": "https://pypi.org/<stage path from links.stage>/"
    }
  ]
}
```

- `"session": "drydock"` (mode B) asks Drydock to create and hold the session.
  `index` is optional (`https://pypi.org` by default, or
  `https://test.pypi.org`).
- `stage-url` (mode A) names a stage the workflow created.
- `session-url` is refused in every form. A workflow-created session must
  never become the one Drydock holds and publishes.

Unknown keys are ignored. An unknown `schema` fails closed: a workflow that
tried to bind a stage never falls back to an unbound review. Every
artifact distribution must belong to a registered project, and two artifact
files with the same basename (`a/x.whl`, `b/x.whl`) are rejected, because files
bind by basename.

Failures reject the held deployment with a `stage_*` reason that names the file
and digest prefixes, for example `stage_identity_mismatch:
demo_package-1.2.0-py3-none-any.whl sha256 differs: artifact 1a2b3c4d5e6f…,
stage 9f8e7d6c5b4a…`. Codes: `stage_reference_invalid` (bad or non-allowlisted
reference, or a mode B project without a stored token), `stage_unavailable`
(unreachable, refused redirect, oversized or malformed page, over the byte
budget), `stage_identity_mismatch`, and `stage_session_mismatch` (mode B).

### Mode B: Drydock creates, stages, and holds the session (opt-in per project)

**Opting in.** An owner or admin (the role that manages integrations) adds a
token under Settings → Integrations → PyPI project tokens
(`/dashboard/settings?tab=integrations#pypi-project-tokens`), or with
`POST /api/v1/pypi-project-tokens` (`{ project, index, token }`). The token must
be a PyPI API token scoped to that **single project**. Drydock reads the
token's caveats offline and refuses account-wide tokens, tokens for other or
several projects, and tokens whose scope it cannot confirm. Rotate with
`PUT /api/v1/pypi-project-tokens/:id`. `POST …/:id/validate` re-checks it
offline: PEP 694 has no credential probe, so nothing is sent to PyPI. Remove it
with `DELETE …/:id`. Every route needs a session and is scoped to the active
organization. The token is write-only: responses carry the project, index,
last four characters, and a fingerprint. Adding, rotating, checking, and
removing a token are audit events (`pypi_token.*`). The workflow then adds a
`"session": "drydock"` entry for the project.

**Staging.** The artifact's wheels and sdists are the release candidate,
reviewed as for any PyPI gate. Then Drydock:

1. looks up the organization's token for the project on the entry's index. If
   there is none, the deployment is rejected (`stage_reference_invalid`) before
   any request to the index;
2. `POST`s `{meta, name, version}` to the index's Upload 2.0 root
   (`https://upload.pypi.org/2.0/` for pypi.org, `https://test.pypi.org/2.0/`
   for TestPyPI). On `409` (a session for that release already exists, for
   example from an earlier attempt), it adopts the session the `Location`
   header names, after checking it against the same policy. The session must
   be `open`; otherwise the gate stays pending and staging can be retried once
   the session ends. If another gate of the organization still tracks the same
   index session, that row becomes `superseded`, so the older gate can neither
   publish nor cancel it; a session another gate is publishing or canceling
   blocks staging;
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
as `error`) leave the gate pending for a retried review, which adopts the same
session and restages it. Faults that show the index misbehaving (a refused
link, a redirect, a malformed answer, a stage that does not serve the uploaded
digests) reject the deployment.

**Human decisions.** Drydock never publishes or cancels on its own.

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
    session's state in the review shows that nothing was published. The
    protected job holds no PyPI credential, so no unreviewed bytes go out.
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
sessions are not extended. The cron never publishes, and never cancels a
session no maintainer rejected.

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
- Tokens belong to the organization, not to a repository. Any repository the
  organization gates can opt a project into Drydock-held staging, and Drydock
  will stage that repository's reviewed artifact under the organization's
  token for the project. The approval is still human and the bytes are still
  the reviewed ones, but the gate may belong to a different repository than
  the project's own. Binding a token to a repository is a follow-up.
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

### Mode A: credential-free review of a workflow-created stage

Drydock holds no PyPI credentials. The workflow creates the session and uploads
the files with its own credentials, then writes a `stage-url` entry. **The
credential that creates the session can publish it, so in mode A the gate does
not hold publish authority.** Use mode A to review what a stage holds; use mode
B where the gate must be the only way to publish.

For each registered project, the gate:

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
4. downloads each staged file within the remaining budget and a total body
   deadline, requires its sha256 to equal the digest the index declares, and
   parses it in the credentials-free sandbox. **These staged bytes are the
   release candidate**: the report's Provenance digests are the staged files'
   digests;
5. if the artifact also carries wheels/sdists for the project, requires byte
   identity between the two: the same filenames, the same sha256, and nothing
   extra on either side. Identical bytes reuse the artifact's parse;
6. checks the staged metadata's `Name` / `Version` against the registered name
   and version.

The gate decision releases the protected job, which is meant to publish the
session. A rejection, or a gate left pending, keeps that job from running, but
it does not stop the staging job's credential from publishing on its own.

**Egress.** The stage host comes from a workflow-controlled file, so every
request, including each redirect hop, must be https on an allowlisted origin:
index pages on `https://pypi.org` or `https://test.pypi.org`, and staged files
on that index's own origins (`pypi.org` + `files.pythonhosted.org`, or
`test.pypi.org` + `test-files.pythonhosted.org`). Stage URLs with credentials,
ports, query strings, or fragments are refused. Pages are capped at 8 MiB and
staged files at 25 MiB each, within the release budget above, and every
request and body read has a timeout. The allowlist is code, not configuration;
a self-hosted index cannot be used yet.

**Residual risk (mode A).**

- The staging job's credential can publish the session, or any other release,
  without Drydock. A compromised dependency in that ungated job can publish
  directly. Until PyPI offers stage-only trusted publishing, mode A cannot
  enforce the gate.
- Artifacts of a public repository's workflow runs can be downloaded by any
  signed-in GitHub user, so `pypi-stage.json` exposes the preview to them until
  the session is published or canceled. Keep the session short and cancel it
  when the release is rejected.
- The session stays editable by anyone with upload rights to the project
  between Drydock's review and the publish step. Upload the distributions and
  `SHA256SUMS` in the artifact too (Drydock then binds them to the stage), and
  have the publish job re-check the stage against `SHA256SUMS` immediately
  before it publishes.

A mode A workflow has a staging job with a trusted publisher that creates the
session, uploads `dist/*`, and writes `pypi-stage.json` with `stage-url` (from
`links.stage`), and a protected job that re-checks the stage against
`SHA256SUMS` and sends `POST links.publish`. Because the staging job's
credential can publish, Drydock does not ship a full mode A sketch; prefer
mode B.

### Capability secrets (both modes)

A stage URL, every file URL its page lists, and a session URL each grant
access to unpublished bytes or to the session. Drydock reads them in the
parent Worker (they never enter the sandbox), seals session and stage links
in D1 (mode B), and never writes them to logs, errors, scan artifacts, public
reports, or the UI. Errors name projects, files, and digest prefixes. The
report records only the index origin, `artifactBound`, and `managed`.

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
