# Public reports

Completed reviews become unlisted capability links, signed report snapshots, or explicitly listed threat disclosures. **Authority:** anonymous. **Owner:** `server/routes/public-reports.ts`.

## At a glance

| Thing | Owner file | Who may call / trigger | Pinned by (test) |
| --- | --- | --- | --- |
| Share, revoke, list | `server/routes/scans/sharing.ts` | Organization owner/admin | `test/workers/public-reports.test.ts` |
| Disclosure gate | `server/db/scan-query.ts` | Every anonymous review read | `test/workers/threat-feed-badge.test.ts` |
| Public UI | `src/pages/PublicReport/index.tsx` | Live-token holder | `test/e2e/local-registry.spec.ts` |
| Signed snapshot | `server/lib/attestation.ts` | Live-token holder | `test/workers/public-reports.test.ts` |
| Feed | `server/lib/public-feed.ts` | Anonymous pollers | `test/workers/threat-feed-badge.test.ts` |
| Package badge | [public-badge.md](./public-badge.md) | Anonymous consumers | `test/workers/badge-post-release.test.ts` |

Anonymous-route inventory belongs to [security-model.md](./security-model.md); authenticated control evidence belongs to [release-receipts.md](./release-receipts.md).

## Contract

### Endpoints

| Method | Path | Auth / role | Request → response |
| --- | --- | --- | --- |
| POST | `/api/v1/scans/:id/share` | Session, verified email, org owner/admin | Empty object → create/return share for active completed scan |
| POST | `/api/v1/scans/:id/share` | Same | `{"threatFeed":true}` → share/list; `false` → withdraw existing listing only |
| DELETE | `/api/v1/scans/:id/share` | Session, org owner/admin | Revoke → `{"revoked":true}`; already unshared → `false` |
| GET | `/public/reports/:token` | Anonymous capability | Canonical report JSON; `no-store` |
| GET | `/public/reports/:token/file?path=` | Capability with file consent | `{"file":...}` redacted staged sample; `no-store` |
| GET | `/public/reports/:token/attestation` | Anonymous capability | DSSE envelope; `no-store` |
| GET | `/public/attestation-key` | Anonymous | Ed25519 public JWK, `keyId`, `algorithm`; `public, max-age=3600` |
| GET | `/public/threat-feed.json[?after=&limit=]` | Anonymous | Schema, generation time, entries, `nextCursor` |

Authenticated endpoints are owned by `server/routes/scans/sharing.ts`; anonymous endpoints by `server/routes/public-reports.ts`, mounted at `/public` ahead of Better Auth. The share token is the capability.

### Share flow

| Condition / action | Result |
| --- | --- |
| Create share | 256-bit random base64url capability (`generatePublicShareToken`, `server/db/scan-share.ts`); samples enabled |
| Re-share, including concurrent enables | Token unchanged (`enablePublicShare`, `server/db/scan-share.ts`) |
| `public_share_includes_files = false` | Evidence-only until explicit re-share upgrades disclosure without rotating token |
| Revoke | Null token and timestamp together; clear file consent, listing, and package index key |
| Re-share after revoke | New capability starts unlisted |
| Re-share without `threatFeed` boolean | Listing unchanged |
| `threatFeed:false`, no active share | `409`; never mints capability; UI clears stale share state |
| Restage same registry package/version | Superseded scan cannot be re-shared; old report returns `404` immediately; derived feed/badge withdraw within TTL |
| Share/revoke audit | `scan.share_enabled`, `scan.share_revoked` |
| List/unlist audit | `scan.feed_listed`, `scan.feed_unlisted` |

State transitions and events are owned by `server/db/scan-share.ts`; route responses by `server/routes/scans/sharing.ts`.

### Disclosure

`publicDisclosureAllowedCondition` in `server/db/scan-query.ts` applies this table to report, file, attestation, feed, and listed-badge reads. It **fails closed** for unknown status or unclassified source except the explicit listed-rejection row.

