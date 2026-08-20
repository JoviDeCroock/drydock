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
- the Fulcio OIDs: issuer, source repository, ref, commit, build-config workflow, run invocation, runner environment, repository visibility. The workflow is trusted only when Fulcio authenticated it into the certificate; publisher-controlled fields in the signed predicate are not an identity fallback.

Verification is _intrinsic_ to the bundle — it does not depend on the reviewed bytes or the request — which is what makes caching a small verdict per version sound instead of caching ~10 KB of bundle. Binding to the artifact happens afterwards, in `findings.ts`.

Two limits, stated because they bound what a page may claim:

- **The chain is pinned, not built.** A Fulcio intermediate rotation is a code change (`FULCIO_INTERMEDIATE_PEMS`), and until it lands, bundles issued under the new intermediate read as unverifiable rather than as verified.
- **Rekor inclusion is not verified.** The transparency-log entry supplies only the signing timestamp used to evaluate the short-lived leaf's validity window, and that timestamp comes from the record. It cannot manufacture a signature — a Fulcio leaf is issued to one repository and its private key is ephemeral — so a forged timestamp buys nothing beyond skipping an expiry check. Verification is capped at the newest 64 published versions per package record and the newest 64 staged records per listing so fabricated records cannot turn one anonymous request into unbounded cryptographic work. A staged PDS page is also rejected if it exceeds the requested 100-record limit.

### Findings

