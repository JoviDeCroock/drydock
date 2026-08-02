# Marketing attribution

Coarse channel attribution for the public marketing surfaces. It exists to answer one operational question — _which channel is actually sending people to the package diff_ — without building visitor analytics.

## What is recorded

One `marketing_page.viewed` Analytics Engine point per document request:

| Analytics slot | Meaning                                                  |
| -------------- | -------------------------------------------------------- |
| `index1`       | `marketing_page.viewed`, the event and sampling key      |
| `blob1`        | Analytics schema version                                 |
| `blob2`        | `marketing_page.viewed`                                  |
| `blob3–4`      | Empty: no organization or ecosystem is attached          |
| `blob5`        | `landing`, `docs`, `diff_index`, or `diff`               |
| `blob6`        | Channel bucket from the closed list in `TRAFFIC_SOURCES` |

Nothing else. No IP address, full referrer URL, user agent, session or visitor identifier, package name, or version. Authenticated routes (`/dashboard/**`) and the auth flow (`/login`, `/register`, `/verify-email`) are never recorded at all.

## How a channel is decided

`server/lib/platform/traffic-source.ts` classifies each document request, in this order:

1. **Bot** — the user agent matches a crawler pattern. Unfurl crawlers are labeled rather than dropped: a `bot` row is the signal that a link was actually posted somewhere, and keeping it labeled means human counts can exclude it instead of silently absorbing it.
2. **Campaign** — an explicit `utm_source`, mapped through an allowlist. An unrecognized value collapses to `other`, so a crafted link cannot create unbounded analytics dimension cardinality.
3. **Referrer host** — mapped to a bucket (`bluesky`, `x`, `linkedin`, `hackernews`, `reddit`, `youtube`, `github`, `search`, `registry`, `chat`). Our own hostname resolves to `internal`.
4. **Direct** — no referrer at all.

Attribution runs on the **document** request, in the asset-serving path in `server/index.ts`. That is the only place an external `Referer` survives: the diff page's own API calls carry a same-origin referrer and would attribute every visit to ourselves. `recordProductEvent` is synchronous, non-throwing, and a no-op without the optional binding — analytics must never turn a page view into an error.

## Reading it

```sh
# Last 30 days by channel, humans only, for the package diff.
curl "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -d "SELECT blob6 AS source, SUM(_sample_interval) AS views
      FROM drydock_product_events
      WHERE index1 = 'marketing_page.viewed'
        AND blob5 IN ('diff', 'diff_index')
        AND blob6 != 'bot'
        AND timestamp > NOW() - INTERVAL '30' DAY
      GROUP BY source
      ORDER BY views DESC"
```

```sh
# Day-by-day for one channel, to line a spike up against a post.
curl "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -d "SELECT
        toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day,
        blob5 AS surface,
        SUM(_sample_interval) AS views
      FROM drydock_product_events
      WHERE index1 = 'marketing_page.viewed'
        AND blob6 = 'bluesky'
        AND timestamp > NOW() - INTERVAL '30' DAY
      GROUP BY day, surface
      ORDER BY day DESC"
```

Always filter `source != 'bot'` for human traffic. Crawler fetches scale with the number of platforms a link was posted to, not with interest.

## Retention and scale

Retention follows the configured Analytics Engine dataset rather than an application cron. Queries must use `SUM(_sample_interval)` for counts so they remain correct when Analytics Engine samples high-volume events. Keeping attribution in the existing analytics dataset also avoids a D1 write and a shared hot counter row on every public page view.

## Share cards

The per-diff Open Graph cards under `/og/diff/**/card.png` are the other half of this: they make a shared diff link self-describing in a timeline. See [`architecture.md`](./architecture.md#public-package-diff) for how they are rendered and cached, and [`security-model.md`](./security-model.md) for the anonymous-surface rules they inherit.