| Review / condition | Anonymous disclosure allowed |
| --- | --- |
| Any source: `no_publish`, active share token, feed-listed | Immediately: deliberate threat disclosure, even before publication |
| npm staged (`manual`, `auto_discovery`) | npm `published`, or `deleted` after publication; recorded published/deleted release-outcome failure codes also count |
| npm staged: `staged`, `validating`, `blocked`, unknown/no answer | No |
| Published-pair (`published`) | Yes: bytes came from a public registry |
| PyPI / VS Code workflow gate | Gate approved protected publish job; no private stage or later observable publication |
| npm / unknown-ecosystem workflow gate | Gate approved **and** same-org evidence proves this review's bytes shipped |
| npm gate evidence: staged review | Non-superseded stage names this gate scan, `matched` continuity, npm `published`/`deleted` |
| npm gate evidence: publication monitor | Same package/version observation is `approved_match` and names this scan; another approval is insufficient |
| Unclassified source without listed rejection | No |

| Publication / UI case | Behavior |
| --- | --- |
| Completed review awaiting publication | Link can be prepared for release notes; anonymous routes return unknown-token `404` |
| Approved npm gate running `npm stage publish` | Private stage still needs npm approval/evidence; see [npm-staged-publishing.md](./npm-staged-publishing.md) |
| npm gate publishing directly | Publication monitor needs package watch to establish shipped bytes |
| Publication observed | Next 15-minute sweep (`triggers.crons`, `wrangler.jsonc`) or **Check npm** activates link without re-sharing |
| Review older than 30 days | After first lookup, automatic rechecks stop (`MAX_RELEASE_AGE_MS`, `server/lib/ecosystems/npm/release-outcome.ts`); re-review late-shipped release |
| Authenticated waiting state | Share response `awaitingPublication`; scan detail `publicShareAwaitingPublication`; dialog explains pending link/listing |
| Listed rejection unlisted or approved later | Ordinary publication rule reapplies on next request; unreleased report goes dark |
| Listed embargoed rejection | Share plus listing discloses rejected bytes; dialog explains immediate disclosure |
| New Share button | Appears after `publish`; existing-link button remains after decision changes so revoke stays reachable |
| API sharing eligibility | Any active completed scan; UI decision default is not a security boundary |

### Report and file payloads

| Surface | Contract / exclusion |
| --- | --- |
| Canonical report | `REPORT_EXPORT_SCHEMA` (`drydock.report.v2`, `server/lib/scan/report-export.ts`); same bytes as authenticated `/api/v1/scans/:id/report.json` for same state |
| Report diff | Paths, statuses, sizes, hashes; no bodies, scan events, org/user identifiers |
| `gateContinuity` | `status`, `reason`, `algorithm`, `stagedDigest`, `gateDigest`; gate repository, environment, run, decision, internal IDs stay in authenticated receipt |
| `releaseConsistency` | Drops `priorScanId` and `decidedAt`: unshared prior-scan identity and internal decision time stay private |
| Consent header | `x-drydock-share-includes-files: 1\|0`; never alters canonical attested bytes |
| Artifact reads | Report and authenticated export use `getScan(..., {files:"omit"})`; read report/diff, skip file-samples artifact |
| Sample | Same `getScanFile` and persisted files artifact as authenticated `/api/v1/scans/:id/file`; redaction/retention caps applied at persistence |
| Sample scope | Staged side only; public route never holds npm credentials to fetch baseline; removed files have no staged body |
| Evidence-only share | Quoted redacted finding evidence remains; sample flag defaults false so deployment cannot widen issued capability |
| Sample consent UI | Share dialog states widened sample disclosure before create/upgrade (`src/pages/Dashboard/ScanDetail/ShareDialog.tsx`) |
| Diff UI | `/reports/:token` shows release tree, findings pinned to lines; `?path=`, `?file=`, `?changedOnly=` select view |
| Single-sided UI | Modified files show staged side; `staged side only` labels whole panel once |
| Tokenless `/reports` | Skips lookup; explains unlisted reports, links `/diff` and docs; explainer renders after mount since prerendered shell serves token routes too |
| Rejected-token UI | Explains invalid, revoked, or awaiting publication without distinguishing them |

Serialization is owned by `server/lib/scan/report-export.ts`, reads by `server/routes/public-reports.ts`, and UI by `src/pages/PublicReport/index.tsx`.

### Attestations

