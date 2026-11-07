# atpm

Drydock reviews published atpm packages and staged candidates through AT Protocol identity, records, and blobs. **Authority:** anonymous. **Owner:** `server/lib/ecosystems/atpm/public-diff.ts`.

## At a glance

| Thing | Owner file | Who may trigger | Pinned by (test) |
| --- | --- | --- | --- |
| Identity | `server/lib/ecosystems/atpm/identity.ts` | Public diff | `test/atpm.test.ts` |
| Records | `server/lib/ecosystems/atpm/record.ts` | Public diff | `test/atpm.test.ts` |
| Stage revision | `server/lib/ecosystems/atpm/stage-record.ts` | Candidate link | `test/atpm-public-diff-staged.test.ts` |
| Baseline | `server/lib/ecosystems/atpm/staged-review.ts` | Candidate link | `test/atpm-staged-review.test.ts` |
| Sigstore | `server/lib/ecosystems/atpm/provenance.ts` | Public diff | `test/atpm-provenance.test.ts` |
| Findings | `server/lib/ecosystems/atpm/findings.ts` | Deterministic review | `test/security-corpus-atpm.test.mjs` |
| Evidence card | `src/pages/Diff/TrustEvidence.tsx` | Reader | `test/diff-evidence-links.test.ts` |

## Contract

### Surfaces

| Method | Path | Auth / role | Result / owner |
| --- | --- | --- | --- |
| GET | `/diff/atpm/<did>/<name>/<from>/<to>` | Anonymous | Canonical review page |
| GET | `/api/public/v1/package-diff/atpm-stage?publisher=<publisher>&rkey=<rkey>` | Anonymous, IP limited | `server/routes/public-diff.ts` |

1. `ecosystem=atpm` resolves over AT Protocol, never through atpm.dev. An atpm release is an npm tarball; npm deterministic rules run unchanged.
2. atpm.dev is an npm-compatible App View: `.npmrc` setting `registry=https://atpm.dev` installs its packages. Drydock instead reads the publisher repository and blobs (`public-diff.ts`).
3. Handle-form input and detail URLs resolve before artifact loading and redirect to DID form. Verified `displayName` supplies `@handle/name` to page/title/share card; otherwise display the DID (`canonicalNames`).
4. `did:plc` identity is independent of handles. `did:web` ownership follows domain control; the page warns that DID spelling cannot permanently pin publisher ownership (`reviewNotices`).
5. Example published URL: `/diff/atpm/did:plc:twegdcgytckr5cxm57gyruxa/counter/0.0.14/0.0.15`; record: `at://did:plc:twegdcgytckr5cxm57gyruxa/dev.atpm.alpha.package/counter` (`@ebey.dev/counter`).
6. atpm trusted publishing exchanges GitHub Actions OIDC identity against the publisher declaration for a short-lived package credential; no long-lived token enters CI. Drydock holds neither credential (`provenance.ts` describes this upstream model).
7. The staged endpoint accepts publisher handle/DID and staged TID. `Accept: text/html` returns `302` to review; API requests receive `reviewPath`, `packageName`, `displayName`, `version`, `baselineVersion`. Responses vary on `Accept`.
8. Missing query parameters return `400`; the real JSON response is:

```json
{ "error": "publisher and rkey are required" }
```

9. No staged record/link resolution is persisted and no session is read/created. Ordinary diff aggregate analytics may record public package name, never visitor identity; see [security model](./security-model.md).
10. Custom `NPM_REGISTRY` disables anonymous public diff before identity/PDS fetches. There are no credentials on the atpm path (`server/routes/public-diff.ts`).
11. Drydock never approves, denies, gates, watches, discovers, polls, or notifies about atpm releases and has no publisher dashboard or recorded verdict (`src/pages/Diff/index.tsx`). Approval/withdrawal stays in atpm.
12. No package-only `/diff/atpm/<name>` form exists. Manifest dependencies get no diff links: npm would interpret `@handle/name` as an unrelated scope (`src/pages/Diff/index.tsx`).

### Resolution