| Rule                                 | Severity | Fires when                                                                                                                                                                         |
| ------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atpm.provenance-subject-mismatch`   | critical | the bundle verifies but attests a different package or different bytes — it was copied here                                                                                        |
| `atpm.provenance-invalid`            | high     | an attestation is present and does not verify                                                                                                                                      |
| `atpm.provenance-publisher-mismatch` | high     | the verified build came from a repository or workflow the publisher's own `trustPublisher` record does not declare, or the certificate does not authenticate a workflow to compare |
| `atpm.trusted-publishing-lost`       | medium   | the previous release proved where it was built and this one does not, or names a different repository                                                                              |
| `atpm.provenance-missing`            | low      | the package declares a trusted publisher and this version carries no attestation                                                                                                   |

`not-evaluated` is silence, never a finding: it means the per-record verification budget was spent elsewhere, and reporting an internal limit as a fact about the package would be inventing evidence.

### On `/diff`

The anonymous diff page renders a **Build provenance** block beside the resolution trail. A bundle is labelled **verified** only when its subject names this package and its SHA-512 matches the tarball Drydock downloaded; an intrinsically valid bundle copied from another artifact is labelled **different artifact**. The proven side (repository, certificate-authenticated workflow when present, ref, commit, run, runner, Rekor index) and the declared side (the `trustPublisher` record) are shown separately and labelled as such, because they are different kinds of claim: one came out of a signature check against Sigstore's root, the other is the publisher's statement of intent. A certificate with no authenticated workflow is explicitly shown as unable to match a trusted-publisher declaration. `allowPublish: true` is surfaced too — it means CI can publish with no human in the loop, which is a fact about the package's release posture rather than about any one release.

## Staged review

A `dev.atpm.alpha.stage` record is a release candidate. Drydock reviews one through the ordinary scan pipeline, with the atpm adapter (`server/lib/ecosystems/atpm/index.ts`) in place of npm's.

What differs from every other staged or gated review:

- **No credential.** The adapter's broker holds nothing. `requiresConnection` is `false`, so the scan route and queue job never look for a stored token.
- **No byte-continuity gap.** The candidate is pinned by CID and approving it rebuilds and re-uploads nothing, so the artifact scanned is the artifact that installs. The npm and PyPI gates close that gap with a `SHA256SUMS` file the publish job re-checks; here there is no gap.
- **Drydock never approves.** Approval is a write to the publisher's repository and nothing here can perform it.

Checks specific to a candidate, on top of the npm rule set and the provenance findings above:

- `stage.tarball-digest-mismatch` — the blob does not hash to the record's `dist.shasum`.
- `stage.metadata-mismatch` — the record and the tarball's `package.json` disagree, or the candidate's scope is not the publisher's verified handle. atpm's own stage endpoint rejects a foreign scope, so a candidate carrying one could not have been staged through it.

Baseline selection prefers the published version behind the dist-tag the candidate would move (approving moves that tag, so it is the sharpest answer to "what changes for an installer?"), then the immediate semver predecessor, then the highest published version. A first release reviews with no baseline rather than failing.

### The public link

**A staged review needs no account, and the link is the product.**

```
https://drydock.org/stage/atpm/@handle.example/<rkey>
```

That is what atpm's staged dashboard puts beside a candidate, before anyone clicks publish. The contract is deliberately one-directional: atpm can write the URL from what it already has — the publishing account and the record key of the record it just created — with no API call, no id exchange, and no registration. Everything that needs resolving happens on Drydock's side, and the visitor lands on the ordinary `/diff` page for the result.

Anonymous is the design, not a relaxation. A staged candidate is a public record in the publisher's own repository, and the review is a deterministic diff of public bytes. A sign-in there would ask a maintainer to open an account with a third party in order to read something they could already fetch themselves — at exactly the moment the review is worth anything, which is the moment before they publish. It is the third anonymous surface alongside `/api/public/v1/package-diff` and `/public/reports/*`: credential-free, IP rate-limited, nothing persisted, no session read or created.

The redirect lands on a normal diff URL:

```
/diff/atpm/<did>/<name>/<baseline>/staged.<rkey>.<record-cid>
```

Which is the second half of the idea: a staged candidate is just another thing a version pair can point at, so the review reuses `/diff` end to end — caching, redaction, risk scoring, per-file fetches, share cards — instead of being a second review surface that would drift from the first. Two reserved spellings make that work, both inside the existing version grammar so nothing downstream needed widening:

- `staged.<rkey>.<record-cid>` in the `to` slot. The record CID is in the token because a staged record is mutable: without it, a rewritten candidate would be served from the cache entry of the bytes it replaced, which on a page whose whole claim is "these are the bytes" is the one kind of staleness that must not be possible. A rewritten candidate gets a different URL and the old one 404s.
- `staged.none` in the `from` slot, for a first release with nothing published to compare against. Every file reads as added and a notice says why.

`GET /api/public/v1/package-diff/atpm-stage?publisher=&rkey=` is the same resolution as JSON, for a caller that wants the review URL, the resolved baseline, and the approval id without following a redirect.

A link stops resolving once the candidate is approved — atpm deletes the record — so that 404 is the expected end state of every one of these links rather than a broken one, and it says so.

### Watching an account (optional)

Everything above needs no Drydock account. Enrolling one exists for a different job: a persistent dashboard, notifications, and an audit trail across releases, for a team that wants Drydock to notice a staged candidate rather than being linked to it.

Settings → Integrations → **atpm publishing accounts** takes a handle or DID and runs an AT Protocol OAuth sign-in against the account's _own_ server: the authorization server is discovered from that account's PDS (`/.well-known/oauth-protected-resource`), and the flow uses PAR, PKCE, and DPoP as the atproto profile requires.

Then the tokens are thrown away.

That is worth stating plainly, because it is the opposite of what "connect your account" usually means. Drydock needs no delegated access to an atpm publisher: staged candidates, published releases, and trusted-publisher declarations are all public records, and approving a release is something it deliberately does not do. A live session would buy nothing and would cost the property that makes this ecosystem path unusual — that it holds no credentials at all. So the flow is run for its identity assertion and nothing else, and `atpm_publishers` records the DID with a `verified_at`.

The proof is therefore not a security control — reading public records needs no permission. It decides _ownership_: whose releases appear in which dashboard, and where notifications go. Two organizations may enrol the same account, and each gets its own scans.

The only secret stored anywhere on this path is the ephemeral DPoP private key, held for the ten minutes an authorization request is in flight, sealed under its own HKDF domain, and deleted when the request is consumed.

### Picking up a staged release

For an enrolled account, three triggers converge on one deduplicated queue, keyed by the staged reference — which folds in the record's CID, so a record rewritten under the same key is a new review rather than a silent skip:

1. **The firehose** (`server/lib/ecosystems/atpm/firehose.ts`). A Durable Object subscribes to Jetstream filtered server-side to `dev.atpm.alpha.stage`, so every atpm stage on the network arrives as a small JSON event seconds after it is written. Events for accounts nobody enrolled resolve to an empty indexed lookup and stop there.
2. **The cron sweep** (\*/15). Backstop for anything a dropped connection missed. Sweeps enrolled publishers plus release targets that pin an atpm publisher, at most the 10 newest candidates per publisher per tick.
3. **"Check now"**, per publisher, rate-limited per organization.

The firehose exists because polling alone cannot do this job. atpm deletes a staged record on approval, so a candidate staged and approved in one sitting is not something a fifteen-minute sweep reviews late — it is something the sweep never sees, with nothing afterwards recording the miss.

