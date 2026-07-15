import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { createScanJob, persistScan } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import {
  detonationArchiveMatches,
  detonationArtifactMatches,
  parseDetonationReport,
  DETONATION_REPORT_SCHEMA,
} from "../../server/lib/detonation";
import { encryptNpmToken } from "../../server/lib/npm-connection";
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
  const encrypted = await encryptNpmToken(env, "npm_test_token_0123456789");
  await db.insert(schema.npmConnections).values({
    id: `npm_${crypto.randomUUID()}`,
    organizationId,
    registryUrl: "https://registry.npmjs.org",
    label: "npm",
    ...encrypted,
    validationStatus: "valid",
    createdByUserId: userId,
    createdAt: now,
    updatedAt: now,
  });
  return { userId, organizationId };
}

interface DetonationBindingStub {
  binding: DurableObjectNamespace;
  state: { archives: Uint8Array[]; destroyed: number; names: string[] };
}

// The exact package fixture used by both the completed scan's identity manifest
// and the staged-registry gateway stub.
const STAGED_ARCHIVE = Uint8Array.from(
  atob(
    "H4sIAAAAAAAA/+2T0QrCIBSGd91TiFcF4Y7SNthVryJLZM1UdHUz9u4ZG+uiQUSjKPxuxF/Qc9TP8qrhUqR2GMnRG50sDADkux2ay29QmqOEZozlAAwYS0KSZQwlsHQhc5x9y10o5d19hl7QNP4IHdb8JHCJ98bJ1DYSb/FFOF8bHUJKKIGQ+MrVtvW47HCtw4UpFRa1OQg0TsO/wX2/+nY3kVcZvU/v77j8GU/8B1Y8+M8KGv3/BJXR3ihBlJHrye1NFDkSiUT+nSvnAx/mAAwAAA==",
  ),
  (char) => char.charCodeAt(0),
);

const STAGED_FILES = [
  {
    path: "package.json",
    size: 78,
    sha256: "41d2a9497673c9a29dd457ef6197558badef9c3ee54d5acfcd7a91904ff0f9d7",
    flags: [],
  },
  {
    path: "install.js",
    size: 23,
    sha256: "4041a4f48b2052fff1bb917f6cc8e22ca86e361d5a20134514415146958a05fb",
    flags: [],
  },
];

function stubLoader(): WorkerLoader {
  return {
    load: () => ({
      getEntrypoint: () => ({
        fetch: async () =>
          Response.json({
            files: STAGED_FILES,
            packageJson: { name: "@org/pkg", version: "1.1.0" },
          }),
      }),
    }),
  } as unknown as WorkerLoader;
}

function stubDetonationBinding(handler: (archive: Uint8Array) => Response): DetonationBindingStub {
  const state = { archives: [] as Uint8Array[], destroyed: 0, names: [] as string[] };
  const stub = {
    async fetch(_url: string | Request, init?: RequestInit) {
      const archive = new Uint8Array(await new Response(init?.body).arrayBuffer());
      state.archives.push(archive);
      return handler(archive);
    },
    async destroy() {
      state.destroyed += 1;
    },
  };
  return {
    binding: {
      idFromName: (name: string) => {
        state.names.push(name);
        return {};
      },
      get: () => stub,
    } as unknown as DurableObjectNamespace,
    state,
  };
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
  overrides: { DETONATION?: DurableObjectNamespace; FLAGS?: Flagship; LOADER?: WorkerLoader } = {},
) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("authSession", { userId: session.userId });
    // Layer the per-test bindings over the base test env.
    c.env = { ...env, LOADER: stubLoader(), ...overrides } as Bindings;
    await next();
  });
  app.route("/api/v1/scans", scansRoutes);
  return app;
}

