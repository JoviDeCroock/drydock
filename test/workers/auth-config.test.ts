import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker from "../../server";
import { createAuth } from "../../server/lib/auth";

const ORIGIN = "http://example.com";

const githubEnv = {
  ...env,
  GITHUB_OAUTH_CLIENT_ID: "Ov23li-test-client-id",
  GITHUB_OAUTH_CLIENT_SECRET: "test-client-secret",
};

const githubAppEnv = {
  ...env,
  GITHUB_OAUTH_CLIENT_ID: "Iv23lid3JXi9WSYbS6pn",
  GITHUB_OAUTH_CLIENT_SECRET: "test-client-secret",
};

const legacyGithubAppEnv = {
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
    expect(await res.json()).toMatchObject({ githubSignIn: false });
  });

  test("reports whether email verification can be enforced at all", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/auth/config`),
      { ...env, SEND_EMAIL: { send: async () => undefined } } as Cloudflare.Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(await res.json()).toMatchObject({ emailVerification: true });

    // Without a transport nothing can be verified, so the dashboard must not be
    // told to show a banner no account could ever clear.
    const withoutEmail = createExecutionContext();
    const offRes = await worker.fetch(new Request(`${ORIGIN}/api/auth/config`), env, withoutEmail);
    await waitOnExecutionContext(withoutEmail);
    expect(await offRes.json()).toMatchObject({ emailVerification: false });
  });

  test("GET /api/auth/config reports github sign-in when the credential pair is set", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${ORIGIN}/api/auth/config`), githubEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ githubSignIn: true });
  });

  test("does not offer sign-in through a repository-capable GitHub App", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${ORIGIN}/api/auth/config`), githubAppEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ githubSignIn: false });
  });

  test("also rejects legacy GitHub App client IDs", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/auth/config`),
      legacyGithubAppEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ githubSignIn: false });
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
    expect(url.searchParams.get("client_id")).toBe("Ov23li-test-client-id");
    // The provider defaults are identity-only: profile + verified email.
    expect(url.searchParams.get("scope")).toBe("read:user user:email");
    // The callback operators must whitelist on the OAuth app.
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/github`);
  });

  test("rejects caller-supplied GitHub scopes", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          origin: ORIGIN,
        },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "/dashboard",
          scopes: ["repo"],
        }),
      }),
      githubEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expect.objectContaining({ code: "OAUTH_SCOPES_NOT_ALLOWED" }));
  });

  test("rejects scope overrides through the explicit linking route", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/auth/link-social`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          origin: ORIGIN,
        },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "/dashboard/account",
          scopes: ["repo"],
        }),
      }),
      githubEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expect.objectContaining({ code: "OAUTH_SCOPES_NOT_ALLOWED" }));
  });

  test("social sign-in stores provider tokens encrypted and disables every linking path", async () => {
    const options = (
      createAuth(githubEnv as unknown as Cloudflare.Env) as unknown as {
        options: {
          account?: {
            encryptOAuthTokens?: boolean;
            accountLinking?: { enabled?: boolean; disableImplicitLinking?: boolean };
          };
        };
      }
    ).options;

    // A GitHub access/refresh token would otherwise sit in plain text in every
    // D1 dump and backup.
    expect(options.account?.encryptOAuthTokens).toBe(true);
    // Implicit linking would sign a caller into an existing password account on
    // the OAuth callback, skipping the TOTP challenge that guards /sign-in/email.
    expect(options.account?.accountLinking?.enabled).toBe(false);
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
