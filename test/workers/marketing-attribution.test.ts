import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import worker from "../../server/index";

// Campaign attribution is recorded on the document request. These tests pin the
// three properties that matter: it counts the public marketing surfaces, it
// never counts an authenticated route, and it sends nothing that identifies a
// visitor to Analytics Engine.

const BLOB = { name: 1, organizationId: 2, ecosystem: 3, surface: 4, source: 5 } as const;

interface CapturedPoint {
  indexes: string[];
  blobs: string[];
  doubles: number[];
}

let written: CapturedPoint[];

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

function marketingViews(): CapturedPoint[] {
  return written.filter((point) => point.blobs[BLOB.name] === "marketing_page.viewed");
}

describe("marketing attribution", () => {
  beforeEach(() => {
    written = [];
    (env as { PRODUCT_ANALYTICS?: unknown }).PRODUCT_ANALYTICS = {
      writeDataPoint: (point: CapturedPoint) => written.push(point),
    };
  });

  afterEach(() => {
    delete (env as { PRODUCT_ANALYTICS?: unknown }).PRODUCT_ANALYTICS;
    vi.restoreAllMocks();
  });

  test("attributes a diff page view to the referring channel", async () => {
    await visit("/diff/tape/5.7.0/5.7.1", {
      referer: "https://bsky.app/profile/example/post/1",
    });

    const views = marketingViews();
    expect(views).toHaveLength(1);
    expect(views[0]?.blobs[BLOB.surface]).toBe("diff");
    expect(views[0]?.blobs[BLOB.source]).toBe("bluesky");
  });

  test("records repeat views as independent analytics points", async () => {
    for (let i = 0; i < 3; i++) {
      await visit("/diff/tape/5.7.0/5.7.1", { referer: "https://bsky.app/" });
    }

    expect(marketingViews()).toHaveLength(3);
  });

  test("separates surfaces and channels", async () => {
    await visit("/", { referer: "https://news.ycombinator.com/item?id=1" });
    await visit("/docs", { referer: "https://www.linkedin.com/feed/" });
    await visit("/diff", {});

    expect(
      marketingViews()
        .map((point) => `${point.blobs[BLOB.surface]}:${point.blobs[BLOB.source]}`)
        .sort(),
    ).toEqual(["diff_index:direct", "docs:linkedin", "landing:hackernews"]);
  });

  test("never records authenticated or auth-flow routes", async () => {
    for (const path of ["/dashboard", "/dashboard/settings", "/login", "/register"]) {
      await visit(path, { referer: "https://bsky.app/" });
    }
    expect(marketingViews()).toHaveLength(0);
  });

  test("stores no visitor-identifying data", async () => {
    await visit("/diff/tape/5.7.0/5.7.1", {
      referer: "https://bsky.app/profile/someone-identifiable/post/12345",
      "cf-connecting-ip": "203.0.113.7",
      "user-agent": "Mozilla/5.0 (Macintosh) Chrome/126.0",
    });

    const views = marketingViews();
    expect(views).toHaveLength(1);
    const serialized = JSON.stringify(views);
    expect(serialized).not.toContain("203.0.113.7");
    expect(serialized).not.toContain("someone-identifiable");
    expect(serialized).not.toContain("Mozilla");
    expect(views[0]?.blobs[BLOB.organizationId]).toBe("");
    expect(views[0]?.blobs[BLOB.ecosystem]).toBe("");
    // Only the coarse channel bucket survives.
    expect(serialized).toContain("bluesky");
  });

  test("honors an explicit utm_source over the referrer", async () => {
    await visit("/diff/tape/5.7.0/5.7.1?utm_source=linkedin", {
      referer: "https://bsky.app/",
    });
    expect(marketingViews()[0]?.blobs[BLOB.source]).toBe("linkedin");
  });

  test("buckets unfurl crawlers separately from human visits", async () => {
    await visit("/diff/tape/5.7.0/5.7.1", { "user-agent": "Twitterbot/1.0" });
    await visit("/diff/tape/5.7.0/5.7.1", { referer: "https://bsky.app/" });

    expect(marketingViews().map((point) => point.blobs[BLOB.source])).toEqual(["bot", "bluesky"]);
  });

  test("serves the page even when the analytics write fails", async () => {
    // Attribution sits directly in the landing-page serving path. A broken
    // dataset must degrade to no data, never to a failed page load.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    (env as { PRODUCT_ANALYTICS?: unknown }).PRODUCT_ANALYTICS = {
      writeDataPoint() {
        throw new Error("dataset unavailable");
      },
    };

    const res = await visit("/diff/tape/5.7.0/5.7.1", {
      referer: "https://bsky.app/",
    });

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
    expect(marketingViews()).toHaveLength(0);
  });
});
