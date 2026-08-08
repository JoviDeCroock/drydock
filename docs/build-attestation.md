# Build attestation

Every workflow-gate review carries a **build-attestation verdict**: a
deterministic, advisory grade on whether a SLSA/in-toto build attestation exists
for the reviewed bytes, and whether what it claims agrees with what Drydock
already knows. It **never changes risk levels or findings**.

Computed in `server/lib/workflow-gate-job.ts` (`gradeCandidateAttestation`) from
the pure module `server/lib/build-attestation/`, persisted inside the scan's
`summaryJson` blob (`summary.buildAttestation`, no dedicated column), returned on
`ScanResult`, exported in the report as the optional `buildAttestation` field,
and rendered as the "Build provenance" section on the scan detail page.

## Where this sits among the four questions

Supply-chain trust conflates four separate questions. Keeping them apart is what
makes each one useful:

| Question                                                         | Answered by                        | Where it lives                                    |
| ---------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------- |
| **Identity** — who published this?                               | Trusted Publishing / OIDC          | outside Drydock                                   |
| **Provenance** — where did these bytes come from?                | Build attestations, SLSA, Sigstore | **this document**                                 |
| **Artifact integrity** — are these the bytes that were reviewed? | Digest continuity                  | `provenance.artifacts[]`, `artifact-integrity.ts` |
| **Maintainer intent** — is this the authority you agreed to?     | Release authority                  | `release-authority.md`                            |

Note the naming collision: the persisted key `provenance` and the report's
**Provenance** section are the _artifact integrity_ record — the artifacts
Drydock reviewed and the SHA-256s it recomputed from them. This feature is a
separate blob, `buildAttestation`, so neither has to be renamed.

The build-attestation verdict is also the natural next step for the intent
envelope's claim ceiling: `intent-envelope.md` says an `attested` tier "can
later support **proven** claims", and this is the evidence such a claim would
rest on.

## Sources

The wired source is the **GitHub artifact-attestation store**
(`server/lib/github-app/attestations.ts`):
`GET /repos/{owner}/{repo}/attestations/sha256:{digest}`, queried with the
existing installation token for each digest the control plane recomputed from
the immutable Actions artifact. The query sets `predicate_type=provenance` and
`per_page=8`, and the GitHub App must have the repository permission
**Attestations: read**. Existing installations must approve that permission
before private-repository lookups will succeed.

GitHub may return either an embedded Sigstore bundle or a `bundle_url` for a
Snappy-compressed bundle. URL-backed bundles are fetched without the
installation token, with redirects disabled, and with the same byte and time
limits as the API response.

That endpoint attests _files_, not packages, so it is ecosystem-neutral by
construction: npm tarballs, wheels, sdists and VSIXes all resolve through one
path with no per-ecosystem branching. Repositories opt in by running
`actions/attest-build-provenance` in the build job.

Staged npm publishes have no attestation source today (the staged registry
metadata exposes identity, actor and shasum, but no provenance), so they carry
no verdict. The npm registry's published-version attestations endpoint would be
the natural second source; it is not wired.

## Verdict lattice

Every level except `mismatch` is an absence-of-evidence state, not an
accusation.

