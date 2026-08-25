import { hexEncode } from "../platform/crypto-utils";
import { scrypt as nodeScrypt, scryptSync } from "node:crypto";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { and, eq, gt } from "drizzle-orm";
import { type AppDb, createDb } from "../../db/client";
import { deleteUserAccount, findCoOwnedOrganizations } from "../../db/organizations";
import { recordProductEvent } from "../platform/analytics";
import { describeOperationalError, emitOperationalEvent } from "../platform/observability";
import { purgeReconciledPublicFeedCaches } from "../public-feed";
import * as schema from "../../db/schema";
import { sendAccountVerificationEmail } from "../notify/account-email";

export interface AuthSession {
  userId: string;
  email?: string;
  name?: string;
  /**
   * Better Auth's own flag for this session's user. Undefined only when the
   * session payload predates it or omits the user; `requireVerifiedEmail`
   * treats that as verified so a shape change can never lock an account out of
   * actions it already had.
   */
  emailVerified?: boolean;
}

const VERIFICATION_TOKEN_TTL_SECONDS = 60 * 60 * 24; // 24 hours

// Match Better Auth's scrypt parameters and stored format exactly.
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
      (err, key) => (err ? reject(err) : resolve(hexEncode(key))),
    );
  });
}

export const nativeScryptPassword = {
  hash: async (password: string): Promise<string> => {
    const salt = hexEncode(crypto.getRandomValues(new Uint8Array(16)));
    return `${salt}:${await scryptKeyHex(password, salt)}`;
  },
  verify: async ({ hash, password }: { hash: string; password: string }): Promise<boolean> => {
    const [salt, key] = hash.split(":");
    if (!salt || !key) return false;
    return (await scryptKeyHex(password, salt)) === key;
  },
};

const nativeScryptAvailable = (() => {
  try {
    scryptSync("probe", "probe", SCRYPT_DKLEN, { N: 2, r: 1, p: 1, maxmem: SCRYPT_MAXMEM });
    return true;
  } catch {
    return false;
  }
})();

// Upper bound on signed-cookie revocation lag; authorization checks still read D1.
const SESSION_COOKIE_CACHE_SECONDS = 5 * 60;

// Colon-bearing keys include single-use verification credentials; keep them out of KV.
function isSessionStoreKeyAllowed(key: string): boolean {
  return !key.includes(":");
}

interface ActiveSessionCacheEntry {
  token: string;
  expiresAt: number;
}

interface SessionSecondaryStorage {
  storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttl?: number): Promise<void>;
    delete(key: string): Promise<void>;
  };
  prepareSessionDeletion(sessionToken: string): Promise<void>;
  prepareUserDeletion(userId: string): Promise<void>;
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