| Step | Mechanism | Check in `identity.ts` / `record.ts` |
| --- | --- | --- |
| Handle → DID | TXT `_atproto.<handle>` through Cloudflare DoH | DNS ambiguity fails without fallback |
| DNS fallback | `https://<handle>/.well-known/atproto-did` | Only absent/unavailable DNS claims |
| DID → document | PLC directory or domain well-known DID JSON | Document `id` equals requested DID |
| Handle ↔ DID | `alsoKnownAs` claim | Document claims handle back |
| DID → display handle | Resolve first `at://` alias back to DID | Keep only if same DID; ignore other aliases |
| Document → PDS | `service[]` | Exact relative/DID-qualified `#atproto_pds`, type `AtprotoPersonalDataServer` |
| PDS → record | `com.atproto.repo.getRecord` | Collection `dev.atpm.alpha.package`, rkey = unscoped name |
| Record → blob | `com.atproto.sync.getBlob` | Resolved PDS + DID + CID; integrity below |

| Limit / policy | Constant / owner |
| --- | --- |
| Handle-form complete name ≤214 characters | `NPM_PACKAGE_NAME_MAX_LENGTH`, `server/lib/ecosystems/atpm/identity.ts` |
| DID-form key fits shortest public handle | `MAX_ATPM_RECORD_NAME_LENGTH`, same file |
| Identity documents ≤256 KiB | `MAX_IDENTITY_DOCUMENT_BYTES`, same file |
| Parent redirects ≤3 | `MAX_PUBLIC_HTTPS_REDIRECTS`, same file |
| Published records ≤4 MiB | `MAX_RECORD_BYTES`, `server/lib/ecosystems/atpm/record.ts` |
| Staged records ≤4 MiB | `MAX_STAGE_RECORD_BYTES`, `server/lib/ecosystems/atpm/stage-record.ts` |
| Newest 64 published versions verified | `MAX_VERIFIED_PROVENANCE_VERSIONS`, `server/lib/ecosystems/atpm/record.ts` |
| Five-minute metadata/pair freshness | `ATPM_PAIR_CACHE_TTL_SECONDS`, `server/lib/ecosystems/atpm/metadata-cache.ts` |
| Registry-backed pair default: 30 days | `CACHE_TTL_SECONDS`, `server/lib/public-diff/index.ts` |

### Records

| Collection | Key | Meaning |
| --- | --- | --- |
| `dev.atpm.alpha.trustPublisher` | Package name | GitHub repository/workflow may stage, publish, or both |
| `dev.atpm.alpha.stage` | TID | Public candidate, deleted after approval/withdrawal |
| `dev.atpm.alpha.package` | Package name | Published versions used by installs |

1. `allowStage: true, allowPublish: false` permits CI staging but cannot publish. `allowPublish: true` is shown as CI publishing without a human (`server/lib/ecosystems/atpm/trust-publisher.ts`).
2. Published entries require timestamp, object `meta` with name/version, nonempty `dist.tarball`, and complete blob CID/nonnegative integer size/MIME type. Optional embedded `$type` must equal the package lexicon's `#package` type (`parseVersionEntry`).
3. Legacy entries may omit `dist.shasum`; a present value must be a 40-character SHA-1 claim. Malformed versions are dropped but valid version names remembered; exact/`latest` requests for them fail `502`, never false `404` or an older selection (`record.ts`).
4. Duplicate syntactically valid version keys reject the record even when a duplicate is malformed. Unneeded manifest fields/readme are discarded; raw bundles become small verified verdicts before return/cache, never `AtpmVersion` fields (`record.ts`).
5. Staged records require exactly one tag targeting the candidate. Validate returned URI/key and recompute DAG-CBOR/SHA-256 record CID locally; never trust the PDS echo (`stage-record.ts`).
6. Candidate package must match the URL record key. Staged metadata additionally requires the publisher's currently verified handle (`atpmStagedFindings`).
7. Staged URLs use `staged.<rkey>.<record-cid>` in `to`. Replacement changes URL and makes the old one `404`; published versions reject the reserved `staged.` prefix (`server/lib/ecosystems/atpm/stage-ref.ts`).
8. `staged.none` in `from` is valid only for a first staged release with no published/unreadable versions; every file is added and a notice explains why (`public-diff.ts`).
9. Baseline precedence: version behind candidate tag → immediate semver predecessor → highest published version → first-release sentinel. An unreadable selected baseline fails `502`, never silently skips it (`selectBaselineVersion`).
10. Identity/published metadata share five-minute cache; mutable staged records are fetched live before every review response, including cached diffs (`validateCachedPair`).
11. atpm constructs a review link from publisher account and staged rkey without API exchange, ID exchange, or registration. The ordinary diff supplies caching, redaction, risk scoring, file fetches, and share cards (`resolveAtpmStagedReview`).