| Status        | Meaning                                                                                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verified`    | An attestation covers a digest Drydock recomputed, its DSSE signature verified against the key in its own certificate, it agrees with at least one binding Drydock holds independently (repository or run), and it contradicts none.                          |
| `partial`     | An attestation covers the reviewed bytes and contradicts nothing, but either no signature verified, or the predicate names no repository/run to compare (the npm publish attestation, for instance, attests the publish event and carries no source binding). |
| `mismatch`    | An attestation exists and **contradicts** Drydock's own binding — different bytes, different repository, or different run. The only status that asserts something is wrong.                                                                                   |
| `absent`      | The lookup succeeded and no attestation covers these bytes. The common case.                                                                                                                                                                                  |
| `unavailable` | The lookup or parse failed. Evidence is missing, which is not evidence of wrongdoing.                                                                                                                                                                         |

Two rules shape the grading:

- **Agreement is monotonic.** A repository can retain several attestations for
  the same bytes after reruns. A `verified` or `partial` current-run candidate
  outranks a historical candidate whose run binding differs. `mismatch`
  remains the result when no agreeable candidate exists.
- **`verified` requires positive agreement, not merely absent disagreement.** An
  attestation that covers the right bytes but names no repository or run has
  nothing to corroborate, so it caps at `partial` however well it is signed.

A missing value on _either_ side of a comparison is `skipped`, never `fail` —
the same rule `evaluateStagedArtifactIntegrity` follows for digests. Accusing a
publisher of contradicting themselves requires two values that both exist.

## Trust ceiling — what `verified` does not mean

Drydock verifies the DSSE signature against the public key in the bundle's own
certificate. It does **not**:

- validate the certificate chain to a Fulcio root;
- check signed certificate timestamps (SCTs);
- verify Rekor transparency-log inclusion proofs;
- read the Fulcio certificate's OID extensions (which carry the repository and
  workflow identity Fulcio asserted from the OIDC token, rather than the
  self-asserted values in the payload).

So the signature check alone proves only that the bundle is _internally
consistent_. That ceiling is recorded on the verdict as
`trustCeiling: "self-consistent"` and stated in the UI, so no reader has to
remember the caveat.

**The load-bearing evidence is the cross-check, not the PKI.** At a workflow
gate Drydock already holds a repository + run binding that arrived on a
signature-verified GitHub webhook, and artifact digests it recomputed itself
from immutable Actions bytes. None of that is claimed by the package. An
attestation that agrees with all of it is corroborated by an independent
channel; one that disagrees is a contradiction worth surfacing — and neither
conclusion needs a certificate chain. Full Sigstore verification would raise the
ceiling for a _third party_ re-checking the report later; it is deliberately out
of scope here rather than quietly missing.

## Cross-checks

| Check            | Claimed by the attestation           | Compared against                                                     |
| ---------------- | ------------------------------------ | -------------------------------------------------------------------- |
| `subject-digest` | in-toto `subject[].digest.sha256`    | SHA-256 the control plane recomputed from the reviewed artifact      |
| `repository`     | build-definition source repository   | `github_workflow_gates.repository_full_name` from the signed webhook |
| `workflow-run`   | run id parsed from the invocation id | `github_workflow_gates.run_id` from the signed webhook               |
| `source-commit`  | resolved git commit                  | `head_sha` from `GET /repos/…/actions/runs/{id}`                     |
| `signature`      | DSSE signature                       | public key in the bundle's leaf certificate                          |

The `subject-digest` detail states coverage as a fraction ("attests 1 of 3
reviewed artifacts"). One attested wheel in a thirty-wheel release is a true
`pass` — the bytes it names really were reviewed — but reading that as "this
release is attested" would be wrong, so the fraction is always stated. Lookups
are capped at 8 digests per candidate (`MAX_DIGEST_LOOKUPS`); a release with
more artifacts than that has the remainder unchecked. Each digest lookup asks
for at most 8 provenance records, and each API or bundle response is capped at
1 MiB while streaming.

Digests are per **candidate**, not per bundle: a monorepo release fans out into
one scan per package, and each scan's lookup asks about its own artifacts only.
Attributing a sibling package's attestation to this scan would be exactly the
false corroboration the verdict exists to avoid.

## Predicate shapes

`server/lib/build-attestation/statement.ts` projects three shapes into one
`BuildClaim`, so the verdict never branches on predicate version:

- **SLSA provenance v1** (`buildDefinition` / `runDetails`) — what
  `actions/attest-build-provenance` and current npm provenance emit. The source
  commit is read from `resolvedDependencies`, not `externalParameters`: a build
  resolves a mutable branch ref to a commit, and that resolution is the
  interesting fact.
- **SLSA provenance v0.2** (`invocation.configSource` / `metadata`) — what npm
  provenance emitted before the v1 migration, still attached to versions from
  that era.
- **The npm publish attestation** — attests the publish event, carries no source
  binding, and therefore caps at `partial`.

Shapes are distinguished by structure rather than by the declared predicate type
string, which has carried several spellings over its life while the shapes have
not.

## Failure posture

Advisory and strictly non-blocking. Every failure path returns a verdict rather
than throwing:

- No attestation → `absent`. Most repositories publish none; this must stay
  quiet.
- Lookup, transport, or parse failure → `unavailable`, plus a
  `github_workflow_gate.build_attestation_unavailable` operational event.
- Advisory GitHub calls use one attempt with a 5-second deadline. Digest
  lookups run two at a time, so a slow or unavailable store does not serialize
  the full eight-digest allowance.
- A `mismatch` is logged at `warn`
  (`github_workflow_gate.build_attestation_mismatch`) and rendered with a
  severity tone, but it does **not** move risk, change the gate recommendation,
  or auto-reject. A human still decides.

A GitHub outage in the attestation store must never be able to stall a release.

## Persistence and re-validation

`normalizeBuildAttestation` re-reads the persisted blob under one governing
rule, the same one `normalizeIntentEnvelope` follows: **a persisted status must
not outlive the evidence that justified it**. A blob claiming `verified` without
a passing subject-digest check, a passing corroboration check, a passing
signature check, and a `self-consistent` ceiling reads as `null` rather than
rendering a build claim nobody established. Scans persisted before this feature
have no verdict and render nothing.

## Testing

- `test/build-attestation.test.ts` — DSSE/PAE encoding, the X.509 walk to
  SubjectPublicKeyInfo, DER→P1363 signature conversion, statement projection for
  all three predicate shapes, the verdict lattice, and the normalizer's
  downgrade rules.
- `test/workers/workflow-gate-job.test.ts` — the gate path end to end: embedded
  and URL-backed Snappy bundles, verified, mismatch, absent, and streamed
  oversized responses against a mocked GitHub attestation store.
- `test/helpers/sigstore-bundle.ts` — shared fixtures. The bundles are _really_
  signed: a fresh P-256 key signs the actual PAE bytes and its public key is
  carried in a DER certificate the parser must walk. A faked signature would
  leave the PAE encoding, the certificate walk, and the signature conversion
  untested, and each of those failing silently degrades every real attestation
  to `partial` instead of breaking loudly.

## Known gaps

- Certificate-chain, SCT, and Rekor-inclusion verification (see the trust
  ceiling above). Reading the Fulcio OID extensions is the highest-value next
  step: those values are asserted by Fulcio from the OIDC token rather than
  self-asserted in the payload.
- No npm registry attestation source, so staged publishes carry no verdict.
- `verified` means an attestation covers _some_ reviewed artifact, not that
  every artifact in the release is attested. The coverage fraction is stated in
  the check detail rather than encoded in the status; a per-artifact verdict
  would be the fuller answer.
- No finding for "the previous release had provenance and this one does not".
  That is a real signal, but it is a detection change and needs corpus and
  false-positive measurement first — see `security-detection-corpus.md`.
- `fetchWorkflowRunHeadSha` overlaps with the release-authority run-context
  fetch; whichever lands second should collapse them into one call.
