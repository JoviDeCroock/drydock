import { scrypt as nodeScrypt, scryptSync } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { and, eq, gt } from "drizzle-orm";
import { type AppDb, createDb } from "../../db/client";
import { deleteUserAccount, findCoOwnedOrganizations } from "../../db/organizations";
import { recordProductEvent } from "../platform/analytics";
import { describeOperationalError, emitOperationalEvent } from "../platform/observability";
import * as schema from "../../db/schema";
import { sendAccountVerificationEmail } from "../notify/account-email";

export interface AuthSession {
  userId: string;
  email?: string;
  name?: string;
}

const VERIFICATION_TOKEN_TTL_SECONDS = 60 * 60 * 24; // 24 hours

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

// Better Auth's password KDF is scrypt with these parameters. On the Workers
// runtime it resolves to the pure-JS `@noble/hashes` scrypt, which runs
// synchronously in the isolate and costs ~hundreds of ms per hash — slow for
// every production login and the dominant cost of the auth-heavy Worker test
// suite. node:crypto's native scrypt (libuv thread pool, C implementation) is an
// order of magnitude faster and, for identical parameters/salt, produces
// byte-identical output. We keep the exact format Better Auth uses — salt is the
// lowercase hex of 16 random bytes, stored as `salt:hex(key)` — so hashes are
// compatible in both directions (a hash written by either implementation
// verifies under the other). The parity invariant is locked by
// test/workers/auth-password-hash.test.ts; mirrors better-auth#8456.
const SCRYPT_N = 16384;
const SCRYPT_R = 16;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 64;
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;

export function scryptKeyHex(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password.normalize("NFKC"),
      salt,
      SCRYPT_DKLEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      // `toHex` rather than `key.toString("hex")`: @cloudflare/workers-types
      // declares a global `Buffer: any`, which clobbers the @types/node `Buffer`
      // interface merge and leaves only the `Uint8Array` members visible.
      (err, key) => (err ? reject(err) : resolve(toHex(key))),
    );
  });
}

export const nativeScryptPassword = {
  hash: async (password: string): Promise<string> => {
    const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
    return `${salt}:${await scryptKeyHex(password, salt)}`;
  },
  verify: async ({ hash, password }: { hash: string; password: string }): Promise<boolean> => {
    const [salt, key] = hash.split(":");
    if (!salt || !key) return false;
    return (await scryptKeyHex(password, salt)) === key;
  },
};

// Use native scrypt when the runtime supports it (all of prod/test/dev run with
// `nodejs_compat`), otherwise leave Better Auth on its own scrypt default — never
// a silent downgrade. Probed once with tiny work-factor params so import stays
// cheap; the real work factor above is exercised on every hash/verify.
const nativeScryptAvailable = (() => {
  try {
    scryptSync("probe", "probe", SCRYPT_DKLEN, { N: 2, r: 1, p: 1, maxmem: SCRYPT_MAXMEM });
    return true;
  } catch {
    return false;
  }
})();

/**
 * How long a request may resolve its session from the signed session-data cookie
 * before Better Auth re-reads the session store.
 *
 * This is the revocation lag: after a sign-out, a session revocation, or an
 * account deletion, a request that still carries a fresh cookie can be served
 * for up to this long. Kept deliberately short. It never applies to the checks
 * that matter for a release decision — two-factor enrollment
 * (`userHasTwoFactor`), organization membership and role, and every ownership
 * check read D1 directly on every request.
 */
const SESSION_COOKIE_CACHE_SECONDS = 5 * 60;

/**
 * Whether a Better Auth secondary-storage key is one we refuse to put in KV.
 *
 * Better Auth does not offer a per-model opt-out for secondary storage: once
 * `secondaryStorage` is configured, its `createWithHooks` writer runs for
 * *verification* records too (`verification.storeInDatabase` only controls
 * whether the database write also happens). Those records are single-use
 * credentials — password-reset tokens, email-verification tokens, the two-factor
 * challenge and its attempt counter — and Better Auth names the KV key after the
 * identifier, so `verification:reset-password:<token>` would put the token itself
 * in a KV key *name*, readable by anything with list access to the namespace.
 *
 * Better Auth namespaces every non-session record as `<namespace>:<identifier>`,
 * while a session key is either the raw session token or
 * `active-sessions-<userId>` — both generated by `generateId`, which emits
 * alphanumerics only. Refusing every colon-bearing key therefore blocks
 * verification records (and any namespace a future Better Auth version adds)
 * while passing everything session-related.
 *
 * The guard is fail-safe rather than fail-closed by luck: `storeSessionInDatabase`
 * and `verification.storeInDatabase` keep D1 authoritative for both record kinds,
 * so a suppressed write only costs a cache miss. Verified against better-auth
 * 1.6.29 `dist/db/internal-adapter.mjs`: `findVerificationValue` falls through to
 * the database on a KV miss, `consumeVerificationValue` takes the transactional
 * database branch, and the post-consume `secondaryStorage.delete` of a key that
 * was never written is a no-op.
 */
