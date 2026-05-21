import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createDb } from "../db";
import * as schema from "../db/schema";

export function createAuth(env: Cloudflare.Env) {
  if (!env.DB) return null;
  const db = createDb(env.DB);
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET || "dev-only-change-me",
    baseURL: env.BETTER_AUTH_URL,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
      usePlural: false,
    }) as never,
    emailAndPassword: {
      enabled: true,
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

export async function isAuthenticated(auth: Auth, request: Request) {
  if (!auth) return false;
  try {
    const session = await (
      auth.api as { getSession(args: { headers: Headers }): Promise<unknown> }
    ).getSession({ headers: request.headers });
    return Boolean(session);
  } catch {
    return false;
  }
}