**What the firehose is trusted for: nothing.** It is a doorbell. An event supplies one thing — a DID that just wrote a staged record — and that decides only _when to look_. The record it carries is ignored; discovery resolves the publisher's identity and re-fetches from that publisher's own PDS, verifying every claim as it would on a sweep. Jetstream is operated by a third party, and this is the same distinction already drawn for the DNS-over-HTTPS resolver in `identity.ts`: a hostile or broken instance can make Drydock miss a candidate or waste a lookup, and cannot make it review the wrong bytes or attribute them to the wrong publisher.

Operationally: `ATPM_FIREHOSE_URL` overrides the default Jetstream instance (point it at your own, or at a relay), and `ATPM_FIREHOSE_DISABLED=1` turns it off and leaves the cron in charge. A Durable Object holding an outbound socket stays resident, so this is one always-on object — a real, small, ongoing cost. The cron knocks on it every tick because a Durable Object does not start itself.

### Approving

Drydock does not approve. Approval is a write to the publisher's own repository, and nothing here holds a credential for it — which is the same reason enrolment discards its tokens.

What a review does instead is name the exact candidate it read, in the spelling the approving tool takes: `npm stage approve <id>`, where the id is the uuid derived from the record's URI and CID. The public JSON resolution returns it as `approveId` so atpm's own dashboard can show the command next to its link. In the dashboard, recording a decision surfaces the same command, and rejecting prints `npm stage rm` — atpm has no `reject` verb; a candidate is withdrawn by deleting its record.

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

Setup: install the Drydock GitHub App, add Drydock as a deployment-protection rule on the environment, and map a release target for the repository with the **atpm publisher** field set to an addressable publishing account (`@handle`, `did:plc`, or public `did:web`). Invalid or locally routed references are rejected when the target is saved. That field is what pins the target's ecosystem to atpm; leaving it empty keeps the target on auto-detect, which is the right default for every ecosystem that uploads its release artifacts.

### How a candidate is bound to a run

Other gates get their run-binding for free: the runner downloads the bundle from that run through the installation token, so the bytes came from the run by construction. An atpm candidate did not come from the run at all, so the adapter must establish the binding itself — and it uses the Sigstore certificate to do it.

A staged candidate is gated only when its **verified** provenance names this package, this repository, and this run. The package subject comes from the signed statement; repository and run come from the Fulcio certificate, so none is something the publisher's record can restate. The gate carries the selected record CID, subject, and SHA-512 into the scan, then requires the fetched record and downloaded tarball to match them. A candidate rewritten after selection or a valid bundle copied onto different bytes therefore fails the scan instead of becoming an advisory finding a reviewer could approve. The attempt number is ignored, since a re-run legitimately stages the candidate the gate is holding.

Consequences worth being explicit about:

- **An unattested candidate cannot be gated.** No provenance, no binding, no review — the gate errors (`candidate_not_bound_to_run`) and the deployment stays blocked. Use `--provenance`.
- **The binding is stronger than any other gate's.** An artifact name is a convention; a run invocation URI is inside a certificate Fulcio issued to that run's OIDC identity.
- **Every failure fails closed.** A misconfigured publisher (`release_target_misconfigured`), an unreadable repository (`bundle_unavailable`), or an unbindable candidate leaves the gate blocked and never auto-approves.

Shared plumbing for this lives behind one optional adapter method, `WorkflowGateAdapter.prepareReleaseCandidatesFromTarget` — declaring it replaces the artifact-bundle path entirely, so nothing is fetched, downloaded, or parsed from the run. See [`workflow-gates.md`](./workflow-gates.md).

## Host and credential policy

Unchanged from the public diff, and it applies to all of the above — including the OAuth flow, whose authorization server is a host the enrolling account chooses and therefore goes through the same policy as any other publisher-named host: `assertPublicHttpsUrl` gates every host, redirects are resolved manually and re-validated per hop, identity documents read under 256 KiB and records under 4 MiB, and nothing on this path holds a credential of any kind. The one secret that touches it is the ephemeral DPoP key described above, which is not a credential for anything: it authorizes a single token exchange whose result is discarded. See [`security-model.md`](./security-model.md).

## Upstream notes

Two things worth raising with atpm:

- `dev.atpm.alpha.trustPublisher#github` has no `environment` field, and the OIDC exchange does not check GitHub's `environment` claim. Adding both would let a maintainer say "only jobs running in the `release` environment may publish", which is what would make the environment-gated shape above enforced rather than conventional.
- `POST /-/stage/package/:package` returns the `restrictedToPackage` rejection with no status code (HTTP 200 with an error body), while the same check elsewhere returns 403. A CI token scoped to package A staging package B gets a success status back.
