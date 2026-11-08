# Public package diff (`/diff`)

Anonymous diff of two published releases of an npm package, PyPI project, or atpm package, with the deterministic rule set run over the newer side. **Authority:** anonymous, advisory. **Owner:** `server/lib/public-diff/index.ts`.

## At a glance

| Thing | Owner |
| --- | --- |
| HTTP routes | `server/routes/public-diff.ts`, mounted at `/api/public/v1/package-diff` before auth |
| Orchestration, caches | `server/lib/public-diff/index.ts` |
| Per-ecosystem acquisition | `server/lib/ecosystems/<id>/public-diff.ts` behind `PublicDiffAdapter` |
| pkg.pr.new preview-URL parsing | `src/lib/pkg-pr-new.ts` (shared by server and UI) |
| Share card (`og:image`) | `server/routes/og.ts`, SVG in `server/lib/public-diff/card.ts`, PNG in `card-render.ts` |
| HTML metadata rewrite | `server/lib/public-diff/page.ts`: title, description, Open Graph, Twitter, canonical on the static `/diff` shell |
| atpm resolution chain | [`atpm.md`](./atpm.md) |
| Tarball-byte cache | [`diff-baseline.md`](./diff-baseline.md) |
| Rate-limit tiers | [`security-model.md`](./security-model.md#rate-limiting) |

## Contract

| Endpoint (`/api/public/v1/package-diff…`) | Purpose |
| --- | --- |
| `GET /?package&from&to` | Version-pair diff, findings, file tree (npm `from`/`to` also accept pkg.pr.new preview URLs) |
| `GET /file?package&from&to&path` | One file's samples for a pair |
| `GET /versions?package` | Published version list (5 min cache, 10 min stale) |
| `GET /atpm-stage?publisher&rkey` | atpm staged-candidate link: browsers get a redirect to the ordinary diff URL, API clients the resolved review as JSON (30/min/IP); see [`atpm.md`](./atpm.md) |

All take `ecosystem=npm` (default) `| pypi | atpm`.

| Ecosystem | Metadata source | Artifact bytes from | Page URL |
| --- | --- | --- | --- |
| npm | canonical public npm registry | registry tarball URLs | `/diff/<name>/<from>/<to>` |
| PyPI | `pypi.org` JSON API | only `files.pythonhosted.org` | `/diff/pypi/<project>/<from>/<to>` |
| atpm | publisher's AT Protocol identity and PDS | the PDS blob, pinned as the only egress | `/diff/atpm/<did>/<name>/<from>/<to>` (handle form redirects to the DID URL) |

Share card path mirrors the page path under `/og/diff/…/card.png` via the shared `packageDiffCardPath` helper, with no query string (a raw `&` in `og:image` breaks strict scrapers).

## Limits and caches

| Item | Value / rule | Constant |
| --- | --- | --- |
| Result cache, KV (cross-colo) | 30 days in `COMPARE_CACHE` | `CACHE_TTL_SECONDS` |
| Result cache, colo | awaited `caches.default` write, so the first file navigation hits in the serving colo | `writePublicDiffColoCache` |
| Pairs with a pkg.pr.new preview | cached at most 15 minutes; preview bytes never enter the shared tarball-byte cache | `PREVIEW_CACHE_TTL_SECONDS` |
| Cached payload ceiling | 20 MiB (UTF-8 bytes, counted without encoding copies) | `CACHE_MAX_PAYLOAD_BYTES` |
| Unchanged-file sample sub-budget | 2 MiB | `UNCHANGED_SAMPLE_BUDGET_BYTES` |
| PyPI selected-download budget | 50 MiB advertised across both versions | `PUBLIC_PYPI_DIFF_MAX_SELECTED_BYTES` |
| PyPI artifacts per side | one sdist + one wheel; prefer a wheel shape both versions publish, then `py3-none-any` | `server/lib/ecosystems/pypi/public-diff.ts` |
| Registry metadata reads | npm: packument streamed, ≤128 MiB decoded, 100,000 versions, 8 Mi retained characters, else `413` cached 10 min. PyPI: JSON ≤16 MiB, else `502`. Other failures `502` cached 60 s; a `404` is not cached | `MAX_PACKUMENT_BYTES`, `MAX_PACKUMENT_RETAINED_CHARS`, `MAX_PYPI_METADATA_BYTES`, `writeMetadataUnavailable` |
| Share-card renders | 60 per IP per minute, charged only on a colo-cache miss; `max-age=3600, s-maxage=86400` | `OG_CARD_RATE_LIMIT` |
| Share-card failure | static `/og-image.png`, `max-age=60` | `STATIC_FALLBACK_PATH` |
| Cache keys | include ecosystem, deterministic-rules version, risk-schema version; PyPI adds PyPI rules version and the PEP 503 name | `server/lib/public-diff/index.ts` |
| Purge tags | `Cache-Tag: public-diff:<package>` (npm), `public-diff:pypi:<project>` | — |

Over-budget payloads keep samples in priority order: changed paths first, then unchanged paths under the sub-budget, cheapest sample first within each tier. Both sides of a path are kept or dropped together. A record that lost its sample carries `sample-omitted` (`SAMPLE_OMITTED_FLAG`); the UI shows a badge, an explanation, and sha256 identity lines. Only a pair whose changed files alone do not fit is cached as metadata with no samples.

## Invariants

1. Mounted before the auth middleware; uses no credentials. Enabled only when `NPM_REGISTRY` is the canonical public npm registry; otherwise the whole API (PyPI and atpm modes included) returns `404`.
2. Persists no review data to D1 and never runs AI review.
3. Findings run on raw text before redaction; only redacted evidence is cached or returned (same order as the scan pipeline).
4. Abuse control is per-IP native Rate Limiting bindings, so no anonymous request path touches D1. File-content cache misses share the stricter version-pair budget; cache hits get a higher navigation allowance.
5. Version-pair responses require origin revalidation, so browsers never keep an older analysis after a deploy.
6. PyPI comparable pairs parse one at a time, so at most two sandbox Workers inflate archives concurrently. When both artifact kinds do not fit the budget, the cheaper pair is reviewed and the omitted kind is disclosed in the response. Contents are namespaced `sdist/…` and `wheel/<tags>/…`.
7. Share cards read only the result cache and never trigger a cold computation; a miss renders package and versions without counts. Fonts load from `public/fonts/` through `ASSETS` once per isolate, not bundled.
8. `provenance` (resolution trail) links are rebuilt from validated parts, never raw publisher values. Only atpm supplies `provenance` and `displayName` today: the canonical name is a DID so handle reassignment cannot redirect a shared link; the page renders the verified `@handle/name`, and `did:web` ownership is disclosed as domain-bound.
9. A persisted (authenticated) review rejects mutable preview refs; only `/diff` accepts them.

## Change checklist

- New ecosystem: add `<id>/public-diff.ts` and the `publicDiff` registry entry ([`architecture.md`](./architecture.md#ecosystems-and-capabilities)); include its rules version in the cache key.
- Changing rules or risk schema: the cache key already rotates through the version constants; bump them.
- Changing card layout: tokens come from [`design.md`](./design.md) light mode.
