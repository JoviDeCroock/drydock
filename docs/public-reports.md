# Public report sharing, attestations, badges, and the threat feed

Completed scans can be shared outside the organization as a read-only public
report, with an optional signed attestation that lets anyone verify the report
bytes came from Drydock. Shared reports also power two discoverable surfaces:
a shields.io badge per package and an opt-in public threat feed.

## Share flow

- `POST /api/v1/scans/:id/share` (owner/admin only) creates — or returns the
  existing — public share link for a completed scan. Sharing is idempotent so a
  link that is already distributed never rotates silently.
- `DELETE /api/v1/scans/:id/share` revokes the link immediately — report and
  attestation responses are served `no-store` so no shared cache can outlive a
  revoke.
- Both actions are recorded as scan events (`scan.share_enabled`,
  `scan.share_revoked`) and surface in the organization audit log.
- The UI entry point is the **Share** button on the scan detail header; the
  public page renders at `/reports/:token`.

## Public endpoints (no auth)

Mounted at `/public` ahead of the Better Auth middleware, like `/webhooks`.
The unguessable 256-bit share token is the capability; all endpoints are
rate-limited per IP and return `404` for unknown, malformed, or revoked tokens.

- `GET /public/reports/:token` — the canonical report export
  (`drydock.report.v2`, same bytes as the authenticated
  `/api/v1/scans/:id/report.json`). Never includes file samples, scan events,
  or organization/user identifiers.
- `GET /public/reports/:token/attestation` — DSSE envelope over an in-toto v1
  Statement about the report (see below).
- `GET /public/attestation-key` — the Ed25519 public key (JWK) and its RFC 7638
  thumbprint key id.

## Attestation format

The envelope is DSSE (`payloadType: application/vnd.in-toto+json`), signed with
Ed25519 over the standard DSSE pre-authentication encoding. `payload` and `sig`
use standard base64 (the alphabet sigstore/in-toto tooling emits). The payload
is an in-toto v1 Statement:

- `subject[0].name` — `package@version` (falls back to the scan id).
- `subject[0].digest.sha256` — SHA-256 of the exact bytes served by
  `GET /public/reports/:token`.
- `predicateType` — `https://drydock.org/attestation/scan-report/v1`.
- `predicate` — scan id, package identity, risk, decision, finding count,
  report schema/digest, completion timestamp, and `issuedAt` (when the envelope
  was signed).

`issuedAt` is what orders two envelopes for the same scan. Because the attested
report is a snapshot of mutable state, a consumer who archived a pair before a
maintainer recorded "block" and a consumer who archived after both hold envelopes
that verify and disagree; `issuedAt` says which is newer without an out-of-band
timestamp. It is inside the signed statement, so it cannot be restamped.

To verify: fetch the report bytes, hash them, compare with the subject digest,
then verify the envelope signature against `/public/attestation-key` (match by
`keyid`).

**Fetch both, and re-fetch on mismatch.** The report route and the attestation
route are independent reads: each serializes the report from current scan state,
so the bytes are identical for a given state but the state can change between
the two requests. A decision recorded in that window (or any later edit to a
mutable field — `decision`, `riskSummary`, findings) means the digest covers a
document the consumer never fetched, and verification fails. That is a race, not
a forgery: re-fetch the report and compare again. An archived pair captured
together always verifies, which is what matters for the archival use case.

## Badge endpoint

