import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { setSignedCookie } from "hono/cookie";
import { afterEach, describe, expect, test, vi } from "vitest";
import worker from "../../server";
import { recordFirstReviewAcquisition, recordSignupAcquisition } from "../../server/db/acquisition";
import { createDb } from "../../server/db/client";
import { deleteUserAccount } from "../../server/db/organizations";
import { user, userAcquisition } from "../../server/db/schema";
import type { Acquisition } from "../../server/lib/acquisition";
import type { PublicPackageDiff } from "../../server/lib/public-diff";
import { summarizePackageJsonDiff } from "../../server/lib/review/serialize";
import { LANDING_EXPERIMENT, landingHeroCopy } from "../../src/lib/landing-experiment";
import { homePageSeo } from "../../src/lib/seo-metadata";
import { jsonResponse, stubFetchRoutes } from "../helpers/fetch-stub";
import { callWorker, PASSWORD, signUpUserId, type Jar } from "./helpers/auth-http";
import { seedUser } from "./helpers/seed";
import { exhaustedRateLimitBindings } from "./rate-limit-doubles";

const ORIGIN = "http://example.com";
const ASSIGNMENT_PATH = "/api/public/v1/landing-experiment";
const COOKIE_NAME = "drydock_landing";
const DAY_MS = 86_400_000;

interface CapturedPoint {
  indexes: string[];
  blobs: string[];
  doubles: number[];
}

function experimentEnv(enabled = true) {
  const written: CapturedPoint[] = [];
  const flag = vi.fn(async () => enabled);
  const requestEnv = {
    ...env,
    FLAGS: { getBooleanValue: flag },
    PRODUCT_ANALYTICS: { writeDataPoint: (point: CapturedPoint) => written.push(point) },
  } as unknown as Cloudflare.Env;
  return { written, flag, requestEnv };
}

function milestones(written: CapturedPoint[], milestone: string): CapturedPoint[] {
  return written.filter(
    (point) => point.blobs[1] === "acquisition.milestone" && point.blobs[7] === milestone,
  );
}

function acquisition(overrides: Partial<Acquisition> = {}): Acquisition {
  return {
    experiment: LANDING_EXPERIMENT,
    variant: "challenger",
    channel: "github",
    expiresDay: Math.floor(Date.now() / DAY_MS) + 30,
    diffRead: false,
    ...overrides,
  };
}

function responseCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${COOKIE_NAME}=`));
  expect(cookie).toBeDefined();
  return cookie!.split(";")[0];
}

function cookieAcquisition(cookie: string): Acquisition {
  const decoded = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
  return JSON.parse(decoded.slice(0, decoded.lastIndexOf("."))) as Acquisition;
}

async function signedCookie(value: unknown): Promise<string> {
  const app = new Hono();
  app.get("/", async (c) => {
    await setSignedCookie(
      c,
      COOKIE_NAME,
      JSON.stringify(value),
      `${env.BETTER_AUTH_SECRET}:landing-acquisition-v1`,
    );
    return c.text("fixture");
  });
  return responseCookie(await app.request("/"));
}

async function request(
  path: string,
  requestEnv: Cloudflare.Env,
  headers: HeadersInit = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const requestHeaders = new Headers(headers);
  if (!requestHeaders.has("cf-connecting-ip"))
    requestHeaders.set("cf-connecting-ip", `landing-test-${crypto.randomUUID()}`);
  const response = await worker.fetch(
    new Request(new URL(path, ORIGIN), { headers: requestHeaders }),
    requestEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("anonymous landing assignments", () => {
  test("production assignments use a secure cookie", async () => {
    const { requestEnv } = experimentEnv();
    const response = await request(`https://drydock.org${ASSIGNMENT_PATH}`, requestEnv);
    expect(response.headers.get("set-cookie")).toContain("; Secure");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test.each(["off", "unbound", "unavailable", "no dataset", "no signing secret"])(
    "serves control without measurement when the experiment is %s",
    async (state) => {
      const { requestEnv, flag, written } = experimentEnv(state !== "off");
      if (state === "unbound") delete requestEnv.FLAGS;
      if (state === "no dataset") delete requestEnv.PRODUCT_ANALYTICS;
      if (state === "no signing secret") requestEnv.BETTER_AUTH_SECRET = "";
      if (state === "unavailable") {
        flag.mockRejectedValue(new Error("flag unavailable"));
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
      }
      const response = await request(ASSIGNMENT_PATH, requestEnv);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ variant: "control" });
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(written).toHaveLength(0);
    },
  );

  test("keeps the original signed assignment and records only the coarse cohort", async () => {
    const { requestEnv, flag, written } = experimentEnv();
    const privateReferrer = "https://github.com/customer/private-repo?token=personal-secret";
    const response = await request(ASSIGNMENT_PATH, requestEnv, { referer: privateReferrer });
    const cookie = responseCookie(response);
    const cohort = cookieAcquisition(cookie);
    const body = (await response.json()) as { variant: string };
    expect(cohort).toEqual(acquisition({ variant: body.variant as Acquisition["variant"] }));
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(flag).toHaveBeenCalledWith("landing-hero-experiment", false);
    const repeat = await request(ASSIGNMENT_PATH, requestEnv, {
      cookie,
      "x-drydock-acquisition-channel": "search",
    });
    expect(await repeat.json()).toEqual(body);
    expect(repeat.headers.get("set-cookie")).toBeNull();
    expect(milestones(written, "assigned")).toHaveLength(1);
    expect(milestones(written, "assigned")[0].blobs).toEqual([
      "1",
      "acquisition.milestone",
      "",
      "",
      LANDING_EXPERIMENT,
      body.variant,
      "github",
      "assigned",
    ]);
    expect(JSON.stringify(written)).not.toContain(privateReferrer);
    expect(JSON.stringify(written)).not.toContain("personal-secret");
    expect(Object.keys(cohort).sort()).toEqual([
      "channel",
      "diffRead",
      "experiment",
      "expiresDay",
      "variant",
    ]);
  });

  test.each(["direct", "search", "github", "other"])(
    "accepts coarse SPA acquisition channel %s",
    async (channel) => {
      const { requestEnv } = experimentEnv();
      const response = await request(ASSIGNMENT_PATH, requestEnv, {
        "x-drydock-acquisition-channel": channel,
      });
      expect(cookieAcquisition(responseCookie(response)).channel).toBe(channel);
    },
  );

  test("rejects arbitrary channel dimensions", async () => {
    const { requestEnv, written } = experimentEnv();
    const response = await request(ASSIGNMENT_PATH, requestEnv, {
      "x-drydock-acquisition-channel": "someone@example.test",
      referer: "https://attacker.test/private?secret=should-not-be-stored",
    });
    expect(cookieAcquisition(responseCookie(response)).channel).toBe("other");
    expect(JSON.stringify(written)).not.toContain("someone@example.test");
    expect(JSON.stringify(written)).not.toContain("should-not-be-stored");
  });

  test.each(["malformed", "expired", "tampered", "invalid channel", "future expiry"])(
    "replaces a %s cookie instead of trusting it",
    async (state) => {
      let cookie = `${COOKIE_NAME}=broken-json.invalid-signature`;
      if (state === "expired")
        cookie = await signedCookie(acquisition({ expiresDay: Math.floor(Date.now() / DAY_MS) }));
      if (state === "invalid channel")
        cookie = await signedCookie({ ...acquisition(), channel: "user@example.test" });
      if (state === "future expiry")
        cookie = await signedCookie(
          acquisition({ expiresDay: Math.floor(Date.now() / DAY_MS) + 31 }),
        );
      if (state === "tampered")
        cookie = (await signedCookie(acquisition())).replace("github", "search");
      const { requestEnv, written } = experimentEnv();
      const response = await request(ASSIGNMENT_PATH, requestEnv, { cookie });
      expect(cookieAcquisition(responseCookie(response)).channel).toBe("direct");
      expect(milestones(written, "assigned")).toHaveLength(1);
    },
  );

  test("blocks cross-site calls and exhausted rate limits before assignment", async () => {
    const { requestEnv, flag, written } = experimentEnv();
    const crossSite = await request(ASSIGNMENT_PATH, requestEnv, {
      "sec-fetch-site": "cross-site",
    });
    expect(crossSite.status).toBe(403);
    const { overrides, limiter } = exhaustedRateLimitBindings();
    const limited = await request(ASSIGNMENT_PATH, { ...requestEnv, ...overrides });
    expect(limited.status).toBe(429);
    expect(limiter.keys).toHaveLength(1);
    expect(flag).not.toHaveBeenCalled();
    expect(written).toHaveLength(0);
    expect(crossSite.headers.get("set-cookie")).toBeNull();
    expect(limited.headers.get("set-cookie")).toBeNull();
  });

  test.each<HeadersInit>([
    { "user-agent": "Googlebot" },
    { "sec-purpose": "prefetch" },
    { cookie: "spr.session_token=signed-in" },
    { cookie: "__Secure-spr.session_token=signed-in" },
  ])("does not enroll bots, prefetches, or signed-in visitors: %j", async (headers) => {
    const { requestEnv, written } = experimentEnv();
    const response = await request(ASSIGNMENT_PATH, requestEnv, headers);
    expect(await response.json()).toEqual({ variant: "control" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(written).toHaveLength(0);
  });
});