### Integrity and provenance

1. Sandbox computes wire SHA-256/SHA-512 alongside default SHA-1 only when requested. atpm requires SHA-256 to match canonical CIDv1 raw/sha2-256; present `meta.dist.integrity` requires matching readable SHA-512 SRI (`assertAtpmBlobDigest`, `assertAtpmArchiveIntegrity`).
2. Never follow `meta.dist.tarball`. Rebuild blob URL from PDS/DID/CID, then require declared install URL to identify that exact endpoint/DID/CID. Missing digest, malformed CID/SRI, truncation, or substitution fails acquisition (`assertAtpmTarballUrl`).
3. `npm stage publish --provenance` attaches a bundle atpm verifies at staging; its stored record copy is publisher-mutable. Drydock re-verifies rather than trusting “atpm accepted this” (`verifyAtpmProvenance`).
4. Fulcio roots/intermediates, Rekor keys/validity windows, and Fulcio extension OIDs are pinned in `server/lib/ecosystems/atpm/trust-roots.ts`. Bounded DER reader `server/lib/platform/x509.ts` verifies pinned chains without chain building or certificate-store lookup.
5. Required Rekor signed-entry timestamp authenticates canonical body, integrated time, log ID/index against pinned key. Logged body binds payload/signature/certificate; authenticated time checks every certificate in the Fulcio chain (`provenance.ts`).
6. Verify DSSE over in-toto statement with exactly one subject, nonempty subject name, and SHA-512 digest; `findings.ts` requires the exact npm purl for artifact binding. Fulcio OIDs authenticate issuer/repository/ref/commit/build-config workflow/run/runner/visibility (`provenance.ts`).
7. Require GitHub Actions issuer, `github-hosted` runner, and `public` repository. Publisher-controlled predicate fields never substitute for certificate-authenticated workflow identity (`atpmGithubCredentialPolicyError`).
8. Intrinsic bundle verification permits caching a small verdict; `findings.ts` subsequently binds it to downloaded bytes. Staged reviews verify only their named candidate (`record.ts`, `stage-record.ts`).
9. Chain is pinned, never built: intermediate rotation needs `FULCIO_INTERMEDIATE_PEMS` code change; until then verification fails closed and bundles are unverifiable. Rekor inclusion promise is verified, never independently reconstructed Merkle proof (`provenance.ts`).
10. Budget-exhausted `not-evaluated` is silence, never a finding or claim about the package (`provenanceFindings`).

| Rule | Severity | Condition in `findings.ts` |
| --- | --- | --- |
| `stage.tarball-digest-mismatch` | critical | Wire SHA-1 disagrees with `dist.shasum`; missing either digest is silence |
| `stage.metadata-mismatch` | critical | Missing tarball name/version or record/manifest name/version mismatch |
| `atpm.provenance-subject-mismatch` | critical | Verified bundle describes different package/bytes |
| `atpm.provenance-invalid` | high | Present attestation does not verify |
| `atpm.provenance-publisher-mismatch` | high | Artifact-bound build conflicts with declaration or lacks authenticated workflow |
| `atpm.trusted-publishing-lost` | medium | Artifact-bound baseline proves repository, target does not prove same repository |
| `atpm.provenance-missing` | low | Trusted publisher declared, attestation absent |

### Evidence card

1. Resolution and Build provenance share full-width card below header: divided columns wide, stacked narrow, single column when only one exists; fixed label/value alignment and separate caveats (`TrustEvidence.tsx`).
2. Proven build repository/workflow/ref/commit/run/runner/Rekor evidence stays separate from publisher declaration. “verified” requires matching subject and downloaded SHA-512; copied bundle shows “different artifact”; unauthenticated workflow is explicitly unable to match declaration (`describeAttestation`).
3. Links target handle TXT/well-known evidence, DID document, PDS `describeServer`, exact record `getRecord`, and GitHub repository/ref/commit/run. Proven workflow pins commit; declared workflow tracks default branch and can `404` (`src/lib/trust-links.ts`).
4. Rekor links use authenticated log instance plus log-local index: v1 entry or immutable v2 entry bundle. All hrefs rebuild parsed/validated/re-encoded parts against fixed hosts (`plc.directory`, `dns.google`, `search.sigstore.dev`) or validated bare hostnames; invalid values become plain text (`test/diff-evidence-links.test.ts`).

