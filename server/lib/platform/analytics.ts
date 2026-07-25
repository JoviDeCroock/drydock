// Product analytics: queryable counters for the questions Workers Logs cannot
// answer after its retention window closes.
//
// Why this exists. Scan lifecycle events (`scan.queued`/`started`/`completed`)
// used to be D1 `scan_events` rows. They were ~97% of that table and carried no
// audit value, so they were correctly removed (docs/audit-log.md) and pointed at
// Workers Logs — but Workers Logs is a short-retention debugging stream, not a
// historical store, so scan volume, latency, failure rate, and AI-reviewer
// health stopped being measurable at all. Analytics Engine is the replacement:
// it keeps the aggregate without keeping the row.
//
// Privacy posture, matching docs/security-model.md:
//   - No PII. No user ids, emails, IP addresses, user agents, or session data.
//   - No package contents, evidence, findings text, file paths, or versions.
//   - Organization ids are opaque internal identifiers and appear only on
//     authenticated events, so per-organization adoption stays answerable
//     without identifying a person.
//   - Public-diff events record only the package name, which is already public
//     data in the request URL, the response cache key, and the page's own
//     Open Graph metadata.
//   - Nothing is written from the browser. There is no client script, no
//     beacon endpoint, no cookie, and therefore no new anonymous surface to
//     rate-limit. Every event below is emitted by the Worker while it is
//     already handling the request that caused it.
//
// Known gap, deliberately: because there is no client instrumentation, in-page
// interactions are invisible. `/diff` view-through is counted, but a click on
// its "Create account" call-to-action is not, so the diff → signup conversion
// rate cannot be computed from this data alone — only its numerator (signups)
// and a view count. Closing that needs a client beacon and the public-endpoint
// review the security model requires for one.

import { emitOperationalEvent } from "./observability";

/** Bump when blob/double positions change meaning; queries key off it. */
export const ANALYTICS_SCHEMA_VERSION = "1";

export type AnalyticsEvent =
  | {
      name: "scan.queued";
      organizationId: string;
      ecosystem: string;
      source: string;
    }
  | {
      name: "scan.completed";
      organizationId: string;
      ecosystem: string;
      source: string;
      releaseRisk: string;
      artifactRisk: string;
      contextRisk: string;
      durationMs: number;
      ruleFindingCount: number;
      aiFindingCount: number;
    }
  | {
      name: "scan.failed";
      organizationId: string;
      ecosystem: string;
      source: string;
      /** Stable failure slug (e.g. `staged_tarball_unavailable`), never a raw message. */
      code: string;
      durationMs: number;
    }
  | {
      name: "scan.decided";
      organizationId: string;
      ecosystem: string;
      decision: string;
      releaseRisk: string;
      artifactRisk: string;
      /** Time from scan creation to the maintainer's decision. */
      timeToDecisionMs: number;
    }
  | {
      name: "ai_review.finished";
      organizationId: string;
      ecosystem: string;
      /**
       * `complete` | `invalid` | `unavailable` | `errored` — the silent-failure
       * rate. `errored` is this layer's own value for a review that threw; the
       * other three come from `AiReviewStatus`.
       *
       * Note the denominator: a scan whose organization has the `ai-review`
       * killswitch off (or that runs without a `FLAGS` binding at all) returns
       * before the reviewer is invoked and emits nothing here, so this counts
       * attempted reviews, not scans.
       */
      status: string;
      model: string;
      durationMs: number;
      findingCount: number;
    }
  | {
      name: "npm_connection.validated";
      organizationId: string;
      /** `ok` | `failed` */
      outcome: string;
    }
  | {
      name: "public_diff.viewed";
      ecosystem: string;
      /** Public package/project name — already public in the URL and cache key. */
      packageName: string;
      /** `hit` | `miss` — how much of this traffic the caches absorb. */
      cache: string;
      risk: string;
      durationMs: number;
    };

/**
 * Write one product event. Never throws and never blocks the caller's result:
 * analytics is the least important thing happening in any request that emits
 * one, so a missing binding (local dev, tests) or a write failure degrades to a
 * warn log and nothing else.
 */
export function recordProductEvent(
  env: Pick<Cloudflare.Env, "PRODUCT_ANALYTICS"> | undefined,
  event: AnalyticsEvent,
): void {
  const dataset = env?.PRODUCT_ANALYTICS;
  if (!dataset) return;
  try {
    dataset.writeDataPoint(toDataPoint(event));
  } catch (err) {
    emitOperationalEvent("warn", "analytics.write_failed", {
      event: event.name,
      error: err instanceof Error ? err.name : typeof err,
    });
  }
}

/**
 * Blob and double positions are fixed by schema version, because Analytics
 * Engine columns are positional (`blob1`, `double1`, …) rather than named — a
 * reordering silently rewrites the meaning of every historical query.
 *
 * indexes: [name]        — the sampling key, so a high-volume event can never
 *                          starve a low-volume one out of the dataset.
 * blob1:   schema version
 * blob2:   event name (also in the index; repeated so queries need only blobs)
 * blob3:   organization id, or "" for anonymous events
 * blob4:   ecosystem
 * blob5–8: event-specific dimensions, in the order declared per event below
 * double1: duration in ms (0 when not applicable)
 * double2–4: event-specific counts
 */
function toDataPoint(event: AnalyticsEvent): AnalyticsEngineDataPoint {
  const base = (
    organizationId: string,
    ecosystem: string,
    blobs: string[],
    doubles: number[],
  ): AnalyticsEngineDataPoint => ({
    indexes: [event.name],
    blobs: [ANALYTICS_SCHEMA_VERSION, event.name, organizationId, ecosystem, ...blobs],
    doubles,
  });

  switch (event.name) {
    case "scan.queued":
      return base(event.organizationId, event.ecosystem, [event.source], [0]);
    case "scan.completed":
      return base(
        event.organizationId,
        event.ecosystem,
        [event.source, event.releaseRisk, event.artifactRisk, event.contextRisk],
        [event.durationMs, event.ruleFindingCount, event.aiFindingCount],
      );
    case "scan.failed":
      return base(
        event.organizationId,
        event.ecosystem,
        [event.source, event.code],
        [event.durationMs],
      );
    case "scan.decided":
      return base(
        event.organizationId,
        event.ecosystem,
        [event.decision, event.releaseRisk, event.artifactRisk],
        [event.timeToDecisionMs],
      );
    case "ai_review.finished":
      return base(
        event.organizationId,
        event.ecosystem,
        [event.status, event.model],
        [event.durationMs, event.findingCount],
      );
    case "npm_connection.validated":
      return base(event.organizationId, "npm", [event.outcome], [0]);
    case "public_diff.viewed":
      return base(
        "",
        event.ecosystem,
        [event.packageName, event.cache, event.risk],
        [event.durationMs],
      );
  }
}