describe("homepage and public diff attribution", () => {
  test("a first homepage visit receives the same cohort cookie and hydration variant", async () => {
    const { requestEnv, written } = experimentEnv();
    requestEnv.ASSETS = {
      fetch: async () =>
        new Response(
          '<div id="app"><h1 id="landing-hero-title">Control</h1><p id="landing-hero-description">Control</p><a id="landing-diff-action">Control</a></div>',
          {
            headers: { "content-type": "text/html", "cache-control": "public, max-age=3600" },
          },
        ),
    } as unknown as Fetcher;
    const response = await request("https://drydock.org/", requestEnv, {
      referer: "https://www.google.com/search?q=package-diff",
    });
    const cohort = cookieAcquisition(responseCookie(response));
    const html = await response.text();
    expect(cohort.channel).toBe("search");
    expect(html).toContain(`data-landing-variant="${cohort.variant}"`);
    expect(html).toContain(landingHeroCopy[cohort.variant].title);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("set-cookie")).toContain("; Secure");
    expect(milestones(written, "assigned")).toHaveLength(1);
  });

  test.each(["control", "challenger"] as const)(
    "rewrites the %s hero and hydration marker without shared caching",
    async (variant) => {
      const { requestEnv, written } = experimentEnv();
      const cookie = await signedCookie(acquisition({ variant }));
      const html =
        '<!doctype html><html><head><title>Original</title><meta name="description" content="Original"><meta property="og:title" content="Original"><meta property="og:description" content="Original"><meta name="twitter:title" content="Original"><meta name="twitter:description" content="Original"></head><body><div id="app"><h1 id="landing-hero-title">Original</h1><p id="landing-hero-description">Original</p><a id="landing-diff-action" href="/diff">Original</a></div></body></html>';
      requestEnv.ASSETS = {
        fetch: async () =>
          new Response(html, {
            headers: { "content-type": "text/html", "cache-control": "public, max-age=3600" },
          }),
      } as unknown as Fetcher;
      const response = await request("/", requestEnv, { cookie });
      const rewritten = await response.text();
      const copy = landingHeroCopy[variant];
      expect(rewritten).toContain(`data-landing-variant="${variant}"`);
      expect(rewritten).toContain(`<h1 id="landing-hero-title">${copy.title}</h1>`);
      expect(rewritten).toContain(copy.description);
      const description = variant === "control" ? homePageSeo.description : copy.description;
      expect(rewritten).toContain(`name="description" content="${description}"`);
      expect(rewritten).toContain(`property="og:description" content="${description}"`);
      expect(rewritten).toContain(`name="twitter:description" content="${description}"`);
      expect(rewritten).toContain(`href="/diff">${copy.action}</a>`);
      expect(rewritten).not.toContain("Original");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(written).toHaveLength(0);
    },
  );

  test("counts a successful pair once and never counts file reads or invalid pairs", async () => {
    const { requestEnv, written } = experimentEnv();
    const cookie = await signedCookie(acquisition());
    const packageName = `landing-diff-${crypto.randomUUID()}`;
    const payload: PublicPackageDiff = {
      ecosystem: "npm",
      packageName,
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
      fromPackageJson: null,
      toPackageJson: null,
      fromFiles: [],
      toFiles: [{ path: "index.js", size: 1, sha256: "a", flags: [], textSample: "x" }],
      diff: [{ path: "index.js", status: "added", flags: [] }],
      packageJsonDiff: summarizePackageJsonDiff(null, null),
      findings: [],
      risk: {
        artifactRisk: "low",
        releaseRisk: "low",
        contextRisk: "low",
        releaseFindingCount: 0,
        contextFindingCount: 0,
        unknownFindingCount: 0,
        priorApprovedContextFindingCount: 0,
      },
      cachedAt: new Date().toISOString(),
    };
    requestEnv.COMPARE_CACHE = { get: async () => payload } as unknown as KVNamespace;
    const query = `?package=${packageName}&from=1.0.0&to=1.0.1`;
    const file = await request(
      `/api/public/v1/package-diff/file${query}&path=index.js`,
      requestEnv,
      { cookie },
    );
    expect(file.status).toBe(200);
    expect(milestones(written, "diff_read")).toHaveLength(0);
    expect(file.headers.get("set-cookie")).toBeNull();
    const invalid = await request("/api/public/v1/package-diff?package=left-pad", requestEnv, {
      cookie,
    });
    expect(invalid.status).toBe(400);
    expect(milestones(written, "diff_read")).toHaveLength(0);
    const pair = await request(`/api/public/v1/package-diff${query}`, requestEnv, { cookie });
    expect(pair.status).toBe(200);
    expect(pair.headers.get("cache-control")).toBe("private, no-store");
    const updated = responseCookie(pair);
    expect(cookieAcquisition(updated)).toEqual(acquisition({ diffRead: true }));
    const repeat = await request(`/api/public/v1/package-diff${query}`, requestEnv, {
      cookie: updated,
    });
    expect(repeat.status).toBe(200);
    expect(repeat.headers.get("set-cookie")).toBeNull();
    expect(milestones(written, "diff_read")).toHaveLength(1);
    expect(JSON.stringify(milestones(written, "diff_read"))).not.toContain(packageName);
  });
});

