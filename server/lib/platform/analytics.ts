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
//   - Marketing-page events record only an allowlisted surface and channel
//     bucket. The raw referrer and user agent are discarded before this layer.
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
import type { MarketingSurface, TrafficSource } from "./traffic-source";

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
      /**
       * A queued scan retired without ever running: currently only an
       * auto-discovered staged publish whose tarball vanished before the job
       * claimed it (npm unpublished or replaced the candidate). Separate from
       * `scan.failed` on purpose — folding a routine race into the failure rate
       * would make the reviewer's real failure rate unreadable — but still a
       * terminal event, so every `scan.queued` has exactly one counterpart.
       */
      name: "scan.discarded";
      organizationId: string;
      ecosystem: string;
      source: string;
      /** Stable reason slug, never a raw message. */
      reason: string;
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
      /**
       * A new account. Carries no organization (the personal workspace is
       * created lazily on first use) and, deliberately, no user id — see the
       * privacy posture above. This is the funnel's numerator and nothing more.
       */
      name: "user.signed_up";
      /** `email_password` — the sign-up method, for when others exist. */
      method: string;
      /** `verification_pending` | `active` */
      outcome: string;
    }
  | {
      /**
       * An explicitly created organization. Personal workspaces are excluded:
       * `ensurePersonalOrganization` creates one for every account on first
       * request, so counting them would just restate `user.signed_up`.
       */
      name: "organization.created";
      organizationId: string;
    }
  | {
      /**
       * An integration reaching a connected state for the first time — the
       * activation step between signing up and reviewing anything.
       *
       * Distinct from `npm_connection.validated`, which fires on every
       * revalidation and measures ongoing credential *health*. This one fires
       * once per connection and measures *activation*.
       */
      name: "integration.connected";
      organizationId: string;
      /** `npm` | `github` | `slack` */
      kind: string;
      /** Integration-specific state slug (e.g. a GitHub installation status). */
      outcome: string;
    }
  | {
      /** A `deployment_protection_rule` delivery that opened a pending gate. */
      name: "workflow_gate.opened";
      organizationId: string;
    }
  | {
      /** The reviewer's recommendation for a gate, before any human acts on it. */
      name: "workflow_gate.reviewed";
      organizationId: string;
      /** `approve` | `reject` | … — the recommendation, not the outcome. */
      recommendation: string;
      /** `on_time` | `timed_out` — whether the review beat the gate's deadline. */
      timeoutState: string;
      durationMs: number;
      /** Packages in the release bundle; a monorepo gate reviews several. */
      packageCount: number;
    }
  | {
      /**
       * A gate decision reaching GitHub. `surface` separates a maintainer's
       * click from the automatic block, so approval rate stays measurable
       * against reviews rather than being diluted by auto-rejections.
       */
      name: "workflow_gate.decided";
      organizationId: string;
      /** `human` | `automatic` */
      surface: string;
      /** `approved` | `rejected` */
      decision: string;
      packageCount: number;
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
    }
  | {
      /** A document request for one of the anonymous marketing surfaces. */
      name: "marketing_page.viewed";
      surface: MarketingSurface;
      /** Coarse allowlisted channel bucket; never the raw referrer. */
      source: TrafficSource;
    };

/**
 * Every event name, for the privacy test's exhaustiveness check.
 *
 * The two assertions below make this list and the union above check each other
 * at compile time, in both directions. Without that the check degrades into two
 * hand-maintained lists agreeing with each other while the union quietly grows
 * a third arm nobody asserted a privacy shape for — which is exactly what
 * happened to `scan.discarded`.
 */
export const ANALYTICS_EVENT_NAMES = [
  "scan.queued",
  "scan.completed",
  "scan.failed",
  "scan.discarded",
  "scan.decided",
  "ai_review.finished",
  "npm_connection.validated",
  "public_diff.viewed",
  "user.signed_up",
  "organization.created",
  "integration.connected",
  "workflow_gate.opened",
  "workflow_gate.reviewed",
  "workflow_gate.decided",
  "marketing_page.viewed",
] as const;

// A name in the union but missing from the list, or vice versa, fails here.
type AssertExtends<A extends B, B> = A;
type _EveryEventIsListed = AssertExtends<
  AnalyticsEvent["name"],
  (typeof ANALYTICS_EVENT_NAMES)[number]
>;
type _EveryListedNameExists = AssertExtends<
  (typeof ANALYTICS_EVENT_NAMES)[number],
  AnalyticsEvent["name"]
>;

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
    case "scan.discarded":
      return base(
        event.organizationId,
        event.ecosystem,
        [event.source, event.reason],
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
    case "user.signed_up":
      return base("", "", [event.method, event.outcome], [0]);
    case "organization.created":
      return base(event.organizationId, "", [], [0]);
    case "integration.connected":
      return base(event.organizationId, event.kind, [event.outcome], [0]);
    case "workflow_gate.opened":
      return base(event.organizationId, "", [], [0]);
    case "workflow_gate.reviewed":
      return base(
        event.organizationId,
        "",
        [event.recommendation, event.timeoutState],
        [event.durationMs, event.packageCount],
      );
    case "workflow_gate.decided":
      return base(
        event.organizationId,
        "",
        [event.surface, event.decision],
        [0, event.packageCount],
      );
    case "public_diff.viewed":
      return base(
        "",
        event.ecosystem,
        [event.packageName, event.cache, event.risk],
        [event.durationMs],
      );
    case "marketing_page.viewed":
      return base("", "", [event.surface, event.source], [0]);
  }
}
