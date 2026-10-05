import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import * as OTPAuth from "otpauth";
import { expect } from "vitest";
import worker from "../../../server";

// Full-worker HTTP helpers for suites that go through Better Auth for real:
// sign-up, session cookies, CSRF origin, TOTP.
const ORIGIN = "http://example.com";
export const PASSWORD = "correct horse battery staple";

export type Jar = Map<string, string>;

function mergeSetCookies(jar: Jar, res: Response): void {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    // An expiring cookie clears the jar entry, the way a browser would.
    if (!value || /expires=Thu, 01 Jan 1970/i.test(raw)) jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeader(jar: Jar): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

export interface WorkerCallOptions {
  body?: unknown;
  jar?: Jar;
  env?: typeof env;
  ip?: string;
}

export interface WorkerCallResult {
  res: Response;
  json: Record<string, unknown> | null;
  text: string;
}

export async function callWorker(
  method: string,
  path: string,
  opts: WorkerCallOptions = {},
): Promise<WorkerCallResult> {
  const ctx = createExecutionContext();
  const headers = new Headers();
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  // Non-GET requests are CSRF-checked against the request origin.
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("origin", ORIGIN);
  if (opts.jar?.size) headers.set("cookie", cookieHeader(opts.jar));
  if (opts.ip) headers.set("cf-connecting-ip", opts.ip);
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), opts.env ?? env, ctx);
  await waitOnExecutionContext(ctx);
  if (opts.jar) mergeSetCookies(opts.jar, res);
  // Parsed from a clone so callers can still read `res` themselves.
  const text = await res.clone().text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, json: json as Record<string, unknown> | null, text };
}

export interface SignUpOptions {
  email?: string;
  name?: string;
  env?: typeof env;
}

// Signs up a fresh account into `jar` and returns the email used.
export async function signUp(jar: Jar, options: SignUpOptions = {}): Promise<string> {
  const email = options.email ?? `tester-${crypto.randomUUID()}@example.test`;
  const { res } = await callWorker("POST", "/api/auth/sign-up/email", {
    body: { name: options.name ?? "Tester", email, password: PASSWORD },
    jar,
    env: options.env,
  });
  expect(res.status).toBe(200);
  return email;
}

async function sessionUserId(jar: Jar): Promise<string> {
  const session = await callWorker("GET", "/api/auth/get-session", { jar });
  const userId = (session.json?.user as { id?: string } | undefined)?.id;
  expect(typeof userId).toBe("string");
  return userId as string;
}

export function totpFor(totpURI: string): string {
  const parsed = OTPAuth.URI.parse(totpURI) as OTPAuth.TOTP;
  return parsed.generate();
}

export async function signUpUserId(jar: Jar, options: SignUpOptions = {}): Promise<string> {
  await signUp(jar, options);
  return sessionUserId(jar);
}

export interface SentEmail {
  to: string;
  raw: string;
}

export interface EmailCapture {
  env: typeof env;
  sent: SentEmail[];
}

// An env whose SEND_EMAIL binding records each message instead of sending it.
// Miniflare's EmailMessage is a plain object holding `from`, `to`, and the raw
// MIME string the Worker built, so the raw body is the value carrying headers.
export function captureEmail(base: typeof env = env): EmailCapture {
  const sent: SentEmail[] = [];
  const send = async (message: unknown) => {
    const fields = Object.values(message as Record<string, unknown>);
    const raw = fields.find((value) => typeof value === "string" && value.includes("MIME-Version"));
    sent.push({ to: String((message as { to?: unknown }).to), raw: String(raw ?? "") });
  };
  return { env: { ...base, SEND_EMAIL: { send } } as typeof env, sent };
}

// Swaps the password sign-in for the account shape Better Auth creates after
// GitHub OAuth: a `github` provider row and no `credential` row. The address is
// verified unless `emailVerified: false`, the shape left by a GitHub email that
// GitHub itself reported unverified.
export async function makeGithubOnly(
  userId: string,
  { emailVerified = true }: { emailVerified?: boolean } = {},
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare("UPDATE user SET email_verified = ? WHERE id = ?")
    .bind(emailVerified ? 1 : 0, userId)
    .run();
  await env.DB.prepare("DELETE FROM account WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare(
    "INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, 'github', ?, ?, ?)",
  )
    .bind(`github:${userId}`, `github-${userId}`, userId, now, now)
    .run();
}