| Field / property | Value / meaning |
| --- | --- |
| Envelope | DSSE `payloadType: application/vnd.in-toto+json` (`ATTESTATION_PAYLOAD_TYPE`, `server/lib/attestation.ts`); standard base64 `payload`/`sig` |
| Signature | Ed25519 over DSSE pre-authentication encoding, including payload type and byte lengths |
| Statement `_type` | `https://in-toto.io/Statement/v1` (`buildAttestationStatement`, `server/lib/attestation.ts`) |
| `subject[0].name` | `package@version`, otherwise scan ID |
| `subject[0].digest.sha256` | SHA-256 of exact canonical report response bytes |
| `predicateType` | `https://drydock.org/attestation/scan-report/v1` (`ATTESTATION_PREDICATE_TYPE`, `server/lib/attestation.ts`) |
| Predicate identity | `scanId`, `packageName`, `stagedVersion`, `previousVersion` |
| Predicate evidence | `risk`, `decision`, `findingCount`, `reportSchema`, `reportDigest`, `completedAt` |
| `predicate.findingCount` | Attested document `findings.length` (deterministic only) |
| `predicate.issuedAt` | Signed issuance time orders snapshots whose mutable decisions/evidence disagree |
| Key secret | `ATTESTATION_SIGNING_KEY_JWK`: private Ed25519 JWK, `kty: OKP`; `alg` labels `EdDSA` and `Ed25519` both load |
| Public key identity | RFC 7638 thumbprint `keyId`; match envelope signature `keyid` |
| Rotation | Published `keyId` changes; old envelopes need their old key to verify |

`AttestationPredicate`, key loading, and signing live in `server/lib/attestation.ts`; statement input comes from `server/routes/public-reports.ts`.

Generate the private JWK for the secret:

```sh
node -e "crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']).then(async k=>console.log(JSON.stringify(await crypto.subtle.exportKey('jwk',k.privateKey))))"
```

1. Fetch report bytes and attestation; hash report bytes with SHA-256.
2. Compare statement subject digest; verify DSSE signature against key matching `keyid` from `/public/attestation-key`.
3. Re-fetch on mismatch: independent reads of mutable state can race a decision, risk-summary, or finding change; mismatch alone is not forgery evidence.
4. Archive a matching report/envelope pair and key; captured-together snapshots verify even when later decisions differ.

### Threat feed

| Property | Contract |
| --- | --- |
| Schema | `THREAT_FEED_SCHEMA`: `drydock.threat-feed.v1` (`server/lib/public-feed.ts`) |
| Entry coordinates | `package`, `version`, `previousVersion`, `ecosystem`, `tag`, `packageIdentity` |
| Entry evidence | `releaseRisk`, `artifactRisk`, `decision`, `totalFindingCount`, `completedAt`, `listedAt`, `reportUrl` |
| Finding count | Deterministic plus advisory AI; export `findings[]` is deterministic-only; AI lives in `aiReview.findings` |
| Page size | `THREAT_FEED_MAX_ENTRIES` = 100 (`server/db/scan-share.ts`); finite `limit` floors/clamps to 1–100; non-finite uses default |
| Pagination | Newest listings first, `(listedAt, scanId)` total order; pass `nextCursor` as `?after=` |
| Invalid cursor | Ignored, not an error (`parseThreatFeedCursor`, `server/db/scan-share.ts`) |
| Polling | Continue until previously seen listing; listing batches have no separate listing-rate limit and can displace older entries off page one |
| Consent | Listing is second owner/admin opt-in; possession of capability never implies index publication |
| Delayed listing | Accepted before publication; activates under disclosure table, including immediate listed-rejection exception |
| `tag:null` | No staged tag recorded; never interpret as `latest` |

Feed routes live in `server/routes/public-reports.ts`; ordering in `server/db/scan-share.ts`; entries in `buildThreatFeedEntry`, `server/lib/public-feed.ts`.

| `packageIdentity` | What it establishes |
| --- | --- |
| `registry-verified` | `manual`/`auto_discovery`, public npm stage, manifest exactly agrees with npm name; org token could read that stage |
| Credential boundary | Stage visibility, **not** publishing permission: read-only token qualifies |
| `manifest-claimed` | Workflow gate, or stage with mismatching/missing npm name or non-public registry; manifest is evidence, not verified identity |
| `public-review` | Published-pair or unclassified source; registry bytes establish no relationship to reviewing organization |
| Listability | All three identities remain shareable/listable; badge admission is separate in [public-badge.md](./public-badge.md) |

