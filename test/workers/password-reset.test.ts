import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker from "../../server";
import {
  callWorker,
  captureEmail,
  type Jar,
  makeGithubOnly,
  PASSWORD,
  signUpUserId,
  totpFor,
  type SentEmail,
} from "./helpers/auth-http";

const NEW_PASSWORD = "a brand new long passphrase";
const AUTH_TIMEOUT_MS = 30_000;

function uniqueEmail(): string {
  return `reset-${crypto.randomUUID()}@example.test`;
}

function resetTokenFrom(message: SentEmail | undefined): string {
  const match = /\/reset-password#token=([^\s"<&]+)/.exec(message?.raw ?? "");
  expect(match, "reset link in the mailed body").not.toBeNull();
  return decodeURIComponent(match![1]!);
}

async function countRows(sql: string, ...binds: string[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function emailVerified(userId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT email_verified AS v FROM user WHERE id = ?")
    .bind(userId)
    .first<{ v: number }>();
  return row?.v === 1;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomIp(): string {
  return `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
}

async function providerIds(userId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT provider_id FROM account WHERE user_id = ? ORDER BY provider_id",
  )
    .bind(userId)
    .all<{ provider_id: string }>();
  return results.map((row) => row.provider_id);
}

describe("password reset request", () => {
  test(
    "answers an unknown address exactly like a known one and mails only the known one",
    { timeout: AUTH_TIMEOUT_MS },
    async () => {
      const email = uniqueEmail();
      await signUpUserId(new Map(), { email });
      const mail = captureEmail();

      const unknown = await callWorker("POST", "/api/auth/request-password-reset", {
        body: { email: uniqueEmail() },
        env: mail.env,
      });
      expect(unknown.res.status).toBe(200);
      expect(mail.sent).toHaveLength(0);

      const known = await callWorker("POST", "/api/auth/request-password-reset", {
        body: { email },
        env: mail.env,
      });
      expect(known.res.status).toBe(200);
      expect(known.json).toEqual(unknown.json);
      expect(known.json?.message).not.toContain(email);

      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0]?.to).toBe(email);
      // Built from BETTER_AUTH_URL, with the token in the fragment rather than
      // a path or query a request log would keep.
      expect(mail.sent[0]?.raw).toContain(`${env.BETTER_AUTH_URL}/reset-password#token=`);
      expect(mail.sent[0]?.raw).not.toContain("/api/auth/reset-password/");
      expect(resetTokenFrom(mail.sent[0]).length).toBeGreaterThanOrEqual(24);
    },
  );

  test(
    "carries a sanitized returnTo through the mailed link",
    { timeout: AUTH_TIMEOUT_MS },
    async () => {
      const mail = captureEmail();
      // A fresh address each time keeps the per-address mail budget out of it.
      const request = async (redirectTo: string) => {
        const email = uniqueEmail();
        await signUpUserId(new Map(), { email });
        return callWorker("POST", "/api/auth/request-password-reset", {
          body: { email, redirectTo },
          env: mail.env,
          ip: randomIp(),
        });
      };

      expect(
        (await request("/reset-password?returnTo=%2Fdiff%2Freact%2F19.0.0%3Fpath%3Dsrc")).res
          .status,
      ).toBe(200);
      // Same-origin pages Better Auth accepts, but whose destination the server
      // will not mail: a capability, another page's returnTo, a non-app path.
      for (const redirectTo of [
        `/reset-password?returnTo=${encodeURIComponent("/dashboard/invite?token=invite-secret")}`,
        "/login?returnTo=%2Fdiff%2Freact",
        "/reset-password?returnTo=%2Freports%2Fshare-token",
        `${env.BETTER_AUTH_URL}/reset-password?returnTo=%2F%2Fevil.example%2Fdiff`,
      ]) {
        expect((await request(redirectTo)).res.status, redirectTo).toBe(200);
      }

      const links = mail.sent.map(
        (message) => /\/reset-password(\?[^\s"<#]*)?#token=/.exec(message.raw)?.[1] ?? "",
      );
      expect(links).toEqual(["?returnTo=%2Fdiff%2Freact%2F19.0.0%3Fpath%3Dsrc", "", "", "", ""]);
      for (const message of mail.sent) {
        expect(message.raw).not.toContain("invite-secret");
        expect(message.raw).not.toContain("share-token");
        expect(message.raw).not.toContain("evil.example");
      }
    },
  );

  test(
    "refuses an off-origin redirect before looking the address up",
    { timeout: AUTH_TIMEOUT_MS },
    async () => {
      const email = uniqueEmail();
      await signUpUserId(new Map(), { email });
      const mail = captureEmail();
      const redirectTo = "https://evil.example/reset-password?returnTo=%2Fdiff%2Freact";

      const known = await callWorker("POST", "/api/auth/request-password-reset", {
        body: { email, redirectTo },
        env: mail.env,
        ip: randomIp(),
      });
      const unknown = await callWorker("POST", "/api/auth/request-password-reset", {
        body: { email: uniqueEmail(), redirectTo },
        env: mail.env,
        ip: randomIp(),
      });

      expect(known.res.status).toBe(403);
      expect(unknown.res.status).toBe(403);
      expect(known.json).toEqual(unknown.json);
      expect(mail.sent).toHaveLength(0);
    },
  );

  test("stores only a digest of the reset token", { timeout: AUTH_TIMEOUT_MS }, async () => {
    const email = uniqueEmail();
    const userId = await signUpUserId(new Map(), { email });
    const mail = captureEmail();

    await callWorker("POST", "/api/auth/request-password-reset", {
      body: { email },
      env: mail.env,
    });
    const token = resetTokenFrom(mail.sent[0]);

    expect(await countRows("SELECT count(*) AS n FROM verification WHERE value = ?", userId)).toBe(
      1,
    );
    expect(
      await countRows(
        "SELECT count(*) AS n FROM verification WHERE instr(identifier, ?) > 0",
        token,
      ),
    ).toBe(0);
  });

  test(
    "mails nothing and records nothing when the deployment cannot send email",
    { timeout: AUTH_TIMEOUT_MS },
    async () => {
      const email = uniqueEmail();
      const userId = await signUpUserId(new Map(), { email });

      const known = await callWorker("POST", "/api/auth/request-password-reset", {
        body: { email },
      });
      const unknown = await callWorker("POST", "/api/auth/request-password-reset", {
        body: { email: uniqueEmail() },
      });

      // The refusal comes before any lookup, so it is the same for every address.
      expect(known.res.status).toBe(400);
      expect(known.json?.code).toBe("RESET_PASSWORD_DISABLED");
      expect(unknown.json).toEqual(known.json);
      expect(
        await countRows("SELECT count(*) AS n FROM verification WHERE value = ?", userId),
      ).toBe(0);
    },
  );

  test("meters requesting and redeeming per IP in separate budgets", async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
    const mail = captureEmail();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const { res } = await callWorker("POST", "/api/auth/request-password-reset", {
        body: { email: uniqueEmail() },
        env: mail.env,
        ip,
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5).every((status) => status === 200)).toBe(true);
    expect(statuses[5]).toBe(429);

    // Spending the request budget does not lock the same address out of a link.
    const redeem = await callWorker("POST", "/api/auth/reset-password", {
      body: { token: "not-a-token", newPassword: NEW_PASSWORD },
      ip,
    });
    expect(redeem.res.status).toBe(400);
    expect(redeem.json?.code).toBe("INVALID_TOKEN");
  });

  test(
    "mails the stored address when the request spells it in another case",
    { timeout: AUTH_TIMEOUT_MS },
    async () => {
      const email = uniqueEmail();
      await signUpUserId(new Map(), { email });
      const mail = captureEmail();

      const res = await callWorker("POST", "/api/auth/request-password-reset", {
        body: { email: `R${email.slice(1, email.indexOf("@"))}@Example.TEST` },
        env: mail.env,
      });
      expect(res.res.status).toBe(200);
      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0]?.to).toBe(email);
    },
  );

  test(
    "stops mailing one address after three links an hour, whichever IPs ask, without saying so",
    { timeout: AUTH_TIMEOUT_MS },
    async () => {
      const email = uniqueEmail();
      await signUpUserId(new Map(), { email });
      const other = uniqueEmail();
      await signUpUserId(new Map(), { email: other });
      const mail = captureEmail();

      const unknown = await callWorker("POST", "/api/auth/request-password-reset", {
        body: { email: uniqueEmail() },
        env: mail.env,
        ip: randomIp(),
      });
      const responses = [];
      for (let i = 0; i < 5; i++) {
        responses.push(
          await callWorker("POST", "/api/auth/request-password-reset", {
            // A case change must not buy a fresh budget.
            body: { email: i % 2 ? email.toUpperCase() : email },
            env: mail.env,
            ip: `198.18.${i}.${Math.floor(Math.random() * 250) + 1}`,
          }),
        );
      }
      // Over budget answers exactly like an accepted (or unknown) address.
      for (const { res, json } of responses) {
        expect(res.status).toBe(unknown.res.status);
        expect(json).toEqual(unknown.json);
      }
      expect(mail.sent.map((message) => message.to)).toEqual([email, email, email]);

      const unaffected = await callWorker("POST", "/api/auth/request-password-reset", {
        body: { email: other },
        env: mail.env,
        ip: randomIp(),
      });
      expect(unaffected.res.status).toBe(200);
      expect(mail.sent.at(-1)?.to).toBe(other);

      // The budget's row is keyed on a digest; the address itself is never stored.
      const { results } = await env.DB.prepare(
        "SELECT key FROM rate_limits WHERE key LIKE 'auth:password-reset-address:%'",
      ).all<{ key: string }>();
      const keys = results.map((row) => row.key);
      expect(keys.some((key) => key.includes(email) || key.includes(other))).toBe(false);
      const digest = await sha256Hex(email);
      expect(keys.some((key) => key.startsWith(`auth:password-reset-address:${digest}:`))).toBe(
        true,
      );
    },
  );

  test(
    "builds the link from BETTER_AUTH_URL even when the request names another host",
    { timeout: AUTH_TIMEOUT_MS },
    async () => {
      const email = uniqueEmail();
      await signUpUserId(new Map(), { email });
      const mail = captureEmail();
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request("http://attacker.example/api/auth/request-password-reset", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://example.com",
            host: "attacker.example",
            "x-forwarded-host": "attacker.example",
          },
          body: JSON.stringify({ email }),
        }),
        mail.env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0]?.raw).toContain(`${env.BETTER_AUTH_URL}/reset-password#token=`);
      expect(mail.sent[0]?.raw).not.toContain("attacker.example");
    },
  );
});

