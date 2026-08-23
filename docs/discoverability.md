# Discoverability operations

Drydock keeps search discovery and product outcomes measurable without adding a
browser tracker. Search impressions, clicks, queries, landing pages, and index
coverage belong in Google Search Console. Successful anonymous artifact reads,
signups, integrations, scans, and workflow gates come from the existing
privacy-preserving Analytics Engine events.

## One-time search setup

1. Add a **Domain property** for `drydock.org` in Google Search Console and
   complete its DNS ownership verification. A Domain property includes the apex,
   `www`, and protocol variants while the site redirects visitors to the apex.
2. Submit `https://drydock.org/sitemap.xml` in the
   [Sitemaps report](https://support.google.com/webmasters/answer/7451001). The sitemap
   is already advertised from `public/robots.txt`; explicit submission makes
   crawl success and errors visible in Search Console.
3. Use [URL Inspection](https://support.google.com/webmasters/answer/9012289) on
   the homepage, `/diff`, and every newly published
   focused guide. Request indexing only after the live test sees a successful,
   self-canonical 200 response.
4. Check the [Page indexing report](https://support.google.com/webmasters/answer/7440203)
   after deployment. A redirect URL should not be
   indexed; its apex target should be. Treat a sitemap URL that redirects or
   declares another canonical as a release defect.

Search Console ownership and sitemap submission are external operator actions;
they cannot be completed by a repository deployment.

## Weekly search scorecard

Use a 28-day window compared with the preceding 28 days, and record:

- total organic clicks and impressions;
- non-branded clicks and impressions (queries that do not contain `drydock`);
- clicks, impressions, click-through rate, and average position by landing page;
- queries earning impressions for the focused npm, PyPI, VS Code, GitHub Actions,
  package-diff, security-model, and open-source pages;
- valid indexed sitemap URLs and any canonical, redirect, or crawl exclusions.

Do not optimize a page from a one-week fluctuation. Change a title or page only
when at least 28 days show a stable mismatch: impressions with weak CTR suggest
the result copy is wrong; relevant queries with weak position suggest the page
does not yet answer the intent; no impressions plus an indexing exclusion is a
technical defect.

## Product-outcome snapshot

Create a Cloudflare API token with `Account Analytics Read`, as described in the
[Analytics Engine SQL API documentation](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/),
then run:

```sh
DRYDOCK_CF_ACCOUNT_ID=<32-character-account-id> \
DRYDOCK_CF_ANALYTICS_TOKEN=<read-only-token> \
pnpm run discoverability:snapshot
```

`-- --days <1-90>` changes the default 28-day window. The command sends four
fixed aggregate SQL queries to the Analytics Engine SQL API and prints JSON to
stdout. It measures:

- successful public diff reads, split by ecosystem and cache outcome;
- signups, explicit organizations, connected integrations, completed scans, and
  opened workflow gates;
- connected integrations by kind;
- completed scans by ecosystem.

Counts use `SUM(_sample_interval)`, so they remain correct when Analytics Engine
sampling engages. Queries pin analytics schema version `1` and never select the
organization slot, package name, visitor data, or any identifier.

## Reading the two sources together

Search Console answers whether useful pages are being found. Analytics Engine
answers whether visitors reach work that Drydock can safely count. The two
datasets are intentionally not joined: there is no referrer, campaign id,
cookie, or browser event connecting a search click to a signup or review.

Consequently, `signups / public diff reads` is only a coarse yield, not a user
conversion rate. Use trends to decide where to investigate, not to claim
attribution. See [`product-analytics.md`](./product-analytics.md) for the event
schema and privacy boundary.
