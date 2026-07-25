import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker from "../../server";

const ORIGIN = "http://example.com";
const PASSWORD = "correct horse battery staple";

type Jar = Map<string, string>;

function mergeSetCookies(jar: Jar, res: Response) {
  const cookies = res.headers.getSetCookie?.() ?? [];
  for (const raw of cookies) {
    const [pair] = raw.split(";");
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

function cookieHeader(jar: Jar): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

interface CallOptions {
  body?: unknown;
  jar?: Jar;
}

async function call(method: string, path: string, opts: CallOptions = {}) {
  const ctx = createExecutionContext();
  const headers = new Headers();
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("origin", ORIGIN);
  if (opts.jar && opts.jar.size) headers.set("cookie", cookieHeader(opts.jar));
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  if (opts.jar) mergeSetCookies(opts.jar, res);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, json: json as Record<string, unknown> | null, text };
}

async function signUp(jar: Jar, email: string) {
  const { res } = await call("POST", "/api/auth/sign-up/email", {
    body: { name: "Account Tester", email, password: PASSWORD },
    jar,
  });
  expect(res.status).toBe(200);
}

async function currentUserId(jar: Jar): Promise<string> {
  const { json } = await call("GET", "/api/auth/get-session", { jar });
  const id = (json?.user as { id?: string } | undefined)?.id;
  expect(typeof id).toBe("string");
  return id as string;
}

/** Trigger lazy personal-workspace creation (ensurePersonalOrganization). */
async function ensureWorkspace(jar: Jar) {
  const { res } = await call("GET", "/api/v1/organizations", { jar });
  expect(res.status).toBe(200);
}

async function countRows(sql: string, ...binds: string[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function newAccount(): Promise<{ jar: Jar; userId: string; email: string }> {
  const email = `acct-${crypto.randomUUID()}@example.test`;
  const jar: Jar = new Map();
  await signUp(jar, email);
  const userId = await currentUserId(jar);
  await ensureWorkspace(jar);
  return { jar, userId, email };
}

describe("account deletion", () => {
  test("deletes the user, their personal workspace, and their sessions", async () => {
    const { jar, userId } = await newAccount();

    expect(
      await countRows("SELECT count(*) AS n FROM organizations WHERE owner_user_id = ?", userId),
    ).toBe(1);

    const del = await call("POST", "/api/auth/delete-user", { body: { password: PASSWORD }, jar });
    expect(del.res.status).toBe(200);

    // Session is gone, and nothing the user owned survives in D1.
    const after = await call("GET", "/api/auth/get-session", { jar });
    expect(after.json?.user).toBeFalsy();
    expect(await countRows("SELECT count(*) AS n FROM user WHERE id = ?", userId)).toBe(0);
    expect(await countRows("SELECT count(*) AS n FROM session WHERE user_id = ?", userId)).toBe(0);
    expect(await countRows("SELECT count(*) AS n FROM account WHERE user_id = ?", userId)).toBe(0);
    expect(
      await countRows("SELECT count(*) AS n FROM organizations WHERE owner_user_id = ?", userId),
    ).toBe(0);
    expect(
      await countRows("SELECT count(*) AS n FROM organization_members WHERE user_id = ?", userId),
    ).toBe(0);
  });

  test("refuses to delete an account that still owns a shared organization", async () => {
    const { jar, userId, email } = await newAccount();

    const created = await call("POST", "/api/v1/organizations", {
      body: { name: "Shared Co" },
      jar,
    });
    expect(created.res.status).toBe(201);
    const orgId = (created.json?.organization as { id?: string } | undefined)?.id ?? "";
    expect(orgId).toBeTruthy();

    // A second (real) member makes the org "shared" — deletion must be blocked.
    const other = await newAccount();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO organization_members (id, organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 'member', ?, ?)",
    )
      .bind(`member:${orgId}:${other.userId}`, orgId, other.userId, now, now)
      .run();

    const del = await call("POST", "/api/auth/delete-user", { body: { password: PASSWORD }, jar });
    expect(del.res.status).toBe(400);
    expect(String(del.json?.message ?? "")).toContain("Shared Co");

    // The account and its organization are untouched.
    expect(await countRows("SELECT count(*) AS n FROM user WHERE id = ?", userId)).toBe(1);
    expect(await countRows("SELECT count(*) AS n FROM organizations WHERE id = ?", orgId)).toBe(1);
    const stillThere = await call("GET", "/api/auth/get-session", { jar });
    expect((stillThere.json?.user as { email?: string })?.email).toBe(email);
  });

  test("removes memberships and nulls references in organizations owned by others", async () => {
    const owner = await newAccount();
    const created = await call("POST", "/api/v1/organizations", {
      body: { name: "Owner Org" },
      jar: owner.jar,
    });
    expect(created.res.status).toBe(201);
    const orgId = (created.json?.organization as { id?: string } | undefined)?.id ?? "";
    expect(orgId).toBeTruthy();

    // A second account that is only a *member* of the owner's org.
    const member = await newAccount();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO organization_members (id, organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 'member', ?, ?)",
    )
      .bind(`member:${orgId}:${member.userId}`, orgId, member.userId, now, now)
      .run();
    // ...and a scan they triggered inside that surviving org.
    const scanId = `scan-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO scans (id, stage_id, organization_id, owner_user_id, risk, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'unknown', 'completed', 'manual', ?, ?)",
    )
      .bind(scanId, "stage-1", orgId, member.userId, now, now)
      .run();

    const del = await call("POST", "/api/auth/delete-user", {
      body: { password: PASSWORD },
      jar: member.jar,
    });
    expect(del.res.status).toBe(200);

    // The member is gone; the owner's org and the owner survive.
    expect(await countRows("SELECT count(*) AS n FROM user WHERE id = ?", member.userId)).toBe(0);
    expect(
      await countRows(
        "SELECT count(*) AS n FROM organization_members WHERE user_id = ?",
        member.userId,
      ),
    ).toBe(0);
    expect(await countRows("SELECT count(*) AS n FROM organizations WHERE id = ?", orgId)).toBe(1);
    expect(
      await countRows(
        "SELECT count(*) AS n FROM organization_members WHERE organization_id = ? AND user_id = ?",
        orgId,
        owner.userId,
      ),
    ).toBe(1);
    // The scan stays, but its owner reference is nulled rather than dangling.
    expect(await countRows("SELECT count(*) AS n FROM scans WHERE id = ?", scanId)).toBe(1);
    expect(
      await countRows(
        "SELECT count(*) AS n FROM scans WHERE id = ? AND owner_user_id IS NULL",
        scanId,
      ),
    ).toBe(1);
  });

  test("rejects deletion when the password is wrong", async () => {
    const { jar, userId } = await newAccount();

    const del = await call("POST", "/api/auth/delete-user", {
      body: { password: "totally the wrong password" },
      jar,
    });
    expect(del.res.status).toBe(400);

    expect(await countRows("SELECT count(*) AS n FROM user WHERE id = ?", userId)).toBe(1);
    const after = await call("GET", "/api/auth/get-session", { jar });
    expect((after.json?.user as { id?: string })?.id).toBe(userId);
  });
});
