import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { createDb, type AppDb } from "../db";
import * as schema from "../db/schema";
import { sendAccountVerificationEmail } from "./account-email";

export interface AuthSession {
  userId: string;
  email?: string;
  name?: string;
}

const VERIFICATION_TOKEN_TTL_SECONDS = 60 * 60 * 24; // 24 hours

export function createAuth(env: Cloudflare.Env) {
  if (!env.DB) throw new Error("DB binding is required for Better Auth");
  if (!env.BETTER_AUTH_SECRET) throw new Error("BETTER_AUTH_SECRET is required");

  const db = createDb(env.DB);
  const trustedOrigins = env.BETTER_AUTH_URL ? [env.BETTER_AUTH_URL] : [];
  // Only enforce email verification when an email transport is actually wired
  // up. Without SEND_EMAIL (local dev, e2e harness) we can't deliver the link,
  // so requiring it would lock every new account out of sign-in. Production
  // always binds SEND_EMAIL, so verification is always enforced there.
  const emailVerificationEnabled = Boolean(env.SEND_EMAIL);
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
