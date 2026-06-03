import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createDb } from "../db";
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
        await sendAccountVerificationEmail(env, { email: user.email, url });
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: emailVerificationEnabled,
      minPasswordLength: 12,
      maxPasswordLength: 256,
    },
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
