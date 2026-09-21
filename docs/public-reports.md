# Public report sharing, attestations, badges, and the threat feed

Completed scans can be shared outside the organization as a read-only public
report, with an optional signed attestation that lets anyone verify the report
bytes came from Drydock. Shared reports also power two discoverable surfaces:
a shields.io badge per package and an opt-in public threat feed.

## Share flow

- `POST /api/v1/scans/:id/share` (owner/admin only) creates — or returns the
  existing — public share link for a completed scan. Sharing is idempotent so a
  link that is already distributed never rotates silently. New links include
  the redacted staged file samples used by the diff. Links created before that
  disclosure was introduced remain evidence-only until an owner/admin
  deliberately re-shares them from the dialog; the token stays unchanged.
- `DELETE /api/v1/scans/:id/share` revokes the link immediately — report and
  attestation responses are served `no-store` so no shared cache can outlive a
  revoke.
- Both actions are recorded as scan events (`scan.share_enabled`,
  `scan.share_revoked`) and surface in the organization audit log.
- The UI entry point is the **Share** button on the scan detail header; the
  public page renders at `/reports/:token`. It leads with the same release tree
  and file diff the authenticated workbench does — findings pinned to their
  lines — and its `?path=`, `?file=`, and `?changedOnly=` parameters make a
  share link openable on one specific file.
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
  `/api/v1/scans/:id/report.json`). Carries the file **diff** (paths, statuses,
  sizes, hashes) but no file _bodies_, no scan events, and no
  organization/user identifiers.
  `x-drydock-share-includes-files: 1|0` says whether this share opted into file
  samples without changing the canonical, attested report bytes.
- `GET /public/reports/:token/file?path=` — one redacted staged file sample, so
  the public page can render the diff rather than a list of file names. See
  "Shared file samples" below.
- `GET /public/reports/:token/attestation` — DSSE envelope over an in-toto v1
  Statement about the report (see below).
- `GET /public/attestation-key` — the Ed25519 public key (JWK) and its RFC 7638
  thumbprint key id.

## Shared file samples

A report that lists which files changed but cannot show what changed in them is
not a review anyone can check. For shares created or deliberately re-shared
after file diffs became available, `GET /public/reports/:token/file?path=`
serves the same redacted sample the authenticated
`GET /api/v1/scans/:id/file` serves, read from the same persisted `files.json`
artifact — redaction and the sandbox's retention caps both happen at persist
time, so the two routes cannot diverge in what they disclose. Older shares have
`public_share_includes_files = false`, get the same uniform `404` from the file
route, and keep the earlier findings-plus-file-list page until an owner/admin
re-shares them.

- **Staged side only.** There is no baseline: reaching a published previous
  version means fetching a tarball with the organization's npm credentials, and
  a public route never holds one. A `modified` file therefore renders
  single-sided on the public page — the File diff label says `staged side only`
  once for the whole panel — with findings still pinned to their staged lines. A `removed` file has no staged body at all.
- **Uniform 404.** An unknown token, a revoked token, a superseded scan, and a
  path the shared review does not contain are one indistinguishable
  `{"error":"not found"}`. Anything else would make the route an oracle for
  either the token space or a package's file list.
- **No caching.** `no-store`, like the report itself, so a revoke takes effect
  on the next request rather than after a TTL.
- Reads charge the same per-IP `public-report` bucket as the report route: a
  reader paging through a large release spends the same budget an automated
  scraper would.
