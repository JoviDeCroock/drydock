# Product analytics

Drydock captures a small, deliberate set of product-usage events with
[PostHog](https://posthog.com) (EU cloud) so we can see how reviewers move
through the core funnel — discovering staged publishes, opening a scan, and
recording a Ship/Hold decision. This is distinct from the operational telemetry
in `server/lib/observability.ts`, which exists for reliability and debugging.

Analytics is **opt-in by configuration**: nothing is sent unless a public
PostHog key is set at build time, so local dev, forks, and self-hosted
deployments are analytics-free by default.

## Privacy posture

Drydock is a security product, so analytics is held to the same redaction
discipline as the rest of the platform:

- **First-party only.** The browser never talks to PostHog directly. All traffic
  goes through a same-origin reverse proxy on the Worker (`/b/*`), so it is not
  blocked by content blockers and needs no third-party CSP entry.
- **No PII, no package data.** Events carry only opaque identifiers and coarse,
  non-sensitive properties (decision outcome, risk level, status). Never send a
  name, email, package name, version, finding text, decision reason, or token.
- **No reviewer IPs.** The proxy strips `cf-connecting-ip`, `x-forwarded-for`,
  `x-real-ip`, `true-client-ip`, `forwarded`, and cookies before forwarding, so
  PostHog never sees an end-user IP (GeoIP is traded away for privacy).
- **Identified-only profiles**, autocapture/session-recording/surveys disabled,
  and `Do Not Track` respected.

## Architecture

| Piece                                  | File                                                           |
| -------------------------------------- | -------------------------------------------------------------- |
| Shared proxy path prefix (`/b`)        | `server/lib/analytics-proxy-path.ts`                           |
| Worker reverse proxy to PostHog EU     | `server/lib/analytics-proxy.ts` (mounted in `server/index.ts`) |
| Browser SDK init + typed event helpers | `src/lib/analytics.ts`                                         |
| Identity/org/pageview wiring           | `src/components/AnalyticsTracker.tsx`                          |

The proxy fans `${prefix}/static/*` to `eu-assets.i.posthog.com` (SDK asset
bundles) and everything else to `eu.i.posthog.com` (ingestion, flags, decide).
The `/b/*` route is public and auth-free by design — the browser SDK has no
session — and is also pre-declared for the legacy zone in `wrangler.jsonc`.

## Events

Event names are centralised in the `AnalyticsEvent` map in `src/lib/analytics.ts`
— they are stable wire identifiers, so do not rename them casually. Captured
properties are restricted to non-PII primitives.

| Event                             | Fires when                           | Properties                                             |
| --------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| `$pageview`                       | Each SPA route change                | (PostHog defaults)                                     |
| `scan_discovery_run`              | Staged-publish discovery completes   | `found`, `created`, `skipped`                          |
| `scan_detail_viewed`              | A scan detail is opened (first load) | `status`, `risk`, `source`                             |
| `scan_decision_recorded`          | A Ship/Hold decision is saved        | `surface`, `decision`, `outcome`, `risk`, `had_reason` |
| `workflow_gate_decision_recorded` | A workflow-gate decision is saved    | `decision`, `had_comment`                              |

Identity is set with `posthog.identify(userId)` (no traits) and events are
grouped by `organization` via `posthog.group(...)` for per-customer funnels.

## Configuration

Set the public PostHog project key (write-only, safe to ship in the client
bundle) at **build time** — it is inlined by `vite build`:

```sh
VITE_PUBLIC_POSTHOG_KEY=phc_xxx pnpm run build
```

See `.env.example`. Leave it unset to disable analytics. No server-side secret is
required; the proxy targets a fixed PostHog EU upstream.

## Tests

- `test/analytics-proxy.test.ts` — proxy path mapping, asset-host split, header
  stripping, and `set-cookie` removal.
- `test/workers/analytics-proxy.test.ts` — the `/b/*` route is public and does
  not fall through to the asset binding.
