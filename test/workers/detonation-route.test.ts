import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { createScanJob, persistScan } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import {
  detonationInputFromFiles,
  parseDetonationReport,
  DETONATION_REPORT_SCHEMA,
} from "../../server/lib/detonation";
import { scansRoutes } from "../../server/routes/scans";
import type { Bindings, Variables } from "../../server/types";

interface SeededUser {
  userId: string;
  organizationId: string;
}

async function seedUser(): Promise<SeededUser> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  return { userId, organizationId };
}

// A stub detonation container: a Fetcher that returns a canned report, so the
// route's dispatch/validate/ingest path is exercised without a real container.
function stubDetonationBinding(handler: (input: unknown) => Response): Fetcher {
  return {
    async fetch(_url: string | Request, init?: RequestInit) {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      return handler(body);
    },
  } as unknown as Fetcher;
}

function flag(enabled: boolean): Flagship {
  return {
    async getBooleanValue() {
      return enabled;
    },
  } as unknown as Flagship;
}

function buildTestApp(
  session: { userId: string },
  overrides: { DETONATION?: Fetcher; FLAGS?: Flagship } = {},
) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId: session.userId });
    // Layer the per-test bindings over the base test env.
    c.env = { ...env, ...overrides } as Bindings;
    await next();
  });
  app.route("/api/v1/scans", scansRoutes);
  return app;
}

async function post(app: ReturnType<typeof buildTestApp>, path: string) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://test.local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedCompletedScan(owner: SeededUser): Promise<string> {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${scanId.slice(-12)}`;
  await createScanJob(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
  });
  await persistScan(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    packageJson: { name: "@org/pkg", version: "1.1.0" },
    risk: "low",
    status: "complete",
    summary: { report: { version: 1, digest: "abc", digestAlgorithm: "sha256" } },
    ai: null,
    files: [
      { path: "package.json", size: 40, sha256: "a", flags: [], textSample: '{"name":"@org/pkg"}' },
      { path: "install.js", size: 10, sha256: "b", flags: [], textSample: "console.log(1)" },
    ],
    diff: [{ path: "package.json", status: "modified", flags: [] }],
    findings: [],
    report: { version: 1, digest: "abc" },
  });
  return scanId;
}

const CRITICAL_REPORT = {
  schema: DETONATION_REPORT_SCHEMA,
  verdict: "critical",
  behaviorCount: 1,
  findings: [
    {
      source: "detonation",
      severity: "critical",
      ruleId: "detonation.credential-exfil",
      evidence: "canary via http.body",
      reason: "A planted credential canary was sent off-host during install.",
    },
  ],
};

describe("POST /api/v1/scans/:id/detonate", () => {
  test("dispatches to the container and returns advisory findings", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    let dispatched: unknown = null;
    const binding = stubDetonationBinding((input) => {
      dispatched = input;
      return new Response(JSON.stringify(CRITICAL_REPORT), {
        headers: { "content-type": "application/json" },
      });
    });
    const app = buildTestApp(owner, { DETONATION: binding, FLAGS: flag(true) });

    const res = await post(app, `/api/v1/scans/${scanId}/detonate`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      detonation: { verdict: string; advisory: boolean; findings: Array<{ source: string }> };
    };
    expect(body.detonation.verdict).toBe("critical");
    expect(body.detonation.advisory).toBe(true);
    expect(body.detonation.findings[0].source).toBe("detonation");

    // Credential-free dispatch: only package bytes crossed the boundary.
    const payload = dispatched as { package: { files: Record<string, string> } };
    expect(Object.keys(payload.package.files).sort()).toEqual(["install.js", "package.json"]);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(owner.userId);
    expect(serialized.toLowerCase()).not.toContain("token");
  });

  test("is 403 when the flag is off", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const app = buildTestApp(owner, {
      DETONATION: stubDetonationBinding(() => new Response("{}")),
      FLAGS: flag(false),
    });
    expect((await post(app, `/api/v1/scans/${scanId}/detonate`)).status).toBe(403);
  });

  test("is 503 when the flag is on but no runtime is configured", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const app = buildTestApp(owner, { DETONATION: undefined, FLAGS: flag(true) });
    expect((await post(app, `/api/v1/scans/${scanId}/detonate`)).status).toBe(503);
  });

  test("a malformed container report is rejected as 502, never trusted", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const binding = stubDetonationBinding(
      () => new Response(JSON.stringify({ schema: "evil", verdict: "clean" })),
    );
    const app = buildTestApp(owner, { DETONATION: binding, FLAGS: flag(true) });
    expect((await post(app, `/api/v1/scans/${scanId}/detonate`)).status).toBe(502);
  });

  test("a container transport error is 502, not a crash", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const binding = stubDetonationBinding(() => {
      throw new Error("container down");
    });
    const app = buildTestApp(owner, { DETONATION: binding, FLAGS: flag(true) });
    expect((await post(app, `/api/v1/scans/${scanId}/detonate`)).status).toBe(502);
  });
});

describe("detonation report validation", () => {
  test("parseDetonationReport rejects wrong schema, bad verdict, and bad findings", () => {
    expect(parseDetonationReport(null)).toBeNull();
    expect(parseDetonationReport({ schema: "nope", verdict: "clean", findings: [] })).toBeNull();
    expect(
      parseDetonationReport({ schema: DETONATION_REPORT_SCHEMA, verdict: "boom", findings: [] }),
    ).toBeNull();
    expect(
      parseDetonationReport({
        schema: DETONATION_REPORT_SCHEMA,
        verdict: "high",
        findings: [{ severity: "nope", ruleId: "x", evidence: "e", reason: "r" }],
      }),
    ).toBeNull();
  });

  test("parseDetonationReport accepts a well-formed report and stamps the source", () => {
    const parsed = parseDetonationReport(CRITICAL_REPORT);
    expect(parsed?.verdict).toBe("critical");
    expect(parsed?.findings[0].source).toBe("detonation");
  });

  test("detonationInputFromFiles requires a package.json sample", () => {
    expect(
      detonationInputFromFiles({ name: "p", version: "1", ecosystem: "npm" }, [
        { path: "index.js", textSample: "x" },
      ]),
    ).toBeNull();
    const input = detonationInputFromFiles({ name: "p", version: "1", ecosystem: "npm" }, [
      { path: "package.json", textSample: "{}" },
      { path: "index.js", textSample: null },
    ]);
    expect(input?.package.files).toEqual({ "package.json": "{}" });
  });
});
