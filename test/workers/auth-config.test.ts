import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker from "../../server";
import { createAuth } from "../../server/lib/auth";

const ORIGIN = "http://example.com";

const githubEnv = {
  ...env,
  GITHUB_OAUTH_CLIENT_ID: "Iv1.test-client-id",
  GITHUB_OAUTH_CLIENT_SECRET: "test-client-secret",
};

describe("auth config", () => {
  test("GET /api/auth/config is anonymous and reports github sign-in off by default", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${ORIGIN}/api/auth/config`), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ githubSignIn: false });
  });

  test("GET /api/auth/config reports github sign-in when the credential pair is set", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${ORIGIN}/api/auth/config`), githubEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ githubSignIn: true });
  });

  test("does not leave the old non-auth API path anonymous", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${ORIGIN}/api/auth-config`), githubEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(401);
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
    // Identity-only authorization: profile + verified email, no repo or org
    // scopes ever. Asserted exactly so a scope widening cannot slip through.
    expect(url.searchParams.get("scope")).toBe("read:user user:email");
    // The callback operators must whitelist on the OAuth app.
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/github`);
  });

  test("social sign-in stores provider tokens encrypted and never links implicitly", async () => {
    const options = (
      createAuth(githubEnv as unknown as Cloudflare.Env) as unknown as {
        options: {
          account?: {
            encryptOAuthTokens?: boolean;
            accountLinking?: { disableImplicitLinking?: boolean };
          };
        };
      }
    ).options;

    // A GitHub access/refresh token would otherwise sit in plain text in every
    // D1 dump and backup.
    expect(options.account?.encryptOAuthTokens).toBe(true);
    // Implicit linking would sign a caller into an existing password account on
    // the OAuth callback, skipping the TOTP challenge that guards /sign-in/email.
    expect(options.account?.accountLinking?.disableImplicitLinking).toBe(true);
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