function createSessionSecondaryStorage(
  db: AppDb,
  namespace: KVNamespace | undefined,
): SessionSecondaryStorage | null {
  if (!namespace) return null;
  const store = namespace;
  const hydratedSessionValues = new Map<string, string>();
  const preparedUserDeletions = new Map<string, string>();
  const preparedDeletionKeys = new Set<string>();

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
    try {
      await store.put(
        key,
        value,
        ttl === undefined ? {} : { expirationTtl: Math.max(60, Math.ceil(ttl)) },
      );
    } catch (err) {
      reportSessionCacheFailure("write", err);
    }
  }

  async function getAuthoritativeActiveSessions(key: string): Promise<string | null> {
    const userId = key.slice("active-sessions-".length);
    const prepared = preparedUserDeletions.get(userId);
    if (prepared !== undefined) return prepared;

    const now = new Date();
    const [cached, owner, sessions] = await Promise.all([
      readCacheValue(key),
      db.select().from(schema.user).where(eq(schema.user.id, userId)).limit(1),
      db
        .select()
        .from(schema.session)
        .where(and(eq(schema.session.userId, userId), gt(schema.session.expiresAt, now))),
    ]);

    const [user] = owner;
    if (!user && sessions.length === 0) {
      // Fail closed if a retried teardown cannot recover the cached token index.
      if (cached.error) throw cached.error;
      return cached.value;
    }

    const nowMs = now.getTime();
    const active: ActiveSessionCacheEntry[] = sessions.map((session) => ({
      token: session.token,
      expiresAt: session.expiresAt.getTime(),
    }));
    if (user) {
      // Persisting this read-through can race revocation and resurrect a stale session.
      for (const session of sessions) {
        hydratedSessionValues.set(session.token, JSON.stringify({ session, user }));
      }
    }

    if (active.length === 0) {
      try {
        await store.delete(key);
      } catch (err) {
        reportSessionCacheFailure("delete", err);
      }
    } else {
      const furthestExpiry = Math.max(...active.map((session) => session.expiresAt));
      await setWithSafeTtl(key, JSON.stringify(active), Math.ceil((furthestExpiry - nowMs) / 1000));
    }
    return JSON.stringify(active);
  }

  async function getAuthoritativeSession(key: string): Promise<string | null> {
    const cached = await readCacheValue(key);
    if (cached.value !== null) return cached.value;

    const [session] = await db
      .select()
      .from(schema.session)
      .where(eq(schema.session.token, key))
      .limit(1);
    if (!session) return null;

    const [user] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, session.userId))
      .limit(1);
    if (!user) return null;

    const value = JSON.stringify({ session, user });
    hydratedSessionValues.set(key, value);
    return value;
  }

  async function prepareUserDeletion(userId: string): Promise<void> {
    const sessions = await db
      .select({ token: schema.session.token, expiresAt: schema.session.expiresAt })
      .from(schema.session)
      .where(eq(schema.session.userId, userId));
    const active = sessions
      .filter((session) => session.expiresAt.getTime() > Date.now())
      .map((session) => ({ token: session.token, expiresAt: session.expiresAt.getTime() }));
    const indexKey = `active-sessions-${userId}`;
    const keys = [indexKey, ...sessions.map((session) => session.token)];

    await Promise.all(keys.map((key) => store.delete(key)));
    preparedUserDeletions.set(userId, JSON.stringify(active));
    for (const key of keys) preparedDeletionKeys.add(key);
  }

  async function prepareSessionDeletion(sessionToken: string): Promise<void> {
    const [session] = await db
      .select({ userId: schema.session.userId })
      .from(schema.session)
      .where(eq(schema.session.token, sessionToken))
      .limit(1);

    // Evict before Better Auth can clear the cookie and swallow deletion failures.
    try {
      await store.delete(sessionToken);
    } catch (err) {
      reportSessionCacheFailure("delete", err);
      throw err;
    }
    preparedDeletionKeys.add(sessionToken);

    if (!session) return;
    const indexKey = `active-sessions-${session.userId}`;
    try {
      await store.delete(indexKey);
    } catch (err) {
      reportSessionCacheFailure("delete", err);
    }
    preparedDeletionKeys.add(indexKey);
  }

  return {
    storage: {
      get: async (key: string) => {
        if (!isSessionStoreKeyAllowed(key)) return null;
        if (key.startsWith("active-sessions-") && key.length > "active-sessions-".length) {
          return getAuthoritativeActiveSessions(key);
        }
        const hydrated = hydratedSessionValues.get(key);
        if (hydrated !== undefined) return hydrated;
        return getAuthoritativeSession(key);
      },
      set: async (key: string, value: string, ttl?: number) => {
        if (!isSessionStoreKeyAllowed(key)) return;
        await setWithSafeTtl(key, value, ttl);
      },
      delete: async (key: string) => {
        if (!isSessionStoreKeyAllowed(key) || preparedDeletionKeys.has(key)) return;
        await store.delete(key);
      },
    },
    prepareSessionDeletion,
    prepareUserDeletion,
  };
}

function createSessionDeletionPreflightPlugin(
  sessionCache: SessionSecondaryStorage,
): BetterAuthPlugin {
  return {
    id: "drydock-session-deletion-preflight",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/sign-out",
          handler: createAuthMiddleware(async (ctx) => {
            const token = await ctx.getSignedCookie(
              ctx.context.authCookies.sessionToken.name,
              ctx.context.secret,
            );
            if (token) await sessionCache.prepareSessionDeletion(token);
          }),
        },
      ],
    },
  };
}

/**
 * Whether this deployment can verify an email address at all.
 *
 * Without a mail transport — or on a local dev URL, where the link would point
 * somewhere the recipient cannot reach — no account could ever become verified,
 * so nothing may be gated on verification. Every verification guard reads this
 * first; see `email-verification.ts`.
 */
