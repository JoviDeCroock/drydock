import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import * as schema from "../../server/db/schema";
import { createAuth } from "../../server/lib/auth";
import { isAcceptableTypedUserName, normalizeUserName } from "../../server/lib/auth/user-name";
import { callWorker, type Jar, PASSWORD, signUp } from "./helpers/auth-http";

const WORKER_AUTH_TIMEOUT_MS = 15_000;
const MULTI_LINE_NAME = "Release Bot\r\n\r\nA second paragraph https://example.test";

function uniqueEmail() {
  return `names-${crypto.randomUUID()}@example.test`;
}

async function storedName(email: string): Promise<string | undefined> {
  const [row] = await createDb(env.DB)
    .select({ name: schema.user.name })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  return row?.name;
}

describe("account display names", () => {
  test(
    "sign-up refuses a name with line breaks, bidi controls, or over 64 characters",
    async () => {
      for (const name of [MULTI_LINE_NAME, "Ada Lovelace", "Ada ‮ecalevol", "a".repeat(65)]) {
        const email = uniqueEmail();
        const { res, json } = await callWorker("POST", "/api/auth/sign-up/email", {
          body: { name, email, password: PASSWORD },
        });
        expect(res.status, JSON.stringify(name)).toBe(400);
        expect(json).toMatchObject({ code: "INVALID_NAME" });
        expect(await storedName(email)).toBeUndefined();
      }
    },
    WORKER_AUTH_TIMEOUT_MS,
  );

  test(
    "sign-up stores a typed name with its spacing collapsed",
    async () => {
      const email = uniqueEmail();
      await signUp(new Map(), { email, name: "  Ada   Lovelace " });
      expect(await storedName(email)).toBe("Ada Lovelace");
    },
    WORKER_AUTH_TIMEOUT_MS,
  );

  test(
    "update-user refuses a multi-line name and keeps the stored one",
    async () => {
      const jar: Jar = new Map();
      const email = await signUp(jar, { name: "Ada Lovelace" });

      const refused = await callWorker("POST", "/api/auth/update-user", {
        body: { name: MULTI_LINE_NAME },
        jar,
      });
      expect(refused.res.status).toBe(400);
      expect(refused.json).toMatchObject({ code: "INVALID_NAME" });
      expect(await storedName(email)).toBe("Ada Lovelace");

      const accepted = await callWorker("POST", "/api/auth/update-user", {
        body: { name: "Ada King" },
        jar,
      });
      expect(accepted.res.status).toBe(200);
      expect(await storedName(email)).toBe("Ada King");
    },
    WORKER_AUTH_TIMEOUT_MS,
  );

  test(
    "a name whose single grapheme is enormous is refused when typed and bounded when stored",
    async () => {
      const zwjChain = "\u{1F468}\u200D".repeat(20_000) + "\u{1F468}";
      for (const huge of [zwjChain, "\u1100".repeat(50_000), "\u0915\u094D".repeat(20_000)]) {
        expect(isAcceptableTypedUserName(`Ada ${huge}`)).toBe(false);
        expect(normalizeUserName(`Ada ${huge}`).length).toBeLessThanOrEqual(256);
      }
      const email = uniqueEmail();
      const { res, json } = await callWorker("POST", "/api/auth/sign-up/email", {
        body: { name: `Ada ${zwjChain}`, email, password: PASSWORD },
      });
      expect(res.status).toBe(400);
      expect(json).toMatchObject({ code: "INVALID_NAME" });
    },
    WORKER_AUTH_TIMEOUT_MS,
  );

  test("a GitHub profile name is normalized instead of refused, on create and update", async () => {
    // The OAuth callback provisions through `createOAuthUser`; no typed-name
    // check runs there, so the database hooks alone must keep the row clean.
    const context = await createAuth(env).$context;
    const email = uniqueEmail();
    const { user } = await context.internalAdapter.createOAuthUser(
      {
        name: `Octo Cat‮\t${"x".repeat(100)}`,
        email,
        emailVerified: true,
        image: null,
      },
      { providerId: "github", accountId: crypto.randomUUID() },
    );
    const created = await storedName(email);
    expect(created).toBe(`Octo Cat ${"x".repeat(55)}`);
    expect(Array.from(created ?? "")).toHaveLength(64);

    await context.internalAdapter.updateUser(user.id, { name: "Octo\nCat" });
    expect(await storedName(email)).toBe("Octo Cat");

    // The cap counts graphemes in workerd, so a trailing emoji sequence stays whole.
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    await context.internalAdapter.updateUser(user.id, { name: `${"x".repeat(63)}${family}!` });
    expect(await storedName(email)).toBe(`${"x".repeat(63)}${family}`);
  });
});
