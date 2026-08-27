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
- `/reports` with no token is not an error state: there is no public index to
  land on, so the page skips the lookup entirely and explains what a public
  report is, why reports are unlisted, and points at `/diff` and the docs. Only
  a token that is present and rejected gets the "invalid or revoked" message.
  The explainer renders after mount, because the prerendered `/reports`
  document is also the shell served for every `/reports/:token` request.
- Restaging the same registry package/version retires the older stage identity
  and its public share capability. The obsolete review also leaves the badge
  and threat feed; already-cached derived responses may remain visible for the
  documented 300-second cache window, but their report link returns `404`
  immediately and the superseded scan cannot be shared again.
- That button only appears once the release is decided `publish` — a public
  report is the organization vouching for a release, and an undecided or blocked
  one has nothing to vouch for yet. A release that already has a link keeps the
  button whatever it is decided afterwards, so flipping approved → blocked never
  strands a live link out of reach of revoke. The API itself is unchanged and
  still accepts any completed scan; the rule is a product default, not a
  security boundary.

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

`GET /public/badge/:ecosystem/:package[?tag=]` (ecosystems: `npm`, `pypi`,
`vscode`, `browser`; npm names may contain `@scope/` slashes) returns a
[shields.io endpoint-badge](https://shields.io/badges/endpoint-badge) payload
for the most recent **feed-listed** review of that package's release line:

- Not listed / unknown → `not reviewed` (lightgrey). Always `200` so badge
  proxies never render an error.
- Listed, undecided → `<version> reviewed · <release risk> risk`, colored
  green / yellow / red by risk.
- Listed, approved (`publish`) → `<version> approved` (green when
  registry-verified). The decision supersedes the pre-decision risk grade in
  the message: a maintainer read the evidence and signed off, and an approved
  release wearing "medium risk" would read as a warning about a release the
  review process cleared. The grade and findings stay in the report behind the
  badge.
- Listed, rejected (`no_publish`) → `<version> blocked` (red).

When baseline comparison was skipped because the published artifact was unavailable or exceeded the download budget, new reports persist artifact risk as the conservative release-risk lower bound instead of presenting an unsupported low delta score. Public feed readers retain the same fallback for older reports written before that scoring rule shipped.

The badge is a name-discoverable index, so it takes the same second opt-in as
the threat feed — a report shared privately by link never becomes queryable by
package name.

Browser-extension badges require a stable ID from
`browser_specific_settings.gecko.id` (or, for Manifest V2 only, legacy
`applications.gecko.id`) in Firefox's email-style or GUID format. Chrome
archives that only declare a display name can still be shared and feed-listed,
but return `not reviewed` from name lookup because localized or reused names do
not establish a global package identity.

### Release lines (`?tag=`)

A badge sits next to an install command, so it answers for the release that
command produces: **`?tag=` defaults to `latest`**. Without that, listing a
prerelease review silently repoints every embedded badge — including the one
beside `npm i <pkg>` — at a version nobody installs by default, and a package
cannot carry a stable badge and a prerelease badge at once.

The tag is the dist-tag the release was staged under
(`summaryJson.stagedPublish.tag`), filtered in SQL for the same reason the
ecosystem is: an active prerelease line publishes far more often than the stable
one, so an unfiltered bounded page would be all `rc` rows while a listed stable
review sat just past the limit.

- `?tag=beta` → only reviews staged under `beta`. The label becomes
  `drydock (beta)`, so a README carrying several rows can be read apart;
  `drydock (rc, unverified)` when the pick is also manifest-claimed.
- A review with **no** tag answers only the default badge. Two populations are
  untagged — ecosystems without dist-tags (all PyPI, VS Code, and browser-extension reviews, all
  gate scans) and staged scans predating tag capture — and all of them describe
  the release a consumer installs by default. Admitting them into a `?tag=beta`
  request would answer a question about the beta line with a review of
  something else, so on PyPI, VS Code, and browser extensions every non-default tag is
  `not reviewed`.
- A malformed tag (empty, longer than 64 characters, or containing characters
  outside npm's URI-safe dist-tag alphabet) is a `400`, not a silent fall back
  to `latest` — the fallback would answer a typo'd parameter with a badge about
  a different release line and the embedder would never find out. Valid npm
  punctuation such as the `~` in `beta~edge` is preserved.
- Tags are matched exactly, not case-folded, on the same reasoning as npm
  package names.

Feed entries carry the same `tag` (null when the release was never staged under
one — never read null as `latest`), so a partner walking feed → badge filters on
the value the badge itself uses.

**Verified and unverified badges are visibly different.** Among listed
candidates the newest **registry-verified** review wins (see package identity
below), so on npm a workflow-gate scan claiming someone else's name cannot
displace the real maintainer's staged review. That preference is only a
tiebreak, and it does not generalize: only npm has a staged adapter, so every
PyPI, VS Code, and browser-extension review is a workflow gate and is _always_ manifest-claimed —
there is never a registry-verified row to prefer. A manifest-claimed pick
therefore renders as `drydock (unverified)` and never takes the clean green
low-risk color, because anyone can build an artifact whose manifest claims any
name, and a badge is read by people who will not open the report behind it.

Embed via
`https://img.shields.io/endpoint?url=<origin>/public/badge/npm/<package>`
(URL-encode the badge URL), and add `%3Ftag=beta` to the encoded badge URL for a
prerelease row.

**The share dialog hands maintainers the snippet.** Once a share is feed-listed
(and the scan's ecosystem resolves — see `scanEcosystem`), the dialog shows
copy-paste README markdown built by `src/lib/badge-markdown.ts`. The snippet is
for **the release line the copied scan was staged under**: a scan tagged `rc`
yields `?tag=rc` and alt text `Drydock review (rc)`, while `latest` and untagged
scans keep the short untagged form (the endpoint already defaults to `latest`).
Without that, a maintainer who lists a prerelease review would paste a badge
that never shows it. The badge image always reflects the newest listed review
_on that line_, so the click target is chosen to not pin what the badge does
not: npm links the evergreen package-only `/diff/<name>` page (it resolves the
latest published pair on load), while PyPI, VS Code, and browser extensions — which have no
package-only diff form — link the share URL the maintainer copied, correct at
copy time but version-pinned.

## Threat feed

`GET /public/threat-feed.json` is a discoverable index (schema
`drydock.threat-feed.v1`, 100 entries per page, newest listings first) meant
for security partners — Aikido and other ecosystem-intel consumers can poll it.
Each entry carries package identity, ecosystem, dist-`tag`, release/artifact
risk, decision, `totalFindingCount`, timestamps, and a `reportUrl` to the full
public report.

`totalFindingCount` counts deterministic _and_ advisory AI findings. It is
deliberately not `report.findings.length`: the export routes AI findings
through `aiReview.findings` and keeps `findings[]` deterministic-only, so the
two numbers differ by design and the field is named for what it counts. (The
attestation's `predicate.findingCount` is the other one — it is read off the
attested document, so it always equals that document's `findings.length`.)

**Page one is not the whole feed.** The response carries `nextCursor` whenever
more listings exist behind it; pass it back as `?after=<cursor>` to continue.
`?limit=` shrinks the page (capped at 100); a malformed `after` or `limit` is
ignored rather than erroring.
`(listedAt, scanId)` is a total order over the listed set, so paging is stable
and nothing is unreachable — which matters because listings are not
rate-limited: one organization listing a batch of its own scans displaces
everything older off page one, including other organizations' `no_publish`
releases. A poller that reads only page one after such a burst silently misses
them. Read until you reach a listing you have already seen, not until the first
response ends.

Listing is a **second explicit opt-in** on top of sharing (the checkbox in the
share dialog, or `POST /api/v1/scans/:id/share { "threatFeed": true|false }`):
holding a link is capability, appearing in an index is publication, and the two
must never be conflated. Revoking the share link always unlists the report;
re-sharing later starts unlisted. Listing changes are audited
(`scan.feed_listed`, `scan.feed_unlisted`).

`{ "threatFeed": false }` is a _withdrawal_ and never creates a share link. On
a scan that is not currently shared it returns `409` (the dialog drops its
stale share state and falls back to "create link") rather than quietly minting
a fresh token and republishing the report. Revoking nulls the share token and
its timestamp together, so "revoked a moment ago" and "never shared" are the
same persisted state and the 409 does not claim to tell them apart.

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

`ecosystem` is `null` when a gate scan's provenance snapshot never established
one — a legacy pre-provenance record, or a redaction that failed. Such a scan
can still be feed-listed, but it is not badge-discoverable under any ecosystem:
defaulting an unknown to npm would let a PyPI, VS Code, or browser release take the npm
badge for its own name, in the one ecosystem where a registry-verified review
exists to be displaced. Partners should treat a null `ecosystem` as unknown
rather than assuming npm.

### Caching

Badge and feed responses read through the per-colo Workers cache
(`caches.default`) and declare `max-age=300`. The cache key is the canonical
origin plus path plus — for badges — the resolved `tag`, and badge URLs collapse
onto their package lookup key, so one package's release line has one entry per
colo however an embedder encoded the name. Every other query parameter is still
ignored, so a cache-busting `?_=` cannot force a D1 read-through; the tag
participates because it is the one parameter that changes the body. A listing
change purges the entry for the scan's own tag (the default entry when the scan
has none), not a guessed set of tags. Case is part of that key for npm — the registry treats
existing names case-sensitively, so `JSONStream` and `jsonstream` are different
packages and must not share a badge — and for browser extensions, whose Gecko IDs preserve
their declared casing. PyPI (PEP 503) and VS Code fold case, as `publicPackageLookupKey`
documents. Two consequences: `/badge/npm/React` is its
own entry and resolves to "not reviewed", and the origin must be the _canonical_
one on both the write and the purge, or a second bound hostname builds entries
the purge never visits.

Badge **misses** are deliberately not written to the colo cache. The "not
reviewed" body is identical for every package, so a per-name entry buys nothing
the downstream `max-age` doesn't already absorb, while every invented name would
add an entry to the namespace that also holds published-tarball bytes. Cursored
feed pages (`?after=`) are uncached too, since the key ignores the query.

Revoking a share, unlisting a report, or recording a release decision on a
listed scan purges both entries — a publish → no_publish flip must not leave a
green "approved" badge serving from the deciding admin's own colo for the full
TTL. **That purge is
colo-local and best effort**: `caches.default.delete()` clears the entry in the
colo that handled the revoking request and nowhere else, so other regions keep
serving the withdrawn badge until `max-age` expires — and shields.io's own cache
(a ≥300s floor it enforces regardless of what we send) sits in front of that.
Plan for a withdrawal to take effect on the derived surfaces within roughly ten
minutes, not instantly. Only the report and attestation routes are immediate,
via `no-store` plus a D1 lookup on every request; they are the authority, and
the badge links to them.

The same TTL bounds non-revocation staleness: a decision recorded after the
badge was cached can take ~5 minutes to render as `blocked`.

Badge reads use a rate-limit bucket separate from report reads, because badge
proxies multiplex unrelated packages through a handful of egress addresses. A
throttled badge returns an uncached, valid shields.io payload reading
`unavailable` — never `not reviewed`, which is an assertion _about the package_
that shields would cache for minutes, potentially over a review that says
`blocked`.

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
