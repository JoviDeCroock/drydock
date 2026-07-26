import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import worker from "../../server/index";
import { createDb } from "../../server/db/client";
import { listMarketingReferrals } from "../../server/db/marketing-referrals";

// Campaign attribution is recorded on the document request. These tests pin the
// three properties that matter: it counts the public marketing surfaces, it
// never counts an authenticated route, and it stores nothing that identifies a
// visitor.

function assetsServing(contentType = "text/html"): Fetcher {
  return {
    fetch: async () =>
      new Response("<html><head></head><body></body></html>", {
        headers: { "content-type": contentType },
      }),
  } as unknown as Fetcher;
}

async function visit(
  path: string,
  headers: Record<string, string> = {},
  assets: Fetcher = assetsServing(),
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://drydock.org${path}`, { headers }),
    { ...env, ASSETS: assets } satisfies Cloudflare.Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function referrals() {
  return listMarketingReferrals(createDb(env.DB), { sinceDay: "0000-00-00" });
}

describe("marketing referral attribution", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM marketing_referrals").run();
  });

  test("attributes a diff page view to the referring channel", async () => {
    await visit("/diff/tape/5.7.0/5.7.1", {
      referer: "https://bsky.app/profile/example/post/1",
    });

    const rows = await referrals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ surface: "diff", source: "bluesky", views: 1 });
  });

  test("accumulates repeat views into one row per day and channel", async () => {
    for (let i = 0; i < 3; i++) {
      await visit("/diff/tape/5.7.0/5.7.1", { referer: "https://bsky.app/" });
    }

    const rows = await referrals();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.views).toBe(3);
  });

  test("separates surfaces and channels", async () => {
    await visit("/", { referer: "https://news.ycombinator.com/item?id=1" });
    await visit("/docs", { referer: "https://www.linkedin.com/feed/" });
    await visit("/diff", {});

    const rows = await referrals();
    expect(rows.map((row) => `${row.surface}:${row.source}`).sort()).toEqual([
      "diff_index:direct",
      "docs:linkedin",
      "landing:hackernews",
    ]);
  });

  test("never records authenticated or auth-flow routes", async () => {
    for (const path of ["/dashboard", "/dashboard/settings", "/login", "/register"]) {
      await visit(path, { referer: "https://bsky.app/" });
    }
    expect(await referrals()).toHaveLength(0);
  });

  test("stores no visitor-identifying data", async () => {
    await visit("/diff/tape/5.7.0/5.7.1", {
      referer: "https://bsky.app/profile/someone-identifiable/post/12345",
      "cf-connecting-ip": "203.0.113.7",
      "user-agent": "Mozilla/5.0 (Macintosh) Chrome/126.0",
    });

    const stored = await env.DB.prepare("SELECT * FROM marketing_referrals").all();
    const serialized = JSON.stringify(stored.results);
    expect(serialized).not.toContain("203.0.113.7");
    expect(serialized).not.toContain("someone-identifiable");
    expect(serialized).not.toContain("Mozilla");
    // Only the coarse bucket survives.
    expect(serialized).toContain("bluesky");
  });

  test("honors an explicit utm_source over the referrer", async () => {
    await visit("/diff/tape/5.7.0/5.7.1?utm_source=linkedin", {
      referer: "https://bsky.app/",
    });
    const rows = await referrals();
    expect(rows[0]?.source).toBe("linkedin");
  });

  test("buckets unfurl crawlers separately from human visits", async () => {
    await visit("/diff/tape/5.7.0/5.7.1", { "user-agent": "Twitterbot/1.0" });
    await visit("/diff/tape/5.7.0/5.7.1", { referer: "https://bsky.app/" });

    const rows = await referrals();
    const bySource = Object.fromEntries(rows.map((row) => [row.source, row.views]));
    expect(bySource).toEqual({ bot: 1, bluesky: 1 });
  });

  test("serves the page even when the counter write fails", async () => {
    // Attribution sits directly in the landing-page serving path. A broken
    // counter must degrade to no data, never to a failed page load.
    const ctx = createExecutionContext();
    const brokenDb = {
      ...env,
      DB: {
        prepare() {
          throw new Error("d1 unavailable");
        },
        batch() {
          throw new Error("d1 unavailable");
        },
      } as unknown as D1Database,
      ASSETS: assetsServing(),
    } satisfies Cloudflare.Env;

    const res = await worker.fetch(
      new Request("https://drydock.org/diff/tape/5.7.0/5.7.1", {
        headers: { referer: "https://bsky.app/" },
      }),
      brokenDb,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<html>");
  });

  test("does not record non-document responses", async () => {
    // Asset requests (JS, CSS, images) flow through the same handler; counting
    // them would multiply every page view by its subresource count.
    await visit(
      "/diff/tape/5.7.0/5.7.1",
      { referer: "https://bsky.app/" },
      assetsServing("application/javascript"),
    );
    expect(await referrals()).toHaveLength(0);
  });
});