`GET /public/badge/:ecosystem/:package` (ecosystems: `npm`, `pypi`, `vscode`;
npm names may contain `@scope/` slashes) returns a
[shields.io endpoint-badge](https://shields.io/badges/endpoint-badge) payload
for the package's most recent **feed-listed** review:

- Not listed / unknown → `not reviewed` (lightgrey). Always `200` so badge
  proxies never render an error.
- Listed → `<version> reviewed · <release risk> risk`, colored green / yellow /
  red by risk; a `no_publish` decision renders `<version> blocked` (red).

The badge is a name-discoverable index, so it takes the same second opt-in as
the threat feed — a report shared privately by link never becomes queryable by
package name. Among listed candidates the newest **registry-verified** review
wins (see package identity below), so a workflow-gate scan claiming someone
else's npm name cannot override the real maintainer's badge.

Embed via
`https://img.shields.io/endpoint?url=<origin>/public/badge/npm/<package>`
(URL-encode the badge URL).

## Threat feed

`GET /public/threat-feed.json` is a discoverable index (schema
`drydock.threat-feed.v1`, capped at 100 entries, newest listings first) meant
for security partners — Aikido and other ecosystem-intel consumers can poll it.
Each entry carries package identity, ecosystem, release/artifact risk,
decision, finding count, timestamps, and a `reportUrl` to the full public
report.

Listing is a **second explicit opt-in** on top of sharing (the checkbox in the
share dialog, or `POST /api/v1/scans/:id/share { "threatFeed": true|false }`):
holding a link is capability, appearing in an index is publication, and the two
must never be conflated. Revoking the share link always unlists the report;
re-sharing later starts unlisted. Listing changes are audited
(`scan.feed_listed`, `scan.feed_unlisted`).

### Package identity

Each feed entry carries `packageIdentity`:

- `registry-verified` — staged-publish reviews. The artifact was fetched from
  the registry with the org's npm token, so the registry proved the org can
  publish under that name.
- `manifest-claimed` — workflow-gate reviews. The reviewed artifact is
  repo-built and its manifest claims the name; nothing verifies ownership yet.
  Consumers should weigh these accordingly. (Known limitation: post-publish
  digest verification against the registry would upgrade gate claims; not
  built yet.)

### Caching

Badge and feed responses read through the per-colo Workers cache
(`caches.default`, keyed on the path with any query string ignored) and declare
`max-age=300`, so listing or revocation changes can take up to ~5 minutes to
propagate to these two surfaces. Report and attestation responses are
deliberately uncached (`no-store`): revoking a share link takes effect
immediately. Badge cache misses use a rate-limit bucket separate from report
reads; a throttled badge still returns an uncached valid shields.io payload so
shared badge-proxy traffic cannot produce an error badge or exhaust report
access.

## Key management

The signing key is the `ATTESTATION_SIGNING_KEY_JWK` secret — a private
Ed25519 JWK (`kty: OKP`). Generate one with:

```sh
node -e "crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']).then(async k=>console.log(JSON.stringify(await crypto.subtle.exportKey('jwk',k.privateKey))))"
```

When the secret is absent or malformed the attestation endpoints return `503`;
report sharing itself keeps working. Rotating the key changes the published
`keyId`; envelopes issued under the old key stop verifying against the new
published key, so consumers should pin envelopes to the `keyid` they were
issued with.

## Trust boundaries

- Sharing is an explicit, elevated (owner/admin) opt-in per scan; there is no
  org-wide "share everything" switch.
- The public payload is the canonical export only — redaction is inherited from
  the report contract, not re-implemented on the public path.
- Public routes carry the locked-down API CSP and permissive CORS (`*`) — the
  data is public by construction once shared. CORS rides on _every_ response,
  including the 404 for a revoked link, the 503 when no signing key is
  configured, and the 429 from the rate limiter (whose `retry-after` is exposed
  via `access-control-expose-headers`). A browser verifier that cannot read a
  failure cannot tell "revoked" from "offline", and cannot back off politely.
- The export drops `releaseConsistency.priorScanId` and
  `releaseConsistency.decidedAt`. Both describe a _prior_ scan the org never
  chose to share — `decidedAt` most sharply, being a precise timestamp of an
  internal review decision on an unshared release. The remaining release-memory
  fields describe this scan's delta against that history.
- Serving a report reads the report and diff artifacts but not the file-samples
  artifact (`getScan`'s `files: "omit"` mode). The authenticated `report.json`
  export takes the same path, so the two cannot diverge: byte-identity is by
  construction rather than by both happening to succeed at the same R2 reads.
- Tests: `test/workers/public-reports.test.ts` (routes, roles, revocation,
  redaction, rate limit, CORS on failures, concurrent enables, signature
  verification, degraded/malformed key handling).