- Sharing a report has always disclosed the redacted evidence a finding quotes;
  new or deliberately re-shared links widen that to the reviewed sample of any
  file in the release. The database flag defaults false so deploying the route
  cannot widen an already-issued capability. The share dialog states the
  disclosure before creation or upgrade, and revoke is immediate.

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
`vscode`; npm names may contain `@scope/` slashes) returns a
[shields.io endpoint-badge](https://shields.io/badges/endpoint-badge) payload
for the most recent review of that package's release line that the badge may
answer with. Two routes qualify a review: an **approved, published release of a
provably public npm package**, which needs no opt-in (see "Default-on" below),
or any review an organization **deliberately feed-listed**. Candidates from
both are ordered by _release_ — `compareBadgeCandidates`, semver over the
registry's version — never by which scan finished last.

- Nothing qualifying → `not reviewed` (lightgrey). Always `200` so badge
  proxies never render an error, and byte-identical whether the package was
  never scanned or its reviews simply do not qualify.
- Approved (`publish`) → `<version> approved` (green when registry-verified).
  The decision supersedes the pre-decision risk grade in the message: a
  maintainer read the evidence and signed off, and an approved release wearing
  "medium risk" would read as a warning about a release the review process
  cleared. The grade and findings stay in the report behind the badge.
- Listed and undecided → `<version> reviewed · <release risk> risk`, colored
  green / yellow / red by risk. Only via the listing route; a default-on badge
  never speaks for a review nobody acted on.
- Listed and rejected (`no_publish`) → `<version> blocked` (red). Listing route
  only, for the same reason.

The version rendered is npm's own `registry_version` wherever there is one, and
falls back to the manifest's only for a review the registry never answered
about — a gate review, which already renders `unverified`.

**An OSS package needs no opt-in.** A badge lives in a README and answers for
whatever a consumer would install, so for a package that is provably public it
answers from the organization's approvals directly — nothing to share, nothing
to list. `isDefaultBadgePublic` decides that at write time, and every part of
it fails closed (see "Default-on" below).

Everything else keeps the second opt-in the threat feed takes: a report shared
privately by link never becomes queryable by package name. **Published-pair
reviews never answer the badge at all** — see package identity below.

### Default-on (`badge_public`)

Requiring an opt-in per release is how a badge ends up quoting a version from
last month: listing is per scan, a release line is forever, and the two only
stay in step if someone remembers. For an OSS package there is nothing to
protect that the registry has not already published, so the badge answers on
its own.

`scans.badge_public` records that decision when the scan is persisted, and it
is false unless all three of these are provable:

- **A registry-verified source.** npm accepted the organization's own token for
  that exact name, so the review is the maintainer's own. A `workflow_gate`
  review only _claims_ the name in a tarball manifest — anyone can build one —
  so without this, approving a review of a tarball calling itself `react` would
  mint an authoritative-looking approval for a package the reviewer has no
  claim on. Manifest-claimed reviews keep the explicit opt-in.
- **The public npm registry.** A mirror, proxy, or enterprise registry proves
  nothing about whether the package is public.
- **An unscoped name.** npm only allows a private package under a scope, so an
  unscoped name on the public registry is public by construction. A scoped
  package may well be private, and keeps the opt-in.

It is a stored column rather than a predicate readers re-derive, because
`registry_url` is null on rows that predate it — the registry cannot be
recovered later, and a disclosure gate should not be an inference three columns
deep. Reviews predating the column are backfilled by
`pnpm run db:backfill:badge-package-key:remote`, whose header states the one
assertion that backfill makes.

Two further conditions apply to the _release_ rather than the package, and
`listDefaultBadgeCandidateScans` enforces both:

- **Approved only.** With no deliberate listing there is no consent to publish
  a verdict the organization did not act on, so an undecided review and a
  rejection are both simply absent — indistinguishable from a package nobody
  scanned. This is the one place the badge is deliberately quieter than the
  truth, and the remedy is in the maintainer's hands: listing a review
  publishes it with the full vocabulary, `blocked` included.
- **Published by the registry.** A staged version is not public until npm
  publishes it, so the badge keys on npm's own version status. Without it, an
  approved release would appear on the badge before it shipped, leaking both
  the version number and the timing.

Four limits are known and deliberate:

- **The sweep that creates a badge does not purge its cache.** A default-on
  badge appears when the registry-status sweep flips a version to `published`,
  and that sweep runs in cron with no request colo to purge — so a new badge,
  or an older one going grey, lags by up to the 300s TTL. Every _user_ action
  that changes a badge (decision, share, list, unlist, revoke) does purge. The
  old design had a user action behind every badge change; default-on removed
  that, and nothing replaced it.
- **A default-on badge is not organization-scoped.** Two organizations can both
  prove npm accepts their token for the same name, and both answer; the higher
  release wins. That is the right outcome for co-maintainers and an invisible
  handover for anyone else, with no dashboard signal that a badge changed
  hands.
- **`isDefaultBadgePublic` cites an advisory check.** "npm accepted the
  organization's token for this name" rests on `checkStagedPublishAccess`,
  which fails _open_ on a network error or any non-401/403/404 response. The
  authorization that actually holds is the later credentialed tarball fetch.
  Tightening that check is worth doing before this surface grows.
- **Version comparison degrades on non-semver versions.** `compareSemver` falls
  back to `localeCompare` when either side fails to parse, so a review whose
  only version is an unparseable manifest string can order arbitrarily against
  a real release. Reachable only for a gate review a maintainer listed
  themselves, which already renders `unverified`.

The two routes union in the badge handler: a review can satisfy both, so they
are deduplicated by scan id and ordered over the union, because `pickBadgeScan`
reads position to break ties. Nothing about the _report_ changes — a default-on
badge carries no link, no findings, and no feed entry. It is a verdict, not
evidence.

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
  untagged — ecosystems without dist-tags (all PyPI and VS Code reviews, all
  gate scans) and staged scans predating tag capture — and all of them describe
  the release a consumer installs by default. Admitting them into a `?tag=beta`
  request would answer a question about the beta line with a review of
  something else, so on PyPI and VS Code every non-default tag is
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
PyPI and VS Code review is a workflow gate and is _always_ manifest-claimed —
there is never a registry-verified row to prefer. A manifest-claimed pick
therefore renders as `drydock (unverified)` and never takes the clean green
low-risk color, because anyone can build an artifact whose manifest claims any
name, and a badge is read by people who will not open the report behind it.

**A tiebreak is not enough for a published-pair review, so it is not a badge
candidate at all.** Ranking a `public-review` row last would still let it
answer for a package nobody else has reviewed, and starting one needs no
credential and no relationship to the package — any account can review any
public release. That is a forged approval for a name the reviewer has no claim
on. Two locks enforce it: `badgeLookupKey` gives such a scan no
`public_package_key` on listing, so it never enters the badge index, and
`listBadgeCandidateScans` excludes the source in SQL so a row that acquired a
key some other way still never reaches `pickBadgeScan`.

### Releasing again (`badge_package_key`)

A badge lives in a README forever and is keyed on a package name, while
listing is per scan. Nothing tied the two together, so a package that released
again kept a green `3.0.0 approved` badge next to an install command that
fetches `3.0.1` — the badge vouching for bytes nobody installs. Two mechanisms
close that, one on each side.

**The badge stops vouching.** When the organization behind the pick has a newer
release on the same line with no listed review, the badge answers about _that_
version instead: `<newer version> not reviewed`, lightgrey, with no identity
qualifier — the pick is no longer what the badge reports. "Not reviewed" is the
same claim the badge already makes for a package with nothing listed: nothing
is public, not that nobody looked. This also closes the obvious way to game the
badge, which is to list the releases that reviewed well and quietly skip the
rest.

`findNewerPublishedRelease` bounds that check three ways, because the badge is
an anonymous surface:

- **The pick's own organization.** Another organization's review of the same
  package says nothing about this maintainer's release line, and letting one
  count would hand any account a lever on someone else's README. The cost is
  that a maintainer who stops scanning a package keeps their last badge.
- **Only versions the registry itself published.** Both the gate
  (`registry_version_status`) and the string the badge renders come from npm's
  answer about `registry_version` — never from `staged_version`, which the scan
  replaces with the _inspected tarball's_ manifest and which is therefore
  reviewed package bytes. That keeps two things out of a third party's README:
  a version npm has not announced (a staged release is not public yet, so
  naming one would leak the release and its timing), and an attacker-authored
  string. Only npm reports version status, so no PyPI or VS Code review is
  stale-detected today.
- **Only unlisted releases.** A newer _listed_ review is either the badge's own
  pick or a deliberate preference (registry-verified outranks manifest-claimed);
  neither is staleness.

Recency is **version order, not scan time**: re-reviewing the quoted release,
or an older one, completes later than the pick without being a newer release,
and must not take the badge off a valid review. Scan time only bounds the page
the comparison runs over.

The newer release's decision is never consulted and never disclosed — an
automatic red badge for a release the organization chose not to ship would
publish an internal verdict about software that was never released.

The probe runs on a badge cache miss against `scans.badge_package_key`, which
is the canonical identity written for **every** badge-eligible scan, shared or
not. It is not an authorization signal and never admits a row to the badge
index: `public_package_key` plus `public_feed_listed_at` remain the only two
locks on that. Reviews that predate the column need
`pnpm run db:backfill:badge-package-key:remote` (see `docs/tooling.md`).

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
latest published pair on load), while PyPI and VS Code — which have no
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