## Invariants

1. Handles lowercase; record keys never case-fold, preventing cache aliasing. Keys use lowercase npm subset of atproto grammar, including `~` (`identity.ts`).
2. Published name claims agree with each other and stable record key, never today's mutable handle; historical scopes remain valid (`manifestMismatches`).
3. Target record/artifact mismatches yield critical findings; baseline mismatches fail acquisition (`assertAtpmBaselineMetadata`).
4. `assertPublicHttpsUrl` requires HTTPS/default port, forbids credentials, IPv4/IPv6 literals, loopback, single-label names and reserved/local-use suffixes (`identity.ts`).
5. `RESERVED_TLDS` in `server/lib/ecosystems/atpm/identity.ts` forbids `.alt`, `.arpa`, `.example`, `.invalid`, `.local`, `.localhost`, `.onion`, `.internal`, `.intranet`, `.home`, `.lan`, `.test`.
6. PDS endpoints are bare origins: reject path/query/fragment instead of stripping them; reject nondefault-port self-hosted PDS deliberately to prevent port probing (`pdsEndpoint`).
7. Worker `global_fetch_strictly_public` routes global fetch, including same-zone hosts, through public Internet path (`wrangler.jsonc`).
8. Parent fetch disables automatic redirects and validates every hop (`reliablePublicHttpsFetch`). Blob redirects stay same-origin through `NpmStageGateway`/`fetchPinnedArtifact` in `server/lib/sandbox.ts`; credentialed npm redirect behavior stays unchanged.
9. Identity/record/declaration expiry bounds computed pair; KV, colo rewarm, versions, cards/display name use remaining lifetime, never restart five minutes (`metadata-cache.ts`, `server/lib/public-diff/index.ts`).
10. HTML metadata reads only small verified display-name KV value, never full diff just for a title (`server/lib/public-diff/page.ts`, `server/lib/public-diff/display-metadata.ts`).
11. Evidence link safety validates destinations, never vouches for publisher trust (`test/diff-evidence-links.test.ts`).

## Failure modes

| Condition | Cause | What happens | Fix |
| --- | --- | --- | --- |
| Staged link expires | Approval/withdrawal/deletion/replacement | `404`; browser explains candidate is no longer waiting | Published diff/new link |
| Bad publisher/rkey | Input grammar | API `400`; browser resolution errors `502` except `404` | Valid handle/DID + TID |
| Wrong bytes/install URL | Invalid digest/CID/SRI/endpoint | `502`; no review | Repair record/blob |
| Unreadable version | Invalid shape/duplicate key | `502`; unknown readable version `404` | Repair record |
| Declaration fetch error | Upstream outage | Acquisition fails, never becomes absent declaration | Restore upstream |
| Unreadable declaration | Malformed record | No declaration concluded | Repair declaration |
| New Fulcio intermediate | Anchor absent | Unverifiable provenance | Review/update anchors |

## Change checklist

| If you change X | Also update Y / run Z |
| --- | --- |
| Identity/host policy | Identity rules/cache scope; `test/atpm.test.ts`, `test/workers/atpm-stage-link.test.ts` |
| Records/integrity | Record rules/cache scope; `test/atpm.test.ts`, `test/atpm-public-diff-staged.test.ts` |
| Stage/baseline | `test/atpm-staged-review.test.ts`, `test/atpm-public-diff-staged.test.ts` |
| Provenance | Roots/rules/cache scope/corpus; `test/atpm-provenance.test.ts`, `test/security-corpus-atpm.test.mjs` |
| Evidence/UI | `test/diff-evidence-links.test.ts`, `test/atpm-diff-page.test.ts` |

## Why

Protocol authorities preserve independently checkable resolution when the npm-compatible atpm.dev App View is unavailable or disagrees.
Mutable version→CID mappings, PDS location, and verified display handle require short absolute expiry despite immutable CID-pinned blobs.
Upstream observations retained, not re-verified by Drydock tests: `trustPublisher#github` has no `environment` field and exchange does not check GitHub `environment`; `POST /-/stage/package/:package` returns `restrictedToPackage` rejection as HTTP `200` error body while equivalent checks return `403`.
