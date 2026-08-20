import { Hono } from "hono";
import { createDb } from "../db/client";
import { RateLimitError, enforceRateLimit } from "../db/rate-limit";
import { resolveAtpmStagedReview } from "../lib/ecosystems/atpm/staged-review";
import { canonicalOrigin, rateLimitResponse } from "../lib/platform/http";
import { workerExecutionContext } from "../lib/platform/execution-context";
import { PublicDiffError } from "../lib/public-diff/error";
import { recordProductEvent } from "../lib/platform/analytics";
import type { Bindings, Variables } from "../types";

/**
 * `/stage/atpm/<publisher>/<rkey>` — the link atpm's staged dashboard puts next
 * to a candidate, before anyone clicks publish.
 *
 * The contract is that atpm can write this URL from what it already has: the
 * publishing account and the record key of the staged record it just created.
 * No API call, no id exchange, no registration. Everything that needs resolving
 * — which package, which baseline, which revision — happens on this side, and
 * the visitor lands on the ordinary diff page for the result.
 *
 * Anonymous, and that is the point rather than an oversight. A staged candidate
 * is a public record in the publisher's own repository, and the review of it is
 * a deterministic diff of public bytes. Putting a sign-in in front of that would
 * ask a maintainer to open an account with a third party to read something they
 * could already fetch themselves — at precisely the moment they are deciding
 * whether to publish, which is the moment the review is worth anything.
 *
 * Rate-limited per IP like the rest of the anonymous surface. Nothing is
 * persisted, and no session is read or created.
 */
export const atpmStageLinkRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

atpmStageLinkRoutes.get("/atpm/:publisher/:rkey", async (c) => {
  const db = createDb(c.env.DB);
  const ip =
    c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  try {
    await enforceRateLimit(db, {
      key: `public-diff:stage-link:${ip || "unknown"}`,
      limit: 30,
      windowMs: 60 * 1000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) return rateLimitResponse(c, "rate limit exceeded", err);
    throw err;
  }

  try {
    const resolved = await resolveAtpmStagedReview(c.env, workerExecutionContext(c.executionCtx), {
      publisher: c.req.param("publisher"),
      rkey: c.req.param("rkey"),
    });
    recordProductEvent(c.env, {
      name: "atpm_stage_link.resolved",
      ecosystem: "atpm",
      packageName: resolved.packageName,
    });
    // 302 rather than 301: a staged candidate is short-lived and its review URL
    // carries the record's current CID, so this mapping must never be cached by
    // a browser as permanent.
    return c.redirect(new URL(resolved.reviewPath, canonicalOrigin(c)).toString(), 302);
  } catch (err) {
    const status = err instanceof PublicDiffError ? err.status : 502;
    const message =
      err instanceof PublicDiffError ? err.message : "could not read that staged release";
    // A staged record is deleted the moment it is approved, so "not found" is
    // the expected end state of every link here rather than a broken one. Say
    // so, instead of rendering a bare 404.
    return c.html(stagePlaceholder(message, status), status === 404 ? 404 : 502);
  }
});

function stagePlaceholder(message: string, status: number): string {
  const headline =
    status === 404 ? "That staged release is no longer waiting" : "Could not read that release";
  const detail =
    status === 404
      ? "atpm removes a staged record once it is approved or withdrawn, so this link stops resolving as soon as the release is published. If it was published, the release itself can still be diffed."
      : escapeHtml(message);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(headline)} · Drydock</title>
<meta name="robots" content="noindex">
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; padding: 24px; }
  main { max-width: 46ch; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { margin: 0 0 16px; opacity: .75; }
  a { color: inherit; }
</style></head>
<body><main>
  <h1>${escapeHtml(headline)}</h1>
  <p>${detail}</p>
  <p><a href="/diff">Diff a published release</a></p>
</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}