Each feed entry carries `packageIdentity`, which says what the scan's source
proves about the reviewer's relationship to the package name — never about the
quality of the review:

- `registry-verified` — staged-publish reviews (`manual`, `auto_discovery`).
  The artifact was fetched from the registry with the org's npm token, and the
  registry accepted that token for that exact name, so it proved the org can
  publish under it. This is the only identity backed by a credential, and the
  only one the badge treats as authoritative.
- `manifest-claimed` — workflow-gate reviews. The reviewed artifact is
  repo-built and its manifest claims the name; nothing verifies ownership yet.
  Consumers should weigh these accordingly. The authenticated
  [publication monitor](./publication-monitor.md) can compare an enrolled npm
  package's published bytes with prior gate approvals. Those observations do
  not upgrade public identity claims or prove the reviewing organization owns
  the package.
- `public-review` — published-pair reviews, and the fail-closed default for any
  source not classified above. The bytes really are the registry's, but nothing
  connects the reviewing organization to the package: the scan needs no
  credential and any account can run one against any public release. Such a
  review is shareable and feed-listable — publishing a review of a compromised
  public release is exactly what the feed is for — but it is never
  badge-discoverable, so it cannot render or displace an approval badge under
  someone else's name.

`scanPackageIdentity` allowlists the credential-backed sources rather than
excluding the untrusted ones, so a scan source added later inherits
`public-review` until it is classified deliberately. `SCAN_SOURCES` is asserted
against that classifier in `test/workers/threat-feed-badge.test.ts`.