describe("signup and workspace activation attribution", () => {
  test.each(["disabled", "expired"])(
    "does not attribute signup when the cohort is %s",
    async (state) => {
      const { requestEnv, written } = experimentEnv(state !== "disabled");
      const cookie = await signedCookie(
        acquisition(state === "expired" ? { expiresDay: Math.floor(Date.now() / DAY_MS) } : {}),
      );
      const jar: Jar = new Map([[COOKIE_NAME, cookie.slice(cookie.indexOf("=") + 1)]]);
      const userId = await signUpUserId(jar, { env: requestEnv });
      expect(
        await createDb(env.DB)
          .select()
          .from(userAcquisition)
          .where(eq(userAcquisition.userId, userId)),
      ).toEqual([]);
      expect(milestones(written, "signed_up")).toHaveLength(0);
    },
  );

  test("duplicate signup attribution preserves the original cohort and emits once", async () => {
    const { requestEnv, written } = experimentEnv();
    const owner = await seedUser();
    await recordSignupAcquisition(owner.db, requestEnv, owner.userId, acquisition());
    await recordSignupAcquisition(
      owner.db,
      requestEnv,
      owner.userId,
      acquisition({ variant: "control", channel: "other" }),
    );
    const [saved] = await owner.db
      .select()
      .from(userAcquisition)
      .where(eq(userAcquisition.userId, owner.userId));
    expect(saved).toMatchObject({ variant: "challenger", channel: "github" });
    expect(milestones(written, "signed_up")).toHaveLength(1);
  });

  test("the email signup hook persists the cohort and sign-in cannot overwrite it", async () => {
    const { requestEnv, written } = experimentEnv();
    const original = acquisition({ channel: "search" });
    const cookie = await signedCookie(original);
    const jar: Jar = new Map([[COOKIE_NAME, cookie.slice(cookie.indexOf("=") + 1)]]);
    const email = `landing-email-${crypto.randomUUID()}@example.test`;
    const userId = await signUpUserId(jar, { email, env: requestEnv });
    const db = createDb(env.DB);
    const [saved] = await db
      .select()
      .from(userAcquisition)
      .where(eq(userAcquisition.userId, userId));
    expect(saved).toMatchObject({
      userId,
      experiment: LANDING_EXPERIMENT,
      variant: "challenger",
      channel: "search",
      firstReviewAt: null,
    });
    expect(saved.expiresAt.getTime()).toBe(original.expiresDay * DAY_MS);
    const replacement = await signedCookie(acquisition({ variant: "control", channel: "github" }));
    const signInJar: Jar = new Map([
      [COOKIE_NAME, replacement.slice(replacement.indexOf("=") + 1)],
    ]);
    const signIn = await callWorker("POST", "/api/auth/sign-in/email", {
      env: requestEnv,
      jar: signInJar,
      body: { email, password: PASSWORD },
    });
    expect(signIn.res.status).toBe(200);
    expect(
      await db.select().from(userAcquisition).where(eq(userAcquisition.userId, userId)),
    ).toEqual([saved]);
    expect(milestones(written, "signed_up")).toHaveLength(1);
    expect(JSON.stringify(written)).not.toContain(userId);
    expect(JSON.stringify(written)).not.toContain(email);
    const deleted = await callWorker("POST", "/api/auth/delete-user", {
      env: requestEnv,
      jar: signInJar,
      body: { password: PASSWORD },
    });
    expect(deleted.res.status).toBe(200);
    expect(
      await db.select().from(userAcquisition).where(eq(userAcquisition.userId, userId)),
    ).toEqual([]);
  });

  test.each([true, false])(
    "the real GitHub OAuth creation hook preserves attribution for verified=%s",
    async (verified) => {
      const { requestEnv, written } = experimentEnv();
      requestEnv.GITHUB_OAUTH_CLIENT_ID = "Ov23li-landing-test";
      requestEnv.GITHUB_OAUTH_CLIENT_SECRET = "oauth-test-secret";
      const email = `landing-github-${crypto.randomUUID()}@example.test`;
      stubFetchRoutes({
        "github.com/login/oauth/access_token": () =>
          jsonResponse({
            access_token: "oauth-fixture-token",
            token_type: "bearer",
            scope: "read:user,user:email",
          }),
        "api.github.com/user/emails": () => jsonResponse([{ email, primary: true, verified }]),
        "api.github.com/user": () =>
          jsonResponse({
            id: crypto.randomUUID(),
            login: "landing-tester",
            name: "Landing Tester",
            email,
            avatar_url: null,
          }),
      });
      const cookie = await signedCookie(acquisition());
      const jar: Jar = new Map([[COOKIE_NAME, cookie.slice(cookie.indexOf("=") + 1)]]);
      const started = await callWorker("POST", "/api/auth/sign-in/social", {
        env: requestEnv,
        jar,
        body: { provider: "github", callbackURL: "/dashboard" },
      });
      expect(started.res.status).toBe(200);
      const state = new URL(String(started.json?.url)).searchParams.get("state");
      expect(state).toBeTruthy();
      const callback = await callWorker(
        "GET",
        `/api/auth/callback/github?code=fixture-code&state=${encodeURIComponent(state!)}`,
        { env: requestEnv, jar },
      );
      expect(callback.res.status).toBe(302);
      expect(new URL(callback.res.headers.get("location")!, ORIGIN).href).toBe(
        `${ORIGIN}/dashboard`,
      );
      const session = await callWorker("GET", "/api/auth/get-session", { env: requestEnv, jar });
      const userId = (session.json?.user as { id?: string } | undefined)?.id;
      expect(userId).toBeDefined();
      const [saved] = await createDb(env.DB)
        .select()
        .from(userAcquisition)
        .where(eq(userAcquisition.userId, userId!));
      expect(saved).toMatchObject({
        userId,
        experiment: LANDING_EXPERIMENT,
        variant: "challenger",
        channel: "github",
      });
      expect(milestones(written, "signed_up")).toHaveLength(1);
      expect(JSON.stringify(written)).not.toContain(userId);
      expect(JSON.stringify(written)).not.toContain(email);
    },
  );

  test("concurrent reviews activate the workspace owner once and account deletion removes its attribution", async () => {
    const { requestEnv, written } = experimentEnv();
    const owner = await seedUser();
    const member = await seedUser();
    await recordSignupAcquisition(owner.db, requestEnv, owner.userId, acquisition());
    await recordSignupAcquisition(
      member.db,
      requestEnv,
      member.userId,
      acquisition({ variant: "control" }),
    );
    await Promise.all(
      Array.from({ length: 3 }, () =>
        recordFirstReviewAcquisition(owner.db, requestEnv, owner.organizationId),
      ),
    );
    const rows = await owner.db.select().from(userAcquisition);
    expect(rows.find((row) => row.userId === owner.userId)?.firstReviewAt).toBeInstanceOf(Date);
    expect(rows.find((row) => row.userId === member.userId)?.firstReviewAt).toBeNull();
    expect(milestones(written, "first_review")).toHaveLength(1);
    expect(milestones(written, "first_review")[0].blobs[5]).toBe("challenger");
    // Better Auth performs the user-row deletion after its beforeDelete cleanup hook.
    await deleteUserAccount(owner.db, owner.userId);
    await owner.db.delete(user).where(eq(user.id, owner.userId));
    expect(
      await owner.db.select().from(userAcquisition).where(eq(userAcquisition.userId, owner.userId)),
    ).toEqual([]);
  });

  test("expired cohorts and missing organizations do not activate", async () => {
    const { requestEnv, written } = experimentEnv();
    const owner = await seedUser();
    await recordSignupAcquisition(
      owner.db,
      requestEnv,
      owner.userId,
      acquisition({ expiresDay: Math.floor(Date.now() / DAY_MS) }),
    );
    await recordFirstReviewAcquisition(owner.db, requestEnv, owner.organizationId);
    await recordFirstReviewAcquisition(owner.db, requestEnv, "missing-workspace");
    const [saved] = await owner.db
      .select()
      .from(userAcquisition)
      .where(eq(userAcquisition.userId, owner.userId));
    expect(saved.firstReviewAt).toBeNull();
    expect(milestones(written, "first_review")).toHaveLength(0);
  });
});
