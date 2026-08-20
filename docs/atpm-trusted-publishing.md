# atpm trusted publishing, staged review, and workflow gates

[atpm](https://atpm.dev) supports trusted publishing the way npm and PyPI do: a GitHub Actions workflow proves its identity with an OIDC token, atpm checks it against a record the publisher wrote, and mints a short-lived credential scoped to one package. No long-lived token ever enters CI.

Drydock reads all of it, and holds none of it.

That is the unusual part and the reason this document exists. On every other ecosystem, reviewing a release before it ships requires a credential — npm's staged publishes are private registry state, and PyPI and the Marketplace have no staging at all, so CI has to upload a copy of the release for Drydock to look at. atpm needs neither. A release candidate is a public record in the publisher's own AT Protocol repository, its bytes are a content-addressed blob, and the trusted-publishing declaration sits beside it. So Drydock reviews an atpm release the same way it diffs a published one: over the protocol, credential-free, with nothing routed through atpm.dev.

See [`atpm-public-diff.md`](./atpm-public-diff.md) for how identity resolution and the published diff work; everything here builds on that resolution.

## The three records

All three live in the publisher's repository, under the identity Drydock already verifies bidirectionally.

| Record                          | Key          | What it says                                                                                      |
| ------------------------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| `dev.atpm.alpha.trustPublisher` | package name | which GitHub repo + workflow may act for this package, and whether it may stage, publish, or both |
| `dev.atpm.alpha.stage`          | TID          | an uploaded release candidate that has not been approved                                          |
| `dev.atpm.alpha.package`        | package name | the published package; what installs resolve against                                              |

`allowStage` and `allowPublish` split CI's permission in two, and that split is the whole mechanism behind everything below. A workflow with `allowStage: true, allowPublish: false` can upload a candidate and _cannot_ publish it. The release is paused by the publisher's own configuration, before Drydock or GitHub is involved.

## Build provenance

`npm stage publish --provenance` attaches a Sigstore bundle, and atpm verifies it at stage time. What it stores afterwards is a copy of that bundle inside a record the publisher can rewrite, so "atpm accepted this" is not a claim a reader of the record can check.

The bundle itself is checkable, so Drydock re-verifies it (`server/lib/ecosystems/atpm/provenance.ts`) against a pinned Sigstore root:

- the Fulcio certificate chain, using a bounded DER reader (`server/lib/platform/x509.ts`) rather than a general X.509 library — nothing here builds chains or consults a certificate store, because the accepted issuers are pinned constants;
- the DSSE signature over the in-toto statement;
- the statement's shape: exactly one subject, a readable npm purl, a SHA-512 digest;
- the Fulcio OIDs: issuer, source repository, ref, commit, run invocation, runner environment, repository visibility.

Verification is _intrinsic_ to the bundle — it does not depend on the reviewed bytes or the request — which is what makes caching a small verdict per version sound instead of caching ~10 KB of bundle. Binding to the artifact happens afterwards, in `findings.ts`.

Two limits, stated because they bound what a page may claim:

- **The chain is pinned, not built.** A Fulcio intermediate rotation is a code change (`FULCIO_INTERMEDIATE_PEMS`), and until it lands, bundles issued under the new intermediate read as unverifiable rather than as verified.
- **Rekor inclusion is not verified.** The transparency-log entry supplies only the signing timestamp used to evaluate the short-lived leaf's validity window, and that timestamp comes from the record. It cannot manufacture a signature — a Fulcio leaf is issued to one repository and its private key is ephemeral — so a forged timestamp buys nothing beyond skipping an expiry check. Verification is capped at the newest 64 versions per record so a fabricated version list cannot turn one anonymous request into unbounded work.

### Findings

| Rule                                 | Severity | Fires when                                                                                                         |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `atpm.provenance-subject-mismatch`   | critical | the bundle verifies but attests a different package or different bytes — it was copied here                        |
| `atpm.provenance-invalid`            | high     | an attestation is present and does not verify                                                                      |
| `atpm.provenance-publisher-mismatch` | high     | the verified build came from a repository or workflow the publisher's own `trustPublisher` record does not declare |
| `atpm.trusted-publishing-lost`       | medium   | the previous release proved where it was built and this one does not, or names a different repository              |
| `atpm.provenance-missing`            | low      | the package declares a trusted publisher and this version carries no attestation                                   |

`not-evaluated` is silence, never a finding: it means the per-record verification budget was spent elsewhere, and reporting an internal limit as a fact about the package would be inventing evidence.

### On `/diff`

The anonymous diff page renders a **Build provenance** block beside the resolution trail. The proven side (repository, workflow, ref, commit, run, runner, Rekor index) and the declared side (the `trustPublisher` record) are shown separately and labelled as such, because they are different kinds of claim: one came out of a signature check against Sigstore's root, the other is the publisher's statement of intent. `allowPublish: true` is surfaced too — it means CI can publish with no human in the loop, which is a fact about the package's release posture rather than about any one release.

## Staged review

A `dev.atpm.alpha.stage` record is a release candidate. Drydock reviews one through the ordinary scan pipeline, with the atpm adapter (`server/lib/ecosystems/atpm/index.ts`) in place of npm's.

What differs from every other staged or gated review:

- **No credential.** The adapter's broker holds nothing. `requiresConnection` is `false`, so the scan route and queue job never look for a stored token.
- **No byte-continuity gap.** The candidate is pinned by CID and approving it rebuilds and re-uploads nothing, so the artifact scanned is the artifact that installs. The npm and PyPI gates close that gap with a `SHA256SUMS` file the publish job re-checks; here there is no gap.
- **Drydock never approves.** Approval is a write to the publisher's repository and nothing here can perform it. The report instead names the candidate in the spelling the approving tool takes: `npm stage approve <id>`, where the id is derived locally as `uuidv5(<record uri>/<record cid>)` in the URL namespace — the same value atpm computes.

Staged references are addressed as `atpm:<did>:<rkey>`, which fits the shared `stage_id` column and its grammar. `POST /api/v1/scans` routes on that prefix; an unprefixed value is still npm's registry-issued id. Gate-driven reviews file their scan under the same address rather than the synthetic `workflow-gate:` id every other ecosystem uses, which is what stops the discovery sweep from reviewing a candidate the gate already covered.

Nothing scopes _which_ publisher an organization may review this way: an atpm candidate is public data, so a staged review is no more privileged than the `/diff` page for the same bytes. The scan row is organization-scoped as usual, and the per-organization scan rate limit is the bound on abuse.

Checks specific to a candidate, on top of the npm rule set and the provenance findings above:

- `stage.tarball-digest-mismatch` — the blob does not hash to the record's `dist.shasum`.
- `stage.metadata-mismatch` — the record and the tarball's `package.json` disagree, or the candidate's scope is not the publisher's verified handle. atpm's own stage endpoint rejects a foreign scope, so a candidate carrying one could not have been staged through it.

Baseline selection prefers the published version behind the dist-tag the candidate would move (approving moves that tag, so it is the sharpest answer to "what changes for an installer?"), then the immediate semver predecessor, then the highest published version. A first release reviews with no baseline rather than failing.

### Discovery

The discovery cron sweeps atpm publishers alongside npm connections. It has no credential to enumerate, so it reads the publishing accounts from release targets — configuring an atpm gate already names one. Candidates are deduplicated by stage id, and one sweep takes at most the 10 newest per publisher, so a repository with a backlog of abandoned candidates does not consume a scan quota on releases nobody is waiting for.

## Workflow gate

atpm does not need a gate to pause a release; `allowPublish: false` already does that. What a gate adds is where the pause is _visible_ and who ends it: the hold appears in the Actions UI, the decision is recorded against the deployment, and the approval runs from CI rather than a laptop.

So the atpm gate holds the **approval** job, not the publish job.

```yaml
name: Publish
on:
  push:
    tags: ["v*"]
permissions:
  id-token: write
  contents: read
jobs:
  stage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: "24"
      # The trusted publisher must have allowPublish: false, or this publishes
      # immediately and there is nothing left to gate.
      - run: npm stage publish --provenance
      - id: staged
        run: echo "id=$(npm stage list --json | jq -r '.items[0].id')" >> "$GITHUB_OUTPUT"
    outputs:
      stageId: ${{ steps.staged.outputs.id }}
  approve:
    needs: stage
    runs-on: ubuntu-latest
    environment: production # Drydock is the deployment-protection rule here
    steps:
      - uses: actions/setup-node@v6
        with:
          node-version: "24"
      - run: npm stage approve ${{ needs.stage.outputs.stageId }}
```

Setup: install the Drydock GitHub App, add Drydock as a deployment-protection rule on the environment, and map a release target for the repository with the **atpm publisher** field set to the publishing account (`@handle` or a DID). That field is what pins the target's ecosystem to atpm; leaving it empty keeps the target on auto-detect, which is the right default for every ecosystem that uploads its release artifacts.

### How a candidate is bound to a run

Other gates get their run-binding for free: the runner downloads the bundle from that run through the installation token, so the bytes came from the run by construction. An atpm candidate did not come from the run at all, so the adapter must establish the binding itself — and it uses the Sigstore certificate to do it.

A staged candidate is gated only when its **verified** provenance names both this repository and this run. Both values are read out of the Fulcio certificate, so neither is something the publisher's record can restate. The attempt number is ignored, since a re-run legitimately stages the candidate the gate is holding.

Consequences worth being explicit about:

- **An unattested candidate cannot be gated.** No provenance, no binding, no review — the gate errors (`candidate_not_bound_to_run`) and the deployment stays blocked. Use `--provenance`.
- **The binding is stronger than any other gate's.** An artifact name is a convention; a run invocation URI is inside a certificate Fulcio issued to that run's OIDC identity.
- **Every failure fails closed.** A misconfigured publisher (`release_target_misconfigured`), an unreadable repository (`bundle_unavailable`), or an unbindable candidate leaves the gate blocked and never auto-approves.

Shared plumbing for this lives behind one optional adapter method, `WorkflowGateAdapter.prepareReleaseCandidatesFromTarget` — declaring it replaces the artifact-bundle path entirely, so nothing is fetched, downloaded, or parsed from the run. See [`workflow-gates.md`](./workflow-gates.md).

## Host and credential policy

Unchanged from the public diff, and it applies to all of the above: `assertPublicHttpsUrl` gates every host, redirects are resolved manually and re-validated per hop, identity documents read under 256 KiB and records under 4 MiB, and nothing on this path holds a credential of any kind. See [`security-model.md`](./security-model.md).

## Upstream notes

Two things worth raising with atpm:

- `dev.atpm.alpha.trustPublisher#github` has no `environment` field, and the OIDC exchange does not check GitHub's `environment` claim. Adding both would let a maintainer say "only jobs running in the `release` environment may publish", which is what would make the environment-gated shape above enforced rather than conventional.
- `POST /-/stage/package/:package` returns the `restrictedToPackage` rejection with no status code (HTTP 200 with an error body), while the same check elsewhere returns 403. A CI token scoped to package A staging package B gets a success status back.