`ecosystem` is `null` when nothing established one — a gate scan whose
provenance snapshot is missing (a legacy pre-provenance record, or a redaction
that failed), or a published-pair review of an ecosystem outside `npm`, `pypi`,
and `vscode`. Only the staged sources fall back to npm, because npm is the sole
staged ecosystem and pre-provenance staged rows carry no other clue; a
published-pair review names its own ecosystem in its summary and is never
guessed. Defaulting an unknown to npm would let a PyPI or VS Code release take
the npm badge for its own name, in the one ecosystem where a registry-verified
review exists to be displaced. Such a scan can still be feed-listed, but it is
not badge-discoverable under any ecosystem. Partners should treat a null
`ecosystem` as unknown rather than assuming npm.

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
packages and must not share a badge — while PyPI (PEP 503) and VS Code fold, as
`publicPackageLookupKey` documents. Two consequences: `/badge/npm/React` is its
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

The JWK's `alg` label may read either `EdDSA` (RFC 8037) or `Ed25519` (what
Node's WebCrypto exports, and what the snippet above emits); both name this
curve and both load. When the secret is absent or malformed the attestation
endpoints return `503`; report sharing itself keeps working. Rotating the key changes the published
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
  File samples stay out of that document and are served one path at a time by
  the `file` route above, which reads through the same `getScanFile` the
  authenticated workbench uses.
- Tests: `test/workers/public-reports.test.ts` (routes, roles, revocation,
  redaction, rate limit, CORS on failures, concurrent enables, signature
  verification, degraded/malformed key handling).

## Verifying a share link locally

`pnpm run e2e:dev:seed` scans a fixture release, shares it, and prints the
`/reports/:token` URL. The local harness routes `/public/*` to the Worker and
configures a throwaway signing key, so the report, its file samples, and its
attestation are the real responses rather than the SPA shell — see
[`e2e-test-environment.md`](./e2e-test-environment.md). The anonymous read path
is covered end to end by `test/e2e/local-registry.spec.ts`.