function isSessionStoreKeyAllowed(key: string): boolean {
  return !key.includes(":");
}

/**
 * Better Auth secondary storage backed by Workers KV.
 *
 * KV is eventually consistent, so a revocation written in one colo can take
 * additional seconds to be visible in another — on top of the cookie-cache lag
 * above. Sessions are the only thing stored here (see
 * `isSessionStoreKeyAllowed`); everything Drydock authorizes on (organization
 * membership, roles, npm connections, scans) stays in D1.
 */
interface ActiveSessionCacheEntry {
  token: string;
  expiresAt: number;
}

type SessionCacheOperation = "read" | "write" | "delete";
const warnedSessionCacheOperations = new Set<SessionCacheOperation>();

function reportSessionCacheFailure(operation: SessionCacheOperation, err: unknown): void {
  if (warnedSessionCacheOperations.has(operation)) return;
  warnedSessionCacheOperations.add(operation);
  emitOperationalEvent("warn", "auth.session_cache_unavailable", {
    operation,
    error: describeOperationalError(err),
  });
}

function createSessionSecondaryStorage(db: AppDb, namespace: KVNamespace | undefined) {
  if (!namespace) return null;
  const store = namespace;

  async function readCacheValue(
    key: string,
  ): Promise<{ value: string | null; error: unknown | null }> {
    try {
      return { value: await store.get(key), error: null };
    } catch (err) {
      reportSessionCacheFailure("read", err);
      return { value: null, error: err };
    }
  }

  async function setWithSafeTtl(key: string, value: string, ttl?: number): Promise<void> {
    // KV rejects a TTL under 60 seconds. Clamp rather than dropping the TTL: an
    // entry with no expiration would outlive the session it caches.
    try {
      await store.put(
        key,
        value,
        ttl === undefined ? {} : { expirationTtl: Math.max(60, Math.ceil(ttl)) },
      );
    } catch (err) {
      // D1 is the durable session store, so a failed cache fill must not fail a
      // sign-in after Better Auth has already created the D1 session row.
      reportSessionCacheFailure("write", err);
    }
  }

  async function getAuthoritativeActiveSessions(key: string): Promise<string | null> {
    const userId = key.slice("active-sessions-".length);
    const now = new Date();
    const [cached, owner, sessions] = await Promise.all([
      readCacheValue(key),
      db.select().from(schema.user).where(eq(schema.user.id, userId)).limit(1),
      db
        .select()
        .from(schema.session)
        .where(and(eq(schema.session.userId, userId), gt(schema.session.expiresAt, now))),
    ]);

    // `deleteUser` and `deleteUserSessions` clear secondary storage *before*
    // deleting the D1 rows, so an ordinary teardown still sees a live user here
    // and gets the authoritative token list to evict. Falling back to the cached
    // index covers the case where the user row is already gone — a retried or
    // partially failed teardown — where D1 can no longer name the tokens. For a
    // live user D1 is the authority, so a newly bound, cleared, or
    // eventually-consistent KV namespace cannot hide sessions from list-sessions
    // or revoke-other-sessions.
    const [user] = owner;
    if (!user && sessions.length === 0) {
      // A retried teardown may need the cached index after the user and D1
      // sessions are already gone. If that index could not be read, fail closed:
      // returning an empty list would let Better Auth report revocation complete
      // while token entries may still be live in KV.
      if (cached.error) throw cached.error;
      return cached.value;
    }

    const nowMs = now.getTime();
    const active: ActiveSessionCacheEntry[] = sessions.map((session) => ({
      token: session.token,
      expiresAt: session.expiresAt.getTime(),
    }));
    if (user) {
      await Promise.all(
        sessions.map((session) =>
          setWithSafeTtl(
            session.token,
            JSON.stringify({ session, user }),
            Math.ceil((session.expiresAt.getTime() - nowMs) / 1000),
          ),
        ),
      );
    }

    if (active.length === 0) {
      try {
        await store.delete(key);
      } catch (err) {
        // This is only cleanup for an index D1 already proved empty. Better
        // Auth's explicit delete path below still propagates eviction failures.
        reportSessionCacheFailure("delete", err);
      }
    } else {
      const furthestExpiry = Math.max(...active.map((session) => session.expiresAt));
      await setWithSafeTtl(key, JSON.stringify(active), Math.ceil((furthestExpiry - nowMs) / 1000));
    }
    return JSON.stringify(active);
  }

  return {
    get: (key: string) => {
      if (!isSessionStoreKeyAllowed(key)) return Promise.resolve(null);
      if (key.startsWith("active-sessions-") && key.length > "active-sessions-".length) {
        return getAuthoritativeActiveSessions(key);
      }
      return readCacheValue(key).then(({ value }) => value);
    },
    set: async (key: string, value: string, ttl?: number) => {
      if (!isSessionStoreKeyAllowed(key)) return;
      await setWithSafeTtl(key, value, ttl);
    },
    delete: async (key: string) => {
      if (!isSessionStoreKeyAllowed(key)) return;
      await store.delete(key);
    },
  };
}

function isLocalAuthUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

export function createAuth(env: Cloudflare.Env) {
  if (!env.DB) throw new Error("DB binding is required for Better Auth");
  if (!env.BETTER_AUTH_SECRET) throw new Error("BETTER_AUTH_SECRET is required");

  const db = createDb(env.DB);
  const secondaryStorage = createSessionSecondaryStorage(db, env.AUTH_SESSIONS);
  const trustedOrigins = env.BETTER_AUTH_URL ? [env.BETTER_AUTH_URL] : [];
  const emailVerificationEnabled = Boolean(env.SEND_EMAIL) && !isLocalAuthUrl(env.BETTER_AUTH_URL);
  return betterAuth({
    appName: "Drydock",
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
      usePlural: false,
    }) as never,
    ...(secondaryStorage ? { secondaryStorage } : {}),
    session: {
      // Every authenticated `/api/*` request resolves a session. Without a cache
      // that is one D1 read per request (plus a refresh write on GETs) against a
      // single writer, and the compare/compare-file endpoints a reviewer drives
      // are allowed hundreds of requests a minute.
      //
      // Two layers sit in front of D1:
      //
      // 1. `cookieCache` — a short-lived signed copy of the session and user in
      //    the `spr.session_data` cookie. While it is fresh the session resolves
      //    with zero storage reads.
      // 2. `secondaryStorage` (KV, when `AUTH_SESSIONS` is bound) — the session
      //    read/write path moves to KV, which scales horizontally.
      //
      // `storeSessionInDatabase` keeps D1 as the durable record so sessions that
      // existed before KV was introduced keep working (Better Auth falls back to
      // the database on a KV miss), account deletion and session revocation still
      // have rows to delete, and losing the KV namespace cannot log everyone out.
      // The storage wrapper also rebuilds Better Auth's active-session index from
      // D1 so list/revoke operations cannot overlook those durable sessions.
      cookieCache: {
        enabled: true,
        maxAge: SESSION_COOKIE_CACHE_SECONDS,
      },
      ...(secondaryStorage ? { storeSessionInDatabase: true } : {}),
    },
    // Verification values — email-verification links, password-reset tokens, the
    // two-factor challenge and its attempt counter — must stay in D1. Better Auth
    // routes them through secondary storage as soon as it is configured, where
    // single-use consumption degrades to a non-atomic get-then-delete. This keeps
    // `consumeVerificationValue` transactional, so a reset token or a 2FA
    // challenge cannot be redeemed twice. It does *not* stop Better Auth from
    // also writing them to KV — `isSessionStoreKeyAllowed` is what does that.
    ...(secondaryStorage ? { verification: { storeInDatabase: true as const } } : {}),
    // Better Auth's own request limiter defaults to `secondary-storage` whenever
    // `secondaryStorage` is set, which would add a KV read and write to every
    // /api/auth/* request and make the limiter depend on KV's eventual
    // consistency under exactly the load it exists to shed. Pinned to the
    // in-isolate default it had before KV was introduced; Drydock's own per-IP
    // limits (server/lib/platform/rate-limit.ts) are the real control.
    rateLimit: { storage: "memory" as const },
    emailVerification: {
      autoSignInAfterVerification: true,
      sendOnSignIn: true,
      expiresIn: VERIFICATION_TOKEN_TTL_SECONDS,
      sendVerificationEmail: async ({ user, url }) => {
        const result = await sendAccountVerificationEmail(env, { email: user.email, url });
        if (!result.ok) {
          throw new Error(`verification email failed: ${result.reason ?? "unknown error"}`);
        }
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: emailVerificationEnabled,
      minPasswordLength: 12,
      maxPasswordLength: 256,
      ...(nativeScryptAvailable ? { password: nativeScryptPassword } : {}),
    },
    databaseHooks: {
      user: {
        create: {
          // Top of the funnel. Fires once per account row, so it counts real
          // signups rather than sign-in attempts. Nothing identifying is
          // recorded — not the email, not the user id (see the privacy posture
          // in lib/platform/analytics.ts). `emailVerificationEnabled` rides
          // along as the outcome because an unverified account cannot reach a
          // scan, and that is the first place the funnel leaks.
          after: async () => {
            recordProductEvent(env, {
              name: "user.signed_up",
              method: "email_password",
              outcome: emailVerificationEnabled ? "verification_pending" : "active",
            });
          },
        },
      },
    },
    user: {
      deleteUser: {
        enabled: true,
        // Reauth reuses Better Auth's credential check: the caller must resend
        // the account password, which Better Auth verifies before invoking this
        // hook. We then tear down everything Drydock owns for the user; Better
        // Auth removes the user/session/account rows once the hook returns.
        // Throwing aborts the deletion with nothing partially removed — we refuse
        // outright when the user still owns a shared organization rather than
        // destroying co-members' data.
        beforeDelete: async (deletedUser) => {
          const conflicts = await findCoOwnedOrganizations(db, deletedUser.id);
          if (conflicts.length > 0) {
            const names = conflicts.map((org) => org.name).join(", ");
            throw new APIError("BAD_REQUEST", {
              code: "OWNS_SHARED_ORGANIZATIONS",
              message: `Delete or hand off ${
                conflicts.length === 1 ? "this organization" : "these organizations"
              } before deleting your account: ${names}`,
            });
          }
          await deleteUserAccount(db, deletedUser.id, env.ARTIFACTS);
        },
      },
    },
    plugins: [twoFactor({ issuer: "Drydock" })],
    advanced: {
      cookiePrefix: "spr",
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
      },
      defaultCookieAttributes: {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

export async function getAuthSession(auth: Auth, request: Request): Promise<AuthSession | null> {
  try {
    const data = await (
      auth.api as { getSession(args: { headers: Headers }): Promise<unknown> }
    ).getSession({ headers: request.headers });

    const session = normalizeSession(data);
    return session?.userId ? session : null;
  } catch {
    return null;
  }
}

/**
 * Whether the user has completed two-factor enrollment. Drives the step-up
 * requirement on high-trust actions: a member who turned on 2FA must prove a
 * fresh second factor before releasing or blocking a held deployment gate.
 */
export async function userHasTwoFactor(db: AppDb, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: schema.user.twoFactorEnabled })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  return Boolean(row?.enabled);
}

/**
 * Verify a *fresh* TOTP step-up for the request's authenticated session.
 *
 * Delegates to Better Auth's own `verifyTOTP` so the code is checked against the
 * session user's encrypted secret (never decrypted here) and is bound to the
 * very session making the request — a member cannot step up on another's behalf.
 * Returns `false` on any invalid code rather than throwing, so callers map it to
 * a 401. No session side effects: for an already-authenticated, already-verified
 * user the plugin only validates the code.
 */
export async function verifyTotpStepUp(
  auth: Auth,
  request: Request,
  code: string,
): Promise<boolean> {
  try {
    await (
      auth.api as {
        verifyTOTP(args: { body: { code: string }; headers: Headers }): Promise<unknown>;
      }
    ).verifyTOTP({ body: { code }, headers: request.headers });
    return true;
  } catch {
    return false;
  }
}

function normalizeSession(data: unknown): AuthSession | null {
  if (!data || typeof data !== "object") return null;
  const root = data as {
    userId?: unknown;
    session?: { userId?: unknown };
    user?: { id?: unknown; email?: unknown; name?: unknown };
  };
  const userId = root.user?.id ?? root.session?.userId ?? root.userId;
  if (typeof userId !== "string" || !userId) return null;
  return {
    userId,
    email: typeof root.user?.email === "string" ? root.user.email : undefined,
    name: typeof root.user?.name === "string" ? root.user.name : undefined,
  };
}
