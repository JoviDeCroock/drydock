import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { ACTIVE_ORG_HEADER } from "../../../server/lib/auth/active-organization";
import type { Bindings, Variables } from "../../../server/types";

export type TestApp = Hono<{ Bindings: Bindings; Variables: Variables }>;

export interface TestSession {
  userId: string;
  emailVerified?: boolean;
}

// Mounts route modules behind a pre-resolved auth session so route tests skip
// Better Auth entirely. `authPath` narrows where the session is injected for
// apps that also mount anonymous surfaces (`/public`).
export function buildTestApp(
  mount: (app: TestApp) => void,
  session: TestSession | null,
  options: { authPath?: string } = {},
): TestApp {
  const app: TestApp = new Hono();
  if (session) {
    app.use(options.authPath ?? "*", async (c, next) => {
      c.set("authSession", { ...session });
      await next();
    });
  }
  mount(app);
  return app;
}

export interface CallOptions {
  body?: unknown;
  activeOrganizationId?: string;
  envOverride?: Partial<Bindings>;
}

export async function call(
  app: TestApp,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = {};
  const init: RequestInit = { method };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }
  if (options.activeOrganizationId) headers[ACTIVE_ORG_HEADER] = options.activeOrganizationId;
  init.headers = headers;
  const routeEnv = options.envOverride
    ? ({ ...(env as unknown as Bindings), ...options.envOverride } as Bindings)
    : env;
  const res = await app.fetch(new Request(`http://test.local${path}`, init), routeEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
