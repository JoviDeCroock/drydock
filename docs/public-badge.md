# Public badge

A shields.io payload reports the qualifying review or publication warning for a package's release line. **Authority:** anonymous. **Owner:** `server/routes/public-reports.ts`.

## At a glance

| Thing | Owner file | Who may call / trigger | Pinned by (test) |
| --- | --- | --- | --- |
| Public response | `server/routes/public-reports.ts` | Anonymous embed/proxy | `test/workers/threat-feed-badge.test.ts` |
| Identity, labels, eligibility | `server/lib/public-feed.ts` | Persistence and badge reads | `test/badge-eligibility.test.ts`, `test/badge-payload.test.ts` |
| Listed/default candidates | `server/db/scan-share.ts` | Badge cache miss | `test/workers/threat-feed-badge.test.ts` |
| Supersession/post-release decisions | `server/db/badge-publication-evidence.ts` | Badge cache miss | `test/workers/badge-post-release.test.ts` |
| Consent switch | `server/db/package-badge.ts` | Canonical npm owner | `test/workers/threat-feed-badge.test.ts` |
| README snippet | `src/lib/badge-markdown.ts` | Share dialog / package page | `test/badge-markdown.test.ts` |

Disclosure and feed identities belong to [public-reports.md](./public-reports.md#disclosure); canonical npm ownership belongs to [package-claims.md](./package-claims.md). Release authority belongs to [workflow-gates.md](./workflow-gates.md) and [npm-staged-publishing.md](./npm-staged-publishing.md).

## Contract

### Endpoints

| Method | Path | Auth / role | Result |
| --- | --- | --- | --- |
| GET | `/public/badge/:ecosystem/:package[?tag=]` | Anonymous | Shields endpoint payload; owner `server/routes/public-reports.ts` |
| GET | `/public/badge-verdict/:ecosystem/:package` | Anonymous | Default-tag badge's answer as data for the `/diff` page the badge links to; see [Badge verdict](#badge-verdict) |
| GET | `/api/v1/packages/:name/badge[?ecosystem=]` | Session, any org member | Own badge state and eligibility; owner `server/routes/packages.ts` |
| PUT | `/api/v1/packages/:name/badge[?ecosystem=]` | Session, org owner/admin | `{"enabled":false}` disables; `true` removes own opt-out; owner `server/routes/packages.ts` |

| Request property | Contract |
| --- | --- |
| Ecosystems | `PUBLIC_ECOSYSTEMS`: npm, PyPI, VS Code (`server/lib/public-feed.ts`); npm scoped names may contain `/` |
| Name key | `publicPackageLookupKey` in `server/lib/public-feed.ts`: npm exact case; PyPI PEP 503 folding; VS Code lowercase |
| Case consequence | `JSONStream` and `jsonstream` are different npm packages/switches/cache entries; `/badge/npm/React` does not answer for `react` |
| Default tag | `DEFAULT_BADGE_TAG` = `latest` (`server/lib/public-feed.ts`) |
| Tag matching | Exact, case-sensitive; SQL filters `summaryJson.stagedPublish.tag` before bounded candidate page |
| Untagged review | Answers only default badge; includes PyPI/VS Code/gate reviews and staged rows without tag capture |
| PyPI / VS Code non-default tag | `not reviewed` |
| Tag syntax | `BADGE_TAG_RE`, `server/lib/public-feed.ts`: 1–64 URI-safe characters; punctuation such as `beta~edge` preserved |
| Invalid tag | Empty, overlength, or invalid alphabet → `400`; never silently substitutes `latest` |
| Other query parameters | Ignored in body/cache key; `?_=` cannot force D1 read-through |

### Candidate admission

| Route | Required evidence |
| --- | --- |
| Default-on | `scans.badge_public`, current `publish` decision, registry status `published`, canonical npm management |
| Listed | Active share + `public_feed_listed_at` + `public_package_key`, public disclosure allowed; npm additionally requires verified stage identity/canonical management |
| Post-release | Guarded publisher decision recorded on own publication alert as `resolution_badge = 'applied'`; current read guard still holds |
| No qualifying review / switched off | Identical `200 not reviewed`; never reveals whether private/ineligible scans exist |

`listBadgeCandidateScans` and `listDefaultBadgeCandidateScans` in `server/db/scan-share.ts` enforce listed/default admission. `listPostReleaseBadgeCandidates` in `server/db/badge-publication-evidence.ts` owns the third route.

| `isDefaultBadgePublic` at persistence | Evidence required (`server/lib/public-feed.ts`) |
| --- | --- |
| Source | Credential-backed `manual` or `auto_discovery`; `workflow_gate` does not prove a name |
| Registry/name | Public npm registry; immutable `registry_package_name` exactly equals reviewed manifest `package_name` |
| Package visibility | npm stage record says `access: public`; never infer from `publishConfig` or unscoped name shape |
| Bytes | `artifactIntegrity` verified: reviewed bytes match npm's declared stage digest |
| Failure | Every check **fails closed**; ineligible review needs explicit listing where permitted |

1. `badge_public` is immutable persistence-time evidence, not current approval/publication state; read-side SQL separately requires both (`server/db/scan-share.ts`).
2. npm stage-list name reconciles with acquisition's stage-record name; disagreement fails scan. Manifest mismatch or absent npm name gives no badge under either name (`scanPublicPackageName`, `server/lib/public-feed.ts`).
3. A custom HTTPS registry proves nothing about public npm identity; even deliberate listing cannot occupy npm badge namespace (`badgeLookupKey`, `server/lib/public-feed.ts`).
4. npm candidates require canonical claim with confirmed personal management or durable shared ownership; provisional personal claim cannot answer/control badge. Un-audited historical ownership answers `not reviewed` (`server/db/scan-share.ts`, [package-claims.md](./package-claims.md)).
5. npm workflow gates never answer the badge; PyPI/VS Code manifest-claimed gate reviews require listing and render unverified (`badgeLookupKey`, `server/lib/public-feed.ts`).
6. Published-pair review never qualifies alone: `badgeLookupKey` supplies no index key and SQL excludes its source. Guarded post-release admission supplies the missing publisher relationship (`server/db/scan-share.ts`).
7. Candidates union/deduplicate by scan ID, then `compareBadgeCandidates` orders releases by registry version semver, never latest scan completion; `pickBadgeScan` prefers registry-verified identity (`compareBadgeCandidates` in `server/db/scan-share.ts`, `pickBadgeScan` in `server/lib/public-feed.ts`, served by `server/routes/public-reports.ts`).
8. Version text uses npm `registry_version` when available; only reviews with no registry answer fall back to manifest version, already unverified (`buildBadgePayload`, `server/lib/public-feed.ts`).

### Badge states

`buildBadgePayload` in `server/lib/public-feed.ts` owns message/color; `badgeOutcome` in `server/routes/public-reports.ts` owns serve analytics. Approved message supersedes pre-decision risk; evidence remains in the report.

| Condition | Message | Color | Admission / outcome |
| --- | --- | --- | --- |
| No candidate / disabled | `not reviewed` | lightgrey | None / `not_reviewed` |
| Verified `publish` | `<version> approved` | brightgreen | Listed/default/post-release / `approved` |
| Manifest-claimed `publish` | `<version> approved` | lightgrey | Listed only / `approved` |
| Undecided | `<version> reviewed · <release risk> risk` | Risk color | Listed only / `reviewed` |
| `no_publish` | `<version> rejected` | red | Listed or guarded post-release / `blocked` |
| Newer published release without badge review | `<version> not reviewed` | lightgrey | Supersession / `superseded` |
| Publisher's confirmed unapproved publication | `<version> published without approval` | orange | Supersession / `superseded_unapproved` |
| Publisher rejected published bytes | `<version> rejected` | red | Supersession / `superseded_blocked` |
| Throttled | `unavailable` | lightgrey | Uncached `200`; never a package verdict |

| Label / risk property | Contract |
| --- | --- |
| Label | `drydock`; non-default tag adds `(beta)`; manifest claim adds `(unverified)`; combined example `drydock (rc, unverified)` |
| Risk palette | `RISK_BADGE_COLOR`, `server/lib/public-feed.ts`: low brightgreen, medium yellow, high/critical red |
| Unverified low risk | lightgrey, never clean green; PyPI/VS Code outside npm claim model |
| Release risk | `riskSummaryJson.releaseRisk`, falling back to artifact risk (`sharedScanReleaseRisk`, `server/lib/public-feed.ts`) |
| Superseded label | Removes identity qualifier because old pick no longer speaks for line |
| Rejection meaning | Records reviewer decision; never claims npm publication was blocked |
| Default-on response | Verdict only: no report link, findings, or feed entry; undecided/rejected scans absent without separate admission |

### Consent switch

| Condition / action | Behavior |
| --- | --- |
| Registry-verified publisher | Canonical claim + completed public-npm staged review under npm name with agreeing manifest (`isRegistryVerifiedPublisher`, `server/db/package-badge.ts`) |
| Eligible owner controls | `/dashboard/packages/:name` Public badge section shows controls/snippet for own approvals |
| Disable without evidence | `403`, `not_a_verified_publisher` |
| Enabled request | Removes only caller org's opt-out; cannot override canonical owner's choice |
| Disabled canonical badge | No fallback to other organizations' scans or post-release decisions; exact no-review response |
| Other org historical opt-out | Cannot silence canonical owner |
| Persistence | `package_badge_opt_outs`, keyed with same `publicPackageLookupKey` as public route |
| Audit | `organization.package_badge_disabled`, `organization.package_badge_enabled` on actual change |
| Purge | `latest` plus recorded tags, bounded by `listPackageBadgeTags` in `server/db/package-badge.ts`; local colo, best effort |
| Watch enrollment | Independent; switching badge never starts, stops, or suppresses watch/candidate enrollment |
| Feed listing | Independent; unlist to withdraw feed entry |
| PyPI / VS Code | Outside npm switch/claim model; unlisting withdraws manifest-claimed badge |

### Post-release decisions

The [publication monitor](./publication-monitor.md) can **Scan** an alerted release as published-pair review. Its decision may answer badge after release only under `resolvePostReleaseReview` in `server/lib/ecosystems/npm/publication-review.ts` and read-side guards in `server/db/badge-publication-evidence.ts`.

| Guard / lifecycle | Required evidence / behavior |
| --- | --- |
| Publisher | Same canonical registry-verified name rule as consent switch |
| Registry | Both monitor and review used public npm |
| Bytes | Every shared digest algorithm agrees, at least one shared; use sandbox `stagedPublish.artifactDigest` vs observed tarball digests |
| Previously unhashed release | Scan asks monitor to hash published tarball |
| Read recheck | Publisher still eligible; review complete, source `published`, exact alerted package/version/public npm, current decision matches recorded resolution |
| Exact release identity | Unredacted `stageId` (`published:npm:<package>@<version>`), not hostile manifest name/version or redacted summary coordinates |
| Badge coordinates | Alert's npm packument version, never reviewed manifest |
| Tag coverage | Monitor's recorded tags; stable version always answers `latest` so moving tag cannot hide decline |
| Same-version priority | Post-release outranks staged-byte review, including listed staged approval; two qualifying post-release decisions tie in favor of decline (`compareBadgeCandidates`, `server/db/scan-share.ts`) |
| Management transfer | Old org keeps own alert resolution but loses public badge authority |
| Decision changes | Recomputed only when review decided again; stale mismatching resolution ignored on read |
| Guarded approval | Clears quoted-version discrepancy/byte mismatch or newer-version supersession; can render post-release `approved` |
| Guarded decline | Renders `rejected` for published bytes |
| Historical observation | Never rewritten; decision read beside it |
| Failed badge guard | Org decision retained, flag unchanged; approval resolves alert only with matching published digests, even if publisher/registry badge rules fail |

### Supersession

`findBadgeSupersession` in `server/db/badge-publication-evidence.ts` combines scan and publication-monitor probes on cache miss. npm only; no registry-status staleness detection for PyPI/VS Code.

| Scan probe (`findNewerPublishedRelease`, `server/db/scan-share.ts`) | Bound |
| --- | --- |
| Organization | Pick's own organization; another org cannot change README verdict |
| Registry evidence | Only `registry_version_status = published`, rendering npm `registry_version`, never manifest `staged_version` |
| Badge absence | Newer release not already answering listed/default route; hidden review does not imply never scanned |
| Recency | Version order, not scan completion; scan time only bounds query page |
| Decision | Never consults/discloses newer scan's internal decision |
| Lookup | `scans.badge_package_key`, written for every badge-eligible scan, shared or not |
| Mismatching manifest | Release-line key still uses npm name so later shipped release can supersede old badge |
| Admission | Release-line key is never authorization; only listed `public_package_key`/timestamp, `badge_public`, or guarded post-release admits |

| Monitor evidence (`findPublicationDiscrepancy`, `server/db/badge-publication-evidence.ts`) | Result |
| --- | --- |
| Sources | Own `publication_observations` joined to watch, plus `publication_alerts` ledger surviving stopped watch |
| Another version supersedes quote, not `approved_match` | New version `not reviewed`, including `unknown`; confirmed discrepancy may flag orange/red |
| Another version `approved_match` | Left to scan-based path, which knows badge eligibility |
| Quoted version confirmed discrepancy | `published_without_approval`, `published_despite_rejection`, `artifact_mismatch` disqualify approval |
| Quoted version published despite rejection | `rejected` red for registry-verified publisher; guarded later approval clears |
| Quoted version published SHA-1 differs from verified pick digest | Grey even if monitor verdict `unknown`; no compared digest on listed pick leaves only explicit discrepancies applicable |
| Quoted version merely `unknown` | Leaves approved quote alone absent byte mismatch |
| Pick already rejected | Keeps red warning rather than greying same-version pick |
| Alert ownership | Orange/red requires `isRegistryVerifiedPublisher` rechecked on read; other org evidence remains grey |
| Non-alert `undecided_low_risk` / `unknown` | Never orange; newer version can still supersede to grey |
| Badge-only byte mismatch while monitor unknown | Grey, never orange |
| No watch / alert evidence | Answer from scans alone |
| Information boundary | Version comes from npm; never reveals who published or discrepancy subtype beyond rejection |

| Release-line inference | Supersession rule |
| --- | --- |
| Recorded tag holder differs from quote | Supersedes regardless of version shape/order |
| npm default publish tag | A prerelease published without `--tag` can take `latest`; recorded holder overrides version-shape inference (`server/db/badge-publication-evidence.ts`) |
| Snapshot safety | Recorded tags only add supersession, never remove it; moving tag back cannot clear newer unapproved release |
| `latest` shape floor | Newer stable version; newer prerelease too when pick is prerelease |
| Other tag, stable pick | Newer stable within same major (maintenance line) |
| Other tag, prerelease pick | Newer prerelease with same leading channel identifier, stripping trailing digits |
| Outside inference | Version-shape rules do not detect it unless recorded tag supplies evidence |

### Badge verdict

An npm badge links to `/diff/<name>`, which resolves to the latest published pair. `GET /public/badge-verdict/:ecosystem/:package` hands that page the default-tag badge's answer, computed by the badge's own read (`resolveBadge` in `server/routes/public-reports.ts`: same candidate queries, switch, pick, and supersession probe), so it can never say more than the badge.

| Badge would say | Verdict response |
| --- | --- |
| approved / rejected / published without approval | `{ verdict: { version, outcome, decidedAfterPublish } }`, `outcome` one of `approved`, `rejected`, `published_without_approval` |
| `not reviewed`, undecided `reviewed · <risk>`, superseded `not reviewed`, any `unverified` pick | `{ verdict: null }` (byte-identical for unscanned and unqualified packages: no enumeration oracle) |

1. The `/diff` page renders the verdict only when `version` equals the diff's `to` version; an older pair, or a newer release the badge has not caught up with, carries no claim. The claim is worded as the publisher's own, beside the page's own risk grade.
2. Approval copy states no timing beyond `decidedAfterPublish`: a staged review ran before release, but its decision may have come after npm published.
3. Same ecosystems, names, and per-IP rate-limit bucket as the badge; colo-cached 300 s under its own key and purged with the badge on revoke/unlist/switch, so both age together.
4. `/api/public/v1/package-diff` stays D1-free: the page fetches this route separately.

### Caching and embeds

| Case | Behavior |
| --- | --- |
| Success / negative response | Per-colo `caches.default`, `max-age=300`; payload `BADGE_CACHE_SECONDS` = 300 in `server/lib/public-feed.ts` |
| Cache key | Canonical origin + normalized package key + exact resolved tag; alternate encodings collapse; npm case preserved |
| Disabled / no review | Negative answer cached under same key; repeat requests avoid candidate/opt-out D1 queries |
| Listing / enable | Purges local negative cache; other regions may retain until TTL |
| User decision/list/unlist/revoke | Purges affected tag; request-colo only, best effort; immediate report revoke remains authority |
| Cron publication sweep / monitor | No request colo to purge; new/default or grey/orange badge delayed up to 300s |
| shields.io proxy | Adds its own at-least-300s floor; withdrawal/state change can take roughly ten minutes in README |
| Throttling | Separate `PUBLIC_BADGE_READ_RATE`, `public-badge` per-IP bucket, 120/60s in `server/routes/public-reports.ts`; `200 unavailable`, `no-store`, `retry-after` |
| Throttle payload | `BADGE_UNAVAILABLE_CACHE_SECONDS` = 30 in `server/lib/public-feed.ts`; no Worker cache; never mislabels as `not reviewed` |
| Invalid request | Uncached; public CORS/error behavior follows [public-reports.md](./public-reports.md) |

| Embed / snippet | Contract |
| --- | --- |
| Image | `https://img.shields.io/endpoint?url=<origin>/public/badge/npm/<package>`; URL-encode badge URL |
| Prerelease | Append `%3Ftag=beta` inside encoded URL |
| Share dialog snippet | Default-on or feed-listed, with resolved ecosystem/name; npm also requires owned claim and allowed management (`shareBadgeMarkdown`, `src/lib/badge-markdown.ts`) |
| Snippet release line | Copied scan's tag: `rc` → `?tag=rc`, alt `Drydock review (rc)`; `latest`/untagged → short form |
| Click target npm | Evergreen package-only `/diff/<name>` resolving latest published pair on load |
| Click target PyPI/VS Code | Copied share URL, version-pinned; no package-only diff form |
| Image freshness | Most recent qualifying review on that release line; click destination must respect its scope |

## Invariants

1. Anonymous badge is a verdict, not enforcement: a red rejection does not assert npm blocked publication (`test/badge-payload.test.ts`).
2. A private share never becomes package-name-queryable without badge admission (`server/db/scan-share.ts`).
3. npm public identity is npm's name on public npm, with exact manifest agreement and canonical management, never manifest claim alone (`test/workers/threat-feed-badge.test.ts`).
4. Post-release published-pair admission requires byte equality and publisher guard, not merely ranking it last (`test/workers/badge-post-release.test.ts`).
5. Another organization's scans/alerts cannot supersede canonical owner's badge (`server/db/badge-publication-evidence.ts`).
6. Default eligibility **fails closed**; no opt-in is required only when all persistence/read guards hold (`test/badge-eligibility.test.ts`).

## Failure modes

| Symptom / condition | Cause | What happens | Fix |
| --- | --- | --- | --- |
| Badge remains old after leaving Drydock | No newer own scan or monitor evidence | Last quote can persist | Enable watch or disable badge |
| Historical rows lack release-line/default evidence | Pre-column data | Missing badge/supersession | Audit assumptions/queries, run `pnpm run db:backfill:badge-package-key:remote`; see [tooling.md](./tooling.md) |
| Name lacks canonical ownership | Pending historical audit / provisional management | `not reviewed` | Audit/confirm management per [package-claims.md](./package-claims.md) before deployment |
| Unexpected grey/orange/red | New published release, digest mismatch, or own monitor alert | State tables apply | Scan alert; decide reviewed published bytes |
| Non-semver ordering | `compareSemver` falls back to `localeCompare` | Listed unverified gate review may order arbitrarily | Inspect actual registry/manifest version |
| Invalid ecosystem/name | Unknown ecosystem, bad encoding, empty/overlong name | `404` ecosystem; `400` name (`publicPackageNameMax`, `server/lib/public-feed.ts`) | Correct embed URL |
| Badge state PUT invalid | Missing boolean or invalid name/ecosystem | `400` | Send boolean `enabled` and valid target |
| Disable denied | No verified publisher evidence | `403 not_a_verified_publisher` | Use canonical management org with completed verified stage review |
| Recently changed badge stale | Other-colo / proxy cache | Up to ~10 minutes | Allow TTL; report link is immediate authority |

## Change checklist

| If you change… | Also update… | Run… |
| --- | --- | --- |
| Identity/admission/labels | [public-reports.md](./public-reports.md), claim/read/write parity | `pnpm exec vitest run --project node test/badge-eligibility.test.ts test/badge-payload.test.ts test/badge-markdown.test.ts` |
| Ownership, consent, disclosure | [package-claims.md](./package-claims.md), [security-model.md](./security-model.md) | `pnpm exec vitest run --project workers test/workers/threat-feed-badge.test.ts` |
| Post-release / monitor evidence | [publication-monitor.md](./publication-monitor.md) | `pnpm exec vitest run --project workers test/workers/badge-post-release.test.ts` |
