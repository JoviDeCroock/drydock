# atpm trusted publishing and staged review

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
- the required Rekor signed-entry timestamp against a pinned transparency-log key before its integrated time is allowed to evaluate every certificate in the pinned Fulcio chain; a bundle with no authenticated entry is unverifiable;
- the DSSE signature over the in-toto statement;
- the statement's shape: exactly one subject, a readable npm purl, a SHA-512 digest;
- the Fulcio OIDs: issuer, source repository, ref, commit, build-config workflow, run invocation, runner environment, repository visibility. The issuer must be GitHub Actions, the runner must be `github-hosted`, and the repository must be `public`, matching atpm's own approval policy. The workflow is trusted only when Fulcio authenticated it into the certificate; publisher-controlled fields in the signed predicate are not an identity fallback.

Verification is _intrinsic_ to the bundle — it does not depend on the reviewed bytes or the request — which is what makes caching a small verdict per version sound instead of caching ~10 KB of bundle. Binding to the artifact happens afterwards, in `findings.ts`.

Two limits, stated because they bound what a page may claim:

- **The chain is pinned, not built.** A Fulcio intermediate rotation is a code change (`FULCIO_INTERMEDIATE_PEMS`), and until it lands, bundles issued under the new intermediate read as unverifiable rather than as verified.
- **The Rekor inclusion promise is verified, not the Merkle proof.** Drydock requires and verifies the log's signed-entry timestamp over the canonicalized body, integrated time, log ID, and log index against a pinned Rekor key. The logged body must bind the bundle's payload, signature, and signing certificate. This authenticates the timestamp used for certificate validity, but does not independently reconstruct the Merkle inclusion proof. Verification is capped at the newest 64 published versions per package record so a fabricated record cannot turn one anonymous request into unbounded cryptographic work; a staged review fetches and verifies only the one candidate its link names.

### Findings