describe("a first password for a GitHub-only account", () => {
  test(
    "is mailed only to a request signed in as that account",
    { timeout: AUTH_TIMEOUT_MS },
    async () => {
      const email = uniqueEmail();
      const jar: Jar = new Map();
      const userId = await signUpUserId(jar, { email });
      await makeGithubOnly(userId);
      const someoneElse: Jar = new Map();
      await signUpUserId(someoneElse, { email: uniqueEmail() });
      const mail = captureEmail();

      // Whoever can read the inbox must not be able to add a password that
      // skips the GitHub sign-in's own second factor.
      const anonymous = await callWorker("POST", "/api/auth/request-password-reset", {
        body: { email },
        env: mail.env,
      });
      const foreign = await callWorker("POST", "/api/auth/request-password-reset", {
        body: { email },
        env: mail.env,
        jar: someoneElse,
      });
      const unknown = await callWorker("POST", "/api/auth/request-password-reset", {
        body: { email: uniqueEmail() },
        env: mail.env,
      });
      expect(anonymous.res.status).toBe(200);
      expect(foreign.res.status).toBe(200);
      expect(anonymous.json).toEqual(unknown.json);
      expect(foreign.json).toEqual(unknown.json);
      expect(mail.sent).toHaveLength(0);

      const own = await callWorker("POST", "/api/auth/request-password-reset", {
        body: { email },
        env: mail.env,
        jar,
      });
      expect(own.json).toEqual(unknown.json);
      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0]?.to).toBe(email);
      expect(await providerIds(userId)).toEqual(["github"]);
    },
  );

  test(
    "is not mailed to an address the account never verified, even from its own session",
    { timeout: AUTH_TIMEOUT_MS },
    async () => {
      const email = uniqueEmail();
      const jar: Jar = new Map();
      const userId = await signUpUserId(jar, { email });
      await makeGithubOnly(userId, { emailVerified: false });
      const mail = captureEmail();

      // GitHub reported the address unverified, so reading that inbox is no
      // proof of owning the account, and the password would outlive the session.
      const own = await callWorker("POST", "/api/auth/request-password-reset", {
        body: { email },
        env: mail.env,
        jar,
      });
      const unknown = await callWorker("POST", "/api/auth/request-password-reset", {
        body: { email: uniqueEmail() },
        env: mail.env,
      });
      expect(own.res.status).toBe(200);
      expect(own.json).toEqual(unknown.json);
      expect(mail.sent).toHaveLength(0);
      expect(await providerIds(userId)).toEqual(["github"]);
    },
  );
});

