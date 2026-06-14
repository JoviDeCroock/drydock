import { scrypt as nodeScrypt, scryptSync } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { createDb, deleteUserAccount, findCoOwnedOrganizations, type AppDb } from "../db";
import * as schema from "../db/schema";
import { sendAccountVerificationEmail } from "./account-email";
import { appDisplayName } from "./brand";

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
      (err, key) => (err ? reject(err) : resolve(key.toString("hex"))),
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
  const trustedOrigins = env.BETTER_AUTH_URL ? [env.BETTER_AUTH_URL] : [];
  const appName = appDisplayName(env);
  // Only enforce email verification when an email transport is actually wired
  // up. Without SEND_EMAIL (local dev, e2e harness) we can't deliver the link,
  // so requiring it would lock every new account out of sign-in. Skip it for a
  // local auth origin too, so localhost sign-ups aren't blocked on a link that
  // never arrives. Production binds SEND_EMAIL with a real origin, so
  // verification is always enforced there.
  const emailVerificationEnabled = Boolean(env.SEND_EMAIL) && !isLocalAuthUrl(env.BETTER_AUTH_URL);
  return betterAuth({
    appName,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
      usePlural: false,
    }) as never,
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
          await deleteUserAccount(db, deletedUser.id);
        },
      },
    },
    plugins: [twoFactor({ issuer: appName })],
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

export async function isAuthenticated(auth: Auth, request: Request) {
  return Boolean(await getAuthSession(auth, request));
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