export function emailVerificationAvailable(env: Cloudflare.Env): boolean {
  return Boolean(env.SEND_EMAIL) && !isLocalAuthUrl(env.BETTER_AUTH_URL);
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

export function isGithubSignInEnabled(env: Cloudflare.Env): boolean {
  const clientId = env.GITHUB_OAUTH_CLIENT_ID;
  return Boolean(
    clientId &&
    env.GITHUB_OAUTH_CLIENT_SECRET &&
    // GitHub App OAuth tokens may inherit installation permissions.
    !clientId.startsWith("Iv"),
  );
}

export function createAuth(
  env: Cloudflare.Env,
  executionCtx: ExecutionContext | null = null,
  requestOrigin?: string,
) {
  if (!env.DB) throw new Error("DB binding is required for Better Auth");
  if (!env.BETTER_AUTH_SECRET) throw new Error("BETTER_AUTH_SECRET is required");

  const db = createDb(env.DB);
  const sessionCache = createSessionSecondaryStorage(db, env.AUTH_SESSIONS);
  const trustedOrigins = env.BETTER_AUTH_URL ? [env.BETTER_AUTH_URL] : [];
  const emailVerificationEnabled = emailVerificationAvailable(env);
  const githubSignIn = isGithubSignInEnabled(env);
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
    ...(sessionCache ? { secondaryStorage: sessionCache.storage } : {}),
    session: {
      cookieCache: {
        enabled: true,
        maxAge: SESSION_COOKIE_CACHE_SECONDS,
      },
      ...(sessionCache ? { storeSessionInDatabase: true } : {}),
    },
    // Keep single-use verification values on D1's transactional path.
    ...(sessionCache ? { verification: { storeInDatabase: true as const } } : {}),
    rateLimit: { storage: "memory" as const },
    emailVerification: {
      autoSignInAfterVerification: true,
      // Better Auth only defaults this on when sign-in requires verification,
      // which it no longer does — set it explicitly or sign-up would stop
      // sending a link at all. There is no `sendOnSignIn` counterpart: that
      // option only fires inside the sign-in block this deployment no longer
      // enters, so the resend path is the dashboard banner's own action.
      sendOnSignUp: emailVerificationEnabled,
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
      // Deliberately not gated on verification. Blocking sign-in put an email
      // round-trip in front of a product an account cannot evaluate without
      // signing in; `requireVerifiedEmail` (email-verification.ts) instead
      // guards the individual actions that spend trust — credentials,
      // decisions, public links, invitations, GitHub installs.
      requireEmailVerification: false,
      minPasswordLength: 12,
      maxPasswordLength: 256,
      ...(nativeScryptAvailable ? { password: nativeScryptPassword } : {}),
    },
    ...(githubSignIn
      ? {
          socialProviders: {
            github: {
              clientId: env.GITHUB_OAUTH_CLIENT_ID as string,
              clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET as string,
            },
          },
        }
      : {}),
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (
          (ctx.path === "/sign-in/social" || ctx.path === "/link-social") &&
          ctx.body &&
          typeof ctx.body === "object" &&
          Object.hasOwn(ctx.body, "scopes")
        ) {
          throw APIError.from("BAD_REQUEST", {
            code: "OAUTH_SCOPES_NOT_ALLOWED",
            message: "OAuth scope overrides are not allowed",
          });
        }
      }),
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: false,
        disableImplicitLinking: true,
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (createdUser) => {
            const social = Boolean((createdUser as { emailVerified?: boolean }).emailVerified);
            recordProductEvent(env, {
              name: "user.signed_up",
              method: social ? "github" : "email_password",
              outcome: social || !emailVerificationEnabled ? "active" : "verification_pending",
            });
          },
        },
      },
    },
    user: {
      deleteUser: {
        enabled: true,
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
          await sessionCache?.prepareUserDeletion(deletedUser.id);
          const changedScans = await deleteUserAccount(db, deletedUser.id, env.ARTIFACTS);
          let origin = requestOrigin;
          try {
            if (env.BETTER_AUTH_URL) origin = new URL(env.BETTER_AUTH_URL).origin;
          } catch {
            // Fall back to the current request's origin.
          }
          if (origin) purgeReconciledPublicFeedCaches(executionCtx, origin, changedScans);
        },
      },
    },
    plugins: [
      ...(sessionCache ? [createSessionDeletionPreflightPlugin(sessionCache)] : []),
      twoFactor({ issuer: "Drydock" }),
    ],
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

export async function userHasTwoFactor(db: AppDb, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: schema.user.twoFactorEnabled })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  return Boolean(row?.enabled);
}

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
    user?: { id?: unknown; email?: unknown; name?: unknown; emailVerified?: unknown };
  };
  const userId = root.user?.id ?? root.session?.userId ?? root.userId;
  if (typeof userId !== "string" || !userId) return null;
  return {
    userId,
    email: typeof root.user?.email === "string" ? root.user.email : undefined,
    name: typeof root.user?.name === "string" ? root.user.name : undefined,
    emailVerified:
      typeof root.user?.emailVerified === "boolean" ? root.user.emailVerified : undefined,
  };
}