describe("password reset completion", () => {
  test(
    "gives a GitHub-only account a password, signs out its sessions, and unblocks two-factor",
    { timeout: AUTH_TIMEOUT_MS },
    async () => {
      const email = uniqueEmail();
      const jar: Jar = new Map();
      const userId = await signUpUserId(jar, { email });
      await makeGithubOnly(userId);

      // The gap being closed: with no credential row there is no password for
      // the two-factor endpoints to check.
      const blocked = await callWorker("POST", "/api/auth/two-factor/enable", {
        body: { password: PASSWORD },
        jar,
      });
      expect(blocked.res.status).toBe(400);

      const mail = captureEmail();
      await callWorker("POST", "/api/auth/request-password-reset", {
        body: { email },
        env: mail.env,
        jar,
      });
      const token = resetTokenFrom(mail.sent[0]);

      const reset = await callWorker("POST", "/api/auth/reset-password", {
        body: { token, newPassword: NEW_PASSWORD },
        env: mail.env,
      });
      expect(reset.res.status).toBe(200);
      expect(await providerIds(userId)).toEqual(["credential", "github"]);
      // The owner hears about it, and the notice carries no link.
      expect(mail.sent).toHaveLength(2);
      expect(mail.sent[1]?.to).toBe(email);
      expect(mail.sent[1]?.raw).toContain("Your Drydock password was set");
      expect(mail.sent[1]?.raw).not.toContain("reset-password");

      // Every session minted before the reset is gone from D1 and KV. The
      // signed cookie cache is bypassed here because it is the documented,
      // bounded revocation lag rather than a session store.
      expect(await countRows("SELECT count(*) AS n FROM session WHERE user_id = ?", userId)).toBe(
        0,
      );
      const stale = await callWorker("GET", "/api/auth/get-session?disableCookieCache=true", {
        jar,
      });
      expect(stale.json?.user ?? null).toBeNull();

      const fresh: Jar = new Map();
      const signIn = await callWorker("POST", "/api/auth/sign-in/email", {
        body: { email, password: NEW_PASSWORD },
        jar: fresh,
      });
      expect(signIn.res.status).toBe(200);

      const enable = await callWorker("POST", "/api/auth/two-factor/enable", {
        body: { password: NEW_PASSWORD },
        jar: fresh,
      });
      expect(enable.res.status).toBe(200);
      const totpURI = enable.json?.totpURI as string;
      const verify = await callWorker("POST", "/api/auth/two-factor/verify-totp", {
        body: { code: totpFor(totpURI) },
        jar: fresh,
      });
      expect(verify.res.status).toBe(200);
      const session = await callWorker("GET", "/api/auth/get-session", { jar: fresh });
      expect((session.json?.user as { twoFactorEnabled?: boolean })?.twoFactorEnabled).toBe(true);
    },
  );

  test(
    "replaces an existing password and redeems each link once",
    { timeout: AUTH_TIMEOUT_MS },
    async () => {
      const email = uniqueEmail();
      const userId = await signUpUserId(new Map(), { email });
      const mail = captureEmail();
      await callWorker("POST", "/api/auth/request-password-reset", {
        body: { email },
        env: mail.env,
      });
      const token = resetTokenFrom(mail.sent[0]);

      const tooShort = await callWorker("POST", "/api/auth/reset-password", {
        body: { token, newPassword: "short" },
      });
      expect(tooShort.res.status).toBe(400);
      expect(tooShort.json?.code).toBe("PASSWORD_TOO_SHORT");

      const reset = await callWorker("POST", "/api/auth/reset-password", {
        body: { token, newPassword: NEW_PASSWORD },
      });
      expect(reset.res.status).toBe(200);
      expect(await providerIds(userId)).toEqual(["credential"]);

      const replay = await callWorker("POST", "/api/auth/reset-password", {
        body: { token, newPassword: `${NEW_PASSWORD} again` },
      });
      expect(replay.res.status).toBe(400);
      expect(replay.json?.code).toBe("INVALID_TOKEN");

      const oldPassword = await callWorker("POST", "/api/auth/sign-in/email", {
        body: { email, password: PASSWORD },
      });
      expect(oldPassword.res.status).toBe(401);
      const newPassword = await callWorker("POST", "/api/auth/sign-in/email", {
        body: { email, password: NEW_PASSWORD },
      });
      expect(newPassword.res.status).toBe(200);
    },
  );

  test(
    "marks the address verified once a link is redeemed",
    { timeout: AUTH_TIMEOUT_MS },
    async () => {
      const email = uniqueEmail();
      const userId = await signUpUserId(new Map(), { email });
      expect(await emailVerified(userId)).toBe(false);
      const mail = captureEmail();
      await callWorker("POST", "/api/auth/request-password-reset", {
        body: { email },
        env: mail.env,
      });
      // Requesting proves nothing; only redeeming the mailed token does.
      expect(await emailVerified(userId)).toBe(false);

      const reset = await callWorker("POST", "/api/auth/reset-password", {
        body: { token: resetTokenFrom(mail.sent[0]), newPassword: NEW_PASSWORD },
        env: mail.env,
      });
      expect(reset.res.status).toBe(200);
      expect(await emailVerified(userId)).toBe(true);
    },
  );

  test("exposes no route that sets a password from a session alone", async () => {
    const jar: Jar = new Map();
    const userId = await signUpUserId(jar, { email: uniqueEmail() });
    await makeGithubOnly(userId);

    const attempt = await callWorker("POST", "/api/auth/set-password", {
      body: { newPassword: NEW_PASSWORD },
      jar,
    });
    expect(attempt.res.status).toBe(404);
    expect(await providerIds(userId)).toEqual(["github"]);
  });

  test("refuses a reset token carried in the URL", async () => {
    const token = "a".repeat(24);
    const callback = await callWorker("GET", `/api/auth/reset-password/${token}?callbackURL=/`);
    expect(callback.res.status).toBe(404);
    const queried = await callWorker("POST", `/api/auth/reset-password?token=${token}`, {
      body: { newPassword: NEW_PASSWORD },
    });
    expect(queried.res.status).toBe(400);
  });

  test("fails once the link has expired", { timeout: AUTH_TIMEOUT_MS }, async () => {
    const email = uniqueEmail();
    const userId = await signUpUserId(new Map(), { email });
    const mail = captureEmail();
    await callWorker("POST", "/api/auth/request-password-reset", {
      body: { email },
      env: mail.env,
    });
    const token = resetTokenFrom(mail.sent[0]);
    await env.DB.prepare("UPDATE verification SET expires_at = ? WHERE value = ?")
      .bind(Date.now() - 1000, userId)
      .run();

    const reset = await callWorker("POST", "/api/auth/reset-password", {
      body: { token, newPassword: NEW_PASSWORD },
    });
    expect(reset.res.status).toBe(400);
    expect(reset.json?.code).toBe("INVALID_TOKEN");
    expect(await providerIds(userId)).toEqual(["credential"]);
  });

  test(
    "keeps an enrolled second factor in front of the new password",
    { timeout: AUTH_TIMEOUT_MS },
    async () => {
      const email = uniqueEmail();
      const jar: Jar = new Map();
      await signUpUserId(jar, { email });
      const enable = await callWorker("POST", "/api/auth/two-factor/enable", {
        body: { password: PASSWORD },
        jar,
      });
      const totpURI = enable.json?.totpURI as string;
      await callWorker("POST", "/api/auth/two-factor/verify-totp", {
        body: { code: totpFor(totpURI) },
        jar,
      });

      const mail = captureEmail();
      await callWorker("POST", "/api/auth/request-password-reset", {
        body: { email },
        env: mail.env,
      });
      const token = resetTokenFrom(mail.sent[0]);
      const reset = await callWorker("POST", "/api/auth/reset-password", {
        body: { token, newPassword: NEW_PASSWORD },
      });
      expect(reset.res.status).toBe(200);

      const signIn = await callWorker("POST", "/api/auth/sign-in/email", {
        body: { email, password: NEW_PASSWORD },
        jar: new Map(),
      });
      expect(signIn.res.status).toBe(200);
      expect(signIn.json?.twoFactorRedirect).toBe(true);
    },
  );
});
