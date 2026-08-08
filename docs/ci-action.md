# CI release action (push path)

Drydock has two ways a GitHub release reaches review.

**Pull path** — the original [workflow gate](./workflow-gates.md). A protected
job asks its GitHub Environment for permission, GitHub sends a
`deployment_protection_rule` webhook, and Drydock downloads the run's uploaded
artifacts with an installation token and reviews them while the job waits.

**Push path** — this document. The `drydock/release-action` uploads the release
candidate to Drydock _as CI builds it_, authenticated by a short-lived GitHub
Actions OIDC token. Drydock reviews immediately. A deployment gate, if the
workflow has one at all, binds to that finished review later and collects the
decision.

Both paths converge on the same review: the same ecosystem adapters, the same
per-package fan-out, the same deterministic rules, the same workbench, the same
per-package decisions.

## Why invert the trigger

- **Review overlaps the build.** On the pull path nothing is reviewed until a
  job is already blocked. On the push path the review starts minutes earlier, so
  the protected job often finds a decision already waiting.
- **A human can decide before the gate exists.** Approve the release from the
  workbench while CI is still running; the gate is answered the moment it opens.
- **No credential in the repository.** OIDC replaces an API key.
- **No Actions-artifact naming convention.** The action says what the release
  is; nothing has to be inferred from an upload's name.
- **Works without an Environment at all.** A repository that just wants the diff
  can push, review, and never gate anything.

## Contract

| Step   | Endpoint                                          | Who calls it                            |
| ------ | ------------------------------------------------- | --------------------------------------- |
| Open   | `POST /api/ci/v1/releases`                        | every build job in the run (idempotent) |
| Upload | `PUT /api/ci/v1/releases/:id/artifacts/:filename` | each job, per artifact                  |
| Seal   | `POST /api/ci/v1/releases/:id/seal`               | the last job in the run                 |
| Status | `GET /api/ci/v1/releases/:id`                     | the action while polling                |
| Verify | `POST /api/ci/v1/releases/:id/verify`             | the publish job                         |

All five require an `Authorization: Bearer <OIDC token>` minted for the
`drydock` audience. These routes are mounted before the Better Auth and CSRF
middleware — a workflow runner carries no session cookie and sends no `Origin` —
and each handler re-derives the organization from the token's signed
`repository_id`. See [`security-model.md`](./security-model.md).

## Release sets

A **release set** is one run's release. Identity is
`(organization, repository, run, attempt, releaseKey)`, so every job in a matrix
build converges on the same set and a monorepo lands as one review that fans out
per package. Distinct package names become distinct scans with distinct
baselines and distinct approvals — approving `core` never approves `cli`.

`releaseKey` exists for a run that publishes several genuinely independent
releases and wants them approved separately.

States: `open` → `sealed` → `scanning` → `reviewed`, or `errored`.

**Sealing matters.** Only a sealed set is reviewed, so a matrix build cannot be
scanned half-uploaded. A set is sealed by an explicit seal call, or — if the
workflow forgot — by a deployment gate arriving for the same run, whichever
comes first.

## Byte handling

Uploaded bytes are hostile evidence and are treated exactly as the pull path
treats them: parsed only in the credentials-free sandbox, never executed.

The digest Drydock records is **recomputed from the received bytes** and compared
against the digest the action declared; a mismatch is rejected at ingest with 422. That digest is what appears as provenance and what the publish-time verify
step compares against.

Bytes live in R2 only between upload and the end of review, then are deleted.
The digests stay on the artifact rows as evidence; the packages themselves do
not outlive the review that needed them. Drydock is not a private-package
mirror.

Limits: 25 MB per artifact, 128 artifacts and 256 MB per release set, matching
the pull path's bundle envelope. Under concurrent uploads from a matrix build
these caps are approximate — each upload checks the current total before
writing — so they bound cost, not correctness.

Known gap for the prototype: a set that is opened and uploaded to but never
sealed keeps its bytes in R2, because deletion is driven by the end of review. A
bucket lifecycle rule on the `orgs/*/ci-releases/` prefix is the intended
backstop.

## Publish-time verification

`mode: verify` re-hashes the files the publish job is about to ship and compares
them against **what Drydock reviewed** — not against a checksum file CI produced
itself, which a rebuild would happily regenerate. Both directions are checked: a
reviewed artifact that changed or vanished, and an artifact appearing at publish
time that Drydock never saw.

A failed verification is recorded as a security-grade audit event
(`ci_release_set.verify_failed`) and fails the job.

## Gate binding

When a `deployment_protection_rule` delivery arrives, Drydock looks for a
release set matching `(organization, repository, run)`:

| Set state when the gate opens     | What happens                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `reviewed`, every package decided | the decision is delivered to GitHub immediately                                           |
| `reviewed`, undecided             | the set's scans are adopted as the gate's packages; the deployment stays held for a human |
| `open`                            | the gate seals the set and waits; the finished review re-runs the gate                    |
| `sealed` / `scanning`             | the gate waits; the finished review re-runs it                                            |
| `errored`                         | the deployment is **blocked** — an unreviewable release must not publish                  |
| no set                            | the gate falls back to the pull path and downloads the bundle                             |

Two deliberate conservatisms:

- A run that opened **several keyed release sets** binds nothing and falls back
  to the pull path. One gate row collects one review, and releasing a deployment
  that publishes three keyed releases because one was approved would be a real
  hole.
- A binding failure never throws. The pull path is always a correct fallback; it
  costs a duplicate download, not correctness.

Once bound, the gate reuses the entire existing decision surface unchanged —
`scans.gate_id` is backfilled, so `listGatePackageScans`, the per-package
decision route, the aggregate CAS, and the workbench all work as before.

## Decisions and 2FA

A pushed release is decided through the ordinary scan decision route
(`POST /api/v1/scans/:id/decision`), because it may have no gate yet.

That route treats a **release-gating** scan — one carrying a `gate_id` or a
`release_set_id` — as the irreversible action it is, and applies the same
two-factor step-up the gate decision route applies. A staged-publish decision
remains an audit record that publishes nothing and still needs no code. See
[`two-factor-auth.md`](./two-factor-auth.md).

## Provenance

The OIDC claims are signed by GitHub, so they are evidence rather than
assertions. A pushed release is `attested` in the
[intent envelope](./intent-envelope.md) with a `ci-oidc` signal carrying
repository, run, `job_workflow_ref`, and commit — strictly more specific than
the gate path's "a signed delivery mentioned run 123", because
`job_workflow_ref` names the workflow file and ref that produced the bytes.

## Configuration

| Binding            | Default                                       | Purpose                                                                                                            |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `CI_OIDC_ISSUER`   | `https://token.actions.githubusercontent.com` | OIDC issuer. **Never point this at a host you do not control** — it is the root of trust for every pushed release. |
| `CI_OIDC_AUDIENCE` | `drydock`                                     | Audience the action must request.                                                                                  |

The repository must already have a GitHub App installation and at least one
release target; that mapping is how an upload resolves to an organization. A
repository mapped by two organizations fails closed.

JWKS documents are cached for five minutes in `COMPARE_CACHE` plus a per-isolate
memo. A JWKS fetch failure answers 503 so the action retries rather than failing
the release.

## Workflow shape

See [`../action/README.md`](../action/README.md) for the full input reference.
The npm shape:

```yaml
permissions:
  contents: read
  id-token: write

jobs:
  pack:
    steps:
      - run: npm ci
      - run: npm pack
      - uses: drydock/release-action@v1
        with:
          path: "*.tgz"
      - uses: actions/upload-artifact@v4
        with: { name: npm-release-candidates, path: "*.tgz" }

  publish:
    needs: pack
    environment: production
    steps:
      - uses: actions/download-artifact@v4
        with: { name: npm-release-candidates }
      - uses: drydock/release-action@v1
        with: { mode: verify, path: "*.tgz" }
      - run: npm publish *.tgz
```

## Implementation map

- `server/lib/ci/oidc.ts` — JWT verification, JWKS cache, claim extraction.
- `server/lib/ci/repository.ts` — claims → organization, fail-closed on ambiguity.
- `server/lib/ci/ingest.ts` — filename/digest/body validation.
- `server/lib/ci/release-store.ts` — R2 storage and its deletion policy.
- `server/lib/ci/release-set-job.ts` — the review job.
- `server/lib/ci/gate-binding.ts` — webhook-side binding.
- `server/routes/ci-releases.ts` — the five endpoints.
- `server/db/ci-release-sets.ts` — persistence and CAS helpers.
- `server/lib/scan/review-packages.ts` — the per-package runner both paths share.
- `server/lib/workflow-gate-job.ts` — `resolveGateFromReleaseSet` is the bound-gate branch.
- `action/` — the action itself (dependency-free, unbundled).

Tests: `test/workers/ci-release-ingest.test.ts` (auth, resolution, lifecycle,
verification), `test/workers/ci-release-flow.test.ts` (review, fan-out, gate
binding), `test/workers/ci-release-decision-two-factor.test.ts` (step-up),
`test/workers/support/ci-oidc.ts` (local issuer that signs real RS256 tokens).