async function post(
  app: ReturnType<typeof buildTestApp>,
  path: string,
  archive: Uint8Array = STAGED_ARCHIVE,
) {
  const ctx = createExecutionContext() as ExecutionContext & {
    exports: { NpmStageGateway(options: { props: unknown }): Fetcher };
  };
  ctx.exports = {
    NpmStageGateway: () =>
      ({
        fetch: async () =>
          new Response(archive as BodyInit, {
            headers: { "content-type": "application/octet-stream" },
          }),
      }) as Fetcher,
  };
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

async function seedCompletedScan(
  owner: SeededUser,
  options: { source?: "manual" | "workflow_gate"; packageSha256?: string } = {},
): Promise<string> {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${scanId.slice(-12)}`;
  await createScanJob(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    source: options.source,
  });
  await persistScan(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    packageJson: { name: "@org/pkg", version: "1.1.0" },
    risk: "low",
    status: "complete",
    summary: {
      report: { version: 1, digest: "abc", digestAlgorithm: "sha256" },
      stagedPublish: { shasum: "a8ebee65b96f6617f94d57932617cf806e16554e" },
    },
    ai: null,
    files: [
      {
        path: "package.json",
        size: 78,
        sha256:
          options.packageSha256 ||
          "41d2a9497673c9a29dd457ef6197558badef9c3ee54d5acfcd7a91904ff0f9d7",
        flags: [],
        textSample:
          '{"name":"@org/pkg","version":"1.1.0","scripts":{"install":"node install.js"}}\n',
      },
      {
        path: "install.js",
        size: 23,
        sha256: "4041a4f48b2052fff1bb917f6cc8e22ca86e361d5a20134514415146958a05fb",
        flags: [],
        textSample: 'console.log("install")\n',
      },
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
    const binding = stubDetonationBinding(() => {
      return new Response(JSON.stringify(CRITICAL_REPORT), {
        headers: { "content-type": "application/json" },
      });
    });
    const app = buildTestApp(owner, { DETONATION: binding.binding, FLAGS: flag(true) });

    const res = await post(app, `/api/v1/scans/${scanId}/detonate`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      detonation: { verdict: string; advisory: boolean; findings: Array<{ source: string }> };
    };
    expect(body.detonation.verdict).toBe("critical");
    expect(body.detonation.advisory).toBe(true);
    expect(body.detonation.findings[0].source).toBe("detonation");

    expect(binding.state.archives).toEqual([STAGED_ARCHIVE]);
    expect(binding.state.destroyed).toBe(1);
    expect(binding.state.names).toHaveLength(1);
    expect(binding.state.names[0]).toMatch(/^detonation-/);
  });

  test("is 403 when the flag is off", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const app = buildTestApp(owner, {
      DETONATION: stubDetonationBinding(() => new Response("{}")).binding,
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
    const app = buildTestApp(owner, { DETONATION: binding.binding, FLAGS: flag(true) });
    expect((await post(app, `/api/v1/scans/${scanId}/detonate`)).status).toBe(502);
    expect(binding.state.destroyed).toBe(1);
  });

  test("a container transport error is 502, not a crash", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const binding = stubDetonationBinding(() => {
      throw new Error("container down");
    });
    const app = buildTestApp(owner, { DETONATION: binding.binding, FLAGS: flag(true) });
    expect((await post(app, `/api/v1/scans/${scanId}/detonate`)).status).toBe(502);
    expect(binding.state.destroyed).toBe(1);
  });

  test("rejects reacquired bytes that do not match the completed scan", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner, { packageSha256: "0".repeat(64) });
    const binding = stubDetonationBinding(() => new Response(JSON.stringify(CRITICAL_REPORT)));
    const app = buildTestApp(owner, { DETONATION: binding.binding, FLAGS: flag(true) });

    expect((await post(app, `/api/v1/scans/${scanId}/detonate`)).status).toBe(409);
    expect(binding.state.archives).toHaveLength(0);
  });

  test("rejects scan sources without an exact reacquisition path", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner, { source: "workflow_gate" });
    const binding = stubDetonationBinding(() => new Response(JSON.stringify(CRITICAL_REPORT)));
    const app = buildTestApp(owner, { DETONATION: binding.binding, FLAGS: flag(true) });

    expect((await post(app, `/api/v1/scans/${scanId}/detonate`)).status).toBe(422);
    expect(binding.state.archives).toHaveLength(0);
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

  test("detonationArtifactMatches requires a complete matching hash manifest", () => {
    const hash = "a".repeat(64);
    expect(
      detonationArtifactMatches(
        [{ path: "package.json", size: 2, sha256: hash }],
        [{ path: "package.json", size: 2, sha256: hash }],
      ),
    ).toBe(true);
    expect(
      detonationArtifactMatches(
        [{ path: "package.json", size: 2, sha256: null }],
        [{ path: "package.json", size: 2, sha256: null }],
      ),
    ).toBe(false);
    expect(
      detonationArtifactMatches(
        [{ path: "package.json", size: 2, sha256: hash }],
        [{ path: "package.json", size: 3, sha256: hash }],
      ),
    ).toBe(false);
  });

  test("detonationArchiveMatches binds execution to the persisted npm shasum", async () => {
    await expect(
      detonationArchiveMatches("a8ebee65b96f6617f94d57932617cf806e16554e", STAGED_ARCHIVE),
    ).resolves.toBe(true);
    await expect(detonationArchiveMatches("0".repeat(40), STAGED_ARCHIVE)).resolves.toBe(false);
    await expect(detonationArchiveMatches(null, STAGED_ARCHIVE)).resolves.toBe(false);
  });
});