| Rule                                 | Severity | Fires when                                                                                                                                                                         |
| ------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atpm.provenance-subject-mismatch`   | critical | the bundle verifies but attests a different package or different bytes — it was copied here                                                                                        |
| `atpm.provenance-invalid`            | high     | an attestation is present and does not verify                                                                                                                                      |
| `atpm.provenance-publisher-mismatch` | high     | the verified build came from a repository or workflow the publisher's own `trustPublisher` record does not declare, or the certificate does not authenticate a workflow to compare |
| `atpm.trusted-publishing-lost`       | medium   | the previous release proved where it was built and this one does not, or names a different repository                                                                              |
| `atpm.provenance-missing`            | low      | the package declares a trusted publisher and this version carries no attestation                                                                                                   |

`not-evaluated` is silence, never a finding: it means the per-record verification budget was spent elsewhere, and reporting an internal limit as a fact about the package would be inventing evidence. Staged candidates are compared with the published baseline too, so the review warns before approval would replace verified provenance with an absent, invalid, or differently sourced attestation.

### On `/diff`

The anonymous diff page renders a **Build provenance** block beside the resolution trail. A bundle is labelled **verified** only when its subject names this package and its SHA-512 matches the tarball Drydock downloaded; an intrinsically valid bundle copied from another artifact is labelled **different artifact**. The proven side (repository, certificate-authenticated workflow when present, ref, commit, run, runner, Rekor index) and the declared side (the `trustPublisher` record) are shown separately and labelled as such, because they are different kinds of claim: one came out of a signature check against Sigstore's root, the other is the publisher's statement of intent. A certificate with no authenticated workflow is explicitly shown as unable to match a trusted-publisher declaration. `allowPublish: true` is surfaced too — it means CI can publish with no human in the loop, which is a fact about the package's release posture rather than about any one release.

## Staged review

A `dev.atpm.alpha.stage` record is a release candidate: uploaded, not yet published. It is an ordinary public record in the publisher's repository with the tarball attached as a content-addressed blob, so Drydock can review one exactly the way it diffs a published release — over the protocol, credential-free, nothing routed through atpm.dev.

**Drydock takes no part in the decision that follows.** It shows what changed; approving or withdrawing a candidate happens in atpm, where it belongs. There is no approve button, no recorded verdict, and no credential that would let there be one. This is a review surface that atpm's dashboard links to, and deliberately nothing more — wiring the two systems together more tightly is worth revisiting once atpm's tag system is in place, because tags change what "which release does this replace?" even means.

### The link

```
https://drydock.org/api/public/v1/package-diff/atpm-stage?publisher=@handle.example&rkey=<rkey>
```

That is what atpm's staged dashboard puts beside a candidate, before anyone clicks publish. The contract is one-directional on purpose: atpm can write the URL from what it already has — the publishing account and the record key of the record it just created — with no API call, no id exchange, and no registration. Everything that needs resolving happens on Drydock's side, and the visitor lands on the ordinary `/diff` page for the result.

No account, on either side. A staged candidate is public data and the review is a deterministic diff of public bytes; a sign-in there would ask a maintainer to open an account with a third party to read something they could already fetch themselves, at the one moment the review is worth reading. The link stays inside the existing anonymous `/api/public/v1/package-diff` surface: IP rate-limited, no staged record or link resolution is persisted, and no session is read or created. Once the browser reaches the ordinary `/diff` review, its existing aggregate analytics may record the public package name but nothing about the visitor, as disclosed in [`security-model.md`](./security-model.md).

The endpoint uses content negotiation: a browser navigation (`Accept: text/html`) redirects to the review, while an API request receives the review URL and resolved baseline as JSON.

A link stops resolving once the candidate is approved — atpm deletes the record then — so that 404 is the expected end state of every one of these links rather than a broken one, and the page says so.

### A staged candidate is just another version

The redirect lands on a normal diff URL:

```
/diff/atpm/<did>/<name>/<baseline>/staged.<rkey>.<record-cid>
```

Rather than a second review surface that would drift from the published one, a staged candidate is something a version pair can point at. The whole of `/diff` therefore applies unchanged — caching, redaction, risk scoring, per-file fetches, share cards — and a maintainer deciding whether to publish sees the same page a consumer auditing the release will see afterwards. Two reserved spellings make that work, both inside the existing version grammar so nothing downstream needed widening:

- `staged.<rkey>.<record-cid>` in the `to` slot. The record CID is in the token because a staged record is mutable: without it, a rewritten candidate would be served from the cache entry of the bytes it replaced — on a page whose whole claim is "these are the bytes", the one kind of staleness that must not be possible. A rewritten candidate gets a different URL and the old one 404s. Published package records reject the reserved `staged.` prefix so a real version can never be mistaken for one of these tokens.
- `staged.none` in the `from` slot, for a first release with nothing published to compare against. Every file reads as added and a notice says why.

Drydock does not trust the PDS merely to echo that record CID. It re-encodes the returned value as DAG-CBOR and recomputes the CID locally before the value can become a review or cache entry.

The staged record must contain exactly one dist-tag targeting the candidate version, matching the shape atpm's CLI writes and the review can model without hiding additional tag moves. Baseline selection then prefers the published version behind that tag — approving moves it, so this is the sharpest answer to "what changes for someone who installs this?" — then the immediate semver predecessor, then the highest published version. Identity and published-record resolution reuse the same five-minute metadata cache as `/diff`; only the mutable staged candidate is fetched live before each staged review response, including a computed-diff cache hit.

### What a candidate is checked for

The npm rule set runs unchanged, plus the record-versus-artifact checks the published path uses:

- `stage.tarball-digest-mismatch` — the blob does not hash to the digest the record declares.
- `stage.metadata-mismatch` — the record and the tarball's `package.json` disagree, or the candidate's scope is not the publisher's verified handle. atpm's own stage endpoint rejects a foreign scope, so a candidate carrying one could not have been staged through it.

Plus every provenance finding above, which is where a pre-publish review earns most of its keep: a candidate whose attestation does not verify, or names a repository the publisher's own `trustPublisher` record does not declare, is worth knowing about _before_ it becomes a release rather than after.

## Host and credential policy

Unchanged from the public diff, and it applies to the staged path too: `assertPublicHttpsUrl` gates every host, redirects are resolved manually and re-checked per hop, identity documents read under 256 KiB and records under 4 MiB, and nothing on this path holds a credential of any kind. See [`security-model.md`](./security-model.md).

Deployments configured with a custom `NPM_REGISTRY` disable the staged link as well as the rest of the anonymous public-diff surface, before any identity or PDS fetch occurs.

## Not built

- **No approval or denial.** Deliberate, per review feedback: Drydock is a visual review surface here. Revisit after atpm's tag system lands.
- **No workflow gate.** A gate would hold atpm's approval job, which is the same decision as above.
- **No discovery, notifications, or dashboard.** Reviews are reached by link. Nothing polls a publisher's repository and nothing is persisted about one.

## Upstream notes

Two things worth raising with atpm:

- `dev.atpm.alpha.trustPublisher#github` has no `environment` field, and the OIDC exchange does not check GitHub's `environment` claim. Adding both would let a maintainer say "only jobs running in the `release` environment may publish".
- `POST /-/stage/package/:package` returns the `restrictedToPackage` rejection with no status code (HTTP 200 with an error body), while the same check elsewhere returns 403. A CI token scoped to package A staging package B gets a success status back.
