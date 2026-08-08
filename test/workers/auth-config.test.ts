import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker from "../../server";

const ORIGIN = "http://example.com";

const githubEnv = {
  ...env,
  GITHUB_OAUTH_CLIENT_ID: "Iv1.test-client-id",
  GITHUB_OAUTH_CLIENT_SECRET: "test-client-secret",
};

describe("auth config", () => {
  test("GET /api/auth-config is anonymous and reports github sign-in off by default", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${ORIGIN}/api/auth-config`), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ githubSignIn: false });
  });

  test("GET /api/auth-config reports github sign-in when the credential pair is set", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${ORIGIN}/api/auth-config`), githubEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ githubSignIn: true });
  });

  test("POST /api/auth/sign-in/social starts the GitHub authorize redirect when enabled", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          origin: ORIGIN,
        },
        body: JSON.stringify({ provider: "github", callbackURL: "/dashboard" }),
      }),
      githubEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const data = (await res.json()) as { url?: string; redirect?: boolean };
    expect(data.redirect).toBe(true);
    const url = new URL(data.url ?? "");
    expect(url.hostname).toBe("github.com");
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv1.test-client-id");
    // Identity-only authorization: no repo or org scopes ever.
    expect(url.searchParams.get("scope") ?? "").not.toContain("repo");
  });

  test("POST /api/auth/sign-in/social is rejected when no provider is configured", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          origin: ORIGIN,
        },
        body: JSON.stringify({ provider: "github", callbackURL: "/dashboard" }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
