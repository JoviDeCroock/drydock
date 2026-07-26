# Marketing attribution

Coarse, per-day channel attribution for the public marketing surfaces. It exists to answer one operational question — _which channel is actually sending people to the package diff_ — without building visitor analytics.

## What is recorded

One counter row per `(UTC day, surface, channel)`:

| Column       | Meaning                                                  |
| ------------ | -------------------------------------------------------- |
| `day`        | UTC date, `YYYY-MM-DD`                                   |
| `surface`    | `landing`, `docs`, `diff_index`, or `diff`               |
| `source`     | Channel bucket from the closed list in `TRAFFIC_SOURCES` |
| `views`      | Number of document requests in that bucket               |
| `updated_at` | Last increment                                           |

Nothing else. No IP address, no full referrer URL, no user agent, no session or visitor identifier, and no per-visit row — so a row can never be narrowed to a person. Authenticated routes (`/dashboard/**`) and the auth flow (`/login`, `/register`, `/verify-email`) are never recorded at all.

## How a channel is decided

`server/lib/traffic-source.ts` classifies each document request, in this order:

1. **Bot** — the user agent matches a crawler pattern. Unfurl crawlers are labeled rather than dropped: a `bot` row is the signal that a link was actually posted somewhere, and keeping it labeled means human counts can exclude it instead of silently absorbing it.
2. **Campaign** — an explicit `utm_source`, mapped through an allowlist. An unrecognized value collapses to `other`, so a crafted link cannot invent unbounded distinct storage keys.
3. **Referrer host** — mapped to a bucket (`bluesky`, `x`, `linkedin`, `hackernews`, `reddit`, `youtube`, `github`, `search`, `registry`, `chat`). Our own hostname resolves to `internal`.
4. **Direct** — no referrer at all.

Attribution runs on the **document** request, in the asset-serving path in `server/index.ts`. That is the only place an external `Referer` survives: the diff page's own API calls carry a same-origin referrer and would attribute every visit to ourselves. The write is fire-and-forget through `waitUntil` and swallows its own errors — a counter must never turn a page view into an error.

## Reading it

```bash
# Last 30 days by channel, humans only, for the package diff.
npx wrangler d1 execute staged-publish-review --remote --json --command "
  SELECT source, SUM(views) AS views
  FROM marketing_referrals
  WHERE surface IN ('diff', 'diff_index')
    AND source != 'bot'
    AND day >= date('now', '-30 days')
  GROUP BY source
  ORDER BY views DESC"
```

```bash
# Day-by-day for one channel, to line a spike up against a post.
npx wrangler d1 execute staged-publish-review --remote --json --command "
  SELECT day, surface, views
  FROM marketing_referrals
  WHERE source = 'bluesky'
  ORDER BY day DESC
  LIMIT 30"
```

Always filter `source != 'bot'` for human traffic. Crawler fetches scale with the number of platforms a link was posted to, not with interest.

## Retention and scale

Rows are pruned after `MARKETING_REFERRAL_RETENTION_DAYS` (400 days) by the same cron tick that prunes the audit log — long enough to compare a channel across months.

The write is one upsert per marketing page view. At current traffic that is a rounding error next to the existing per-request rate-limit writes. If page views ever reach a scale where that matters, the fix is per-isolate coalescing (accumulate in module scope, flush on a threshold), not sampling: a sampled counter cannot be compared against an unsampled earlier period.

## Share cards

The per-diff Open Graph cards under `/og/diff/**/card.png` are the other half of this: they make a shared diff link self-describing in a timeline. See [`architecture.md`](./architecture.md#public-package-diff) for how they are rendered and cached, and [`security-model.md`](./security-model.md) for the anonymous-surface rules they inherit.