| Ecosystem / identity edge | Contract |
| --- | --- |
| New source | `scanPackageIdentity` allowlists credential-backed sources, defaults `public-review`; `SCAN_SOURCES` parity tested in `test/workers/threat-feed-badge.test.ts` |
| Gate missing provenance | `ecosystem:null`, including missing snapshot/failed redaction; listable but no ecosystem badge |
| Published ecosystem outside npm/PyPI/VS Code | `ecosystem:null`; never guessed as npm |
| Staged source without provenance | Falls back to npm, sole staged ecosystem |
| Monitor byte match | Does not upgrade public identity or prove reviewing organization owns package; see [publication-monitor.md](./publication-monitor.md) |
| Guarded post-release badge decision | Feed retains `public-review`; badge guard supplies relationship to name |

## Invariants

1. Sharing is per-scan, explicit owner/admin consent; no organization share-all switch (`server/routes/scans/sharing.ts`).
2. Disclosure **fails closed** except deliberately shared, feed-listed rejection (`server/db/scan-query.ts`).
3. Malformed, unknown, revoked, superseded, incomplete, unreleased capabilities and absent/disallowed sample paths return uniform `404 {"error":"not found"}` (`test/workers/public-reports.test.ts`).
4. Redaction comes from canonical export, not separate public serialization (`server/lib/scan/report-export.ts`).
5. Public routes use locked-down API CSP and CORS `*`, including `404`, `503`, `429`; expose `content-disposition`, `retry-after`, file-consent header (`server/routes/public-reports.ts`, `test/workers/public-reports.test.ts`).
6. Report/file/attestation reads share `PUBLIC_READ_RATE` per-IP `public-report` bucket: 120 per 60 seconds; badges have separate bucket (`server/routes/public-reports.ts`).
7. Derived caches never make revoked capability resolve: report and attestation successes use `no-store` plus D1 lookup every request (`server/routes/public-reports.ts`).

## Failure modes

| Symptom / condition | Cause | What happens | Fix |
| --- | --- | --- | --- |
| Sharing fails | Missing scan/org ownership; inactive review | `404` missing, `409` inactive/incomplete | Complete current scan; correct org |
| Withdrawal races revoke | Share gone | `409`, no new token; dialog resets | Refresh; create link explicitly if intended |
| File absent | No consent/retained staged sample | Uniform `404` | Explicit re-share for consent; inspect retained evidence |
| Attestation unavailable | Missing/malformed secret | `503`; sharing still works | Configure valid signing JWK |
| Signing fails | Crypto operation error | `500`; `public_report.attestation_failed` | Inspect redacted event/key config |
| Digest mismatch | Reads raced mutable state | Verification fails | Re-fetch matching pair |
| Reader throttled | Per-IP budget exhausted | `429`, CORS, `retry-after` | Back off |
| Withdrawn feed entry cached | Colo-local purge | Remote colos retain up to TTL | Follow report URL; allow TTL |

| Feed caching case | Behavior |
| --- | --- |
| Bare first page, canonical origin configured | Per-colo `caches.default`; `public, max-age=300`; canonical-origin/path key (`publicFeedCacheKey`, `server/lib/public-feed.ts`) |
| Any query (`after`, `limit`, others) | Bypasses Worker cache; successful response still declares `max-age=300` (`server/routes/public-reports.ts`) |
| Missing `BETTER_AUTH_URL` | Worker feed cache bypassed; avoids caching unpinned-origin report URLs |
| Unlist/revoke/listed-scan decision | Purges feed and scan's own badge tag (default only when untagged); best effort, request colo only |

## Change checklist

| If you change… | Also update… | Run… |
| --- | --- | --- |
| Sharing/disclosure/samples/signing | [security-model.md](./security-model.md), [public-badge.md](./public-badge.md) | `pnpm exec vitest run --project workers test/workers/public-reports.test.ts test/workers/threat-feed-badge.test.ts` |
| Export bytes / receipt relationship | [release-receipts.md](./release-receipts.md), digest expectations | `pnpm exec vitest run --project workers test/workers/public-reports.test.ts` |
| Public UI | [design.md](./design.md), [e2e-test-environment.md](./e2e-test-environment.md) | `pnpm run e2e:dev:seed`; share approved review, observe pre-publication `404`, **Check npm**, open printed report URL |

Seed harness routes `/public/*` to Worker with throwaway signing key; `test/e2e/local-registry.spec.ts` covers the anonymous path.
